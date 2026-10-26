// =========================================================================
// 4. REAL-TIME OSCILLOSCOPE & 24-BIT UNCOMPRESSED PCM WAV RECORDER
// =========================================================================

function drawOscilloscope() {
  const canvas = document.getElementById('scope');
  const ctx = canvas.getContext('2d');
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function renderFrame() {
    requestAnimationFrame(renderFrame);
    analyser.getByteTimeDomainData(dataArray);

    ctx.fillStyle = '#141916';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.lineWidth = 2;
    ctx.strokeStyle = '#63e6a2';
    ctx.beginPath();

    const sliceWidth = canvas.width / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0;
      const y = (v * canvas.height) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
  }
  renderFrame();
}

// -------------------------------------------------------------------------
// CUSTOM 24-BIT STEREO PCM WAV ENCODER
// -------------------------------------------------------------------------
function encodeWAV24Bit(leftChunks, rightChunks, sampleRate) {
  const numChannels = 2;
  const bytesPerSample = 3; // 24-bit = 3 bytes per sample
  const blockAlign = numChannels * bytesPerSample; // 6 bytes per stereo frame
  const byteRate = sampleRate * blockAlign;

  // Count total frames across all recorded chunks
  let totalFrames = 0;
  for (let i = 0; i < leftChunks.length; i++) {
    totalFrames += leftChunks[i].length;
  }

  const dataByteLength = totalFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  // Helper to write ASCII strings into the header
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // 1. RIFF Header (12 bytes)
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true); // File size minus 8 bytes
  writeString(8, 'WAVE');

  // 2. "fmt " Sub-chunk (24 bytes)
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);             // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true);              // AudioFormat (1 = Linear PCM)
  view.setUint16(22, numChannels, true);    // NumChannels (2 = Stereo)
  view.setUint32(24, sampleRate, true);     // SampleRate (e.g., 48000 Hz)
  view.setUint32(28, byteRate, true);       // ByteRate (SampleRate * 6)
  view.setUint16(32, blockAlign, true);     // BlockAlign (6 bytes)
  view.setUint16(34, 24, true);             // BitsPerSample (24-bit)

  // 3. "data" Sub-chunk Header (8 bytes)
  writeString(36, 'data');
  view.setUint32(40, dataByteLength, true); // Raw PCM byte length

  // 4. Interleave Left & Right Float32 channels and pack as 24-bit Little-Endian
  let offset = 44;
  const MAX_INT24 = 8388607; // 2^23 - 1

  for (let c = 0; c < leftChunks.length; c++) {
    const left = leftChunks[c];
    const right = rightChunks[c];

    for (let i = 0; i < left.length; i++) {
      // Clamp between -1.0 and +1.0 to avoid digital wrap-around distortion
      const sL = Math.max(-1, Math.min(1, left[i]));
      const sR = Math.max(-1, Math.min(1, right[i]));

      // Convert Float32 to signed 24-bit integer
      const intL = sL < 0 ? Math.round(sL * 8388608) : Math.round(sL * MAX_INT24);
      const intR = sR < 0 ? Math.round(sR * 8388608) : Math.round(sR * MAX_INT24);

      // Write Left Channel (3 bytes, Little-Endian)
      view.setUint8(offset, intL & 0xff);
      view.setUint8(offset + 1, (intL >> 8) & 0xff);
      view.setUint8(offset + 2, (intL >> 16) & 0xff);

      // Write Right Channel (3 bytes, Little-Endian)
      view.setUint8(offset + 3, intR & 0xff);
      view.setUint8(offset + 4, (intR >> 8) & 0xff);
      view.setUint8(offset + 5, (intR >> 16) & 0xff);

      offset += 6;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

// -------------------------------------------------------------------------
// INLINE AUDIOWORKLET RECORDER (CAPTURES RAW 32-BIT FLOAT SAMPLES)
// -------------------------------------------------------------------------
let workletRegistered = false;

async function createPCMRecorder(sourceNode) {
  if (!workletRegistered) {
    const workletCode = `
      class PCMRecorderProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.isRecording = true;
          this.port.onmessage = (e) => {
            if (e.data === 'STOP') this.isRecording = false;
          };
        }
        process(inputs) {
          if (!this.isRecording) return false;
          const input = inputs[0];
          if (input && input.length > 0) {
            const left = input[0] ? new Float32Array(input[0]) : new Float32Array(128);
            const right = input[1] ? new Float32Array(input[1]) : new Float32Array(left);
            this.port.postMessage({ left, right }, [left.buffer, right.buffer]);
          }
          return true;
        }
      }
      registerProcessor('pcm-recorder-processor', PCMRecorderProcessor);
    `;
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    await audioCtx.audioWorklet.addModule(URL.createObjectURL(blob));
    workletRegistered = true;
  }

  const leftChunks = [];
  const rightChunks = [];
  const recorderNode = new AudioWorkletNode(audioCtx, 'pcm-recorder-processor');

  recorderNode.port.onmessage = (e) => {
    leftChunks.push(e.data.left);
    rightChunks.push(e.data.right);
  };

  sourceNode.connect(recorderNode);

  return {
    stop: () => {
      recorderNode.port.postMessage('STOP');
      sourceNode.disconnect(recorderNode);
      recorderNode.disconnect();
      return encodeWAV24Bit(leftChunks, rightChunks, audioCtx.sampleRate);
    }
  };
}

// -------------------------------------------------------------------------
// UI HANDLERS FOR SAVING 24-BIT MASTER TAKES
// -------------------------------------------------------------------------
let takeNumber = 1;

function addTakeToList(blob, label) {
  const url = URL.createObjectURL(blob);
  const sizeMB = (blob.size / (1024 * 1024)).toFixed(2);
  const list = document.getElementById('takesList');
  if (takeNumber === 1) list.innerHTML = '';

  const currentTake = takeNumber++;
  const item = document.createElement('div');
  item.className = 'take-item';
  item.innerHTML = `
    <div>
      <div>TAPE #0${currentTake} — ${label}</div>
      <div style="font-size:0.68rem; color:#63e6a2;">24-BIT / ${audioCtx.sampleRate / 1000}kHz WAV (${sizeMB} MB)</div>
    </div>
    <audio controls src="${url}"></audio>
    <a href="${url}" download="TapeDeck-Master-0${currentTake}-24bit.wav" class="hw-btn" style="text-decoration:none;padding:6px 12px;">⬇ 24-BIT WAV</a>
  `;
  list.prepend(item);
}

// 1. Bounce Internal Studio Mix to 24-Bit WAV
let studioMixRecorder = null;
const recSynthBtn = document.getElementById('recSynthBtn');

recSynthBtn.addEventListener('click', async () => {
  initAudio();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  if (!studioMixRecorder) {
    studioMixRecorder = await createPCMRecorder(masterGain);
    recSynthBtn.classList.add('active');
    recSynthBtn.textContent = '■ STOP & EXPORT 24-BIT WAV';
    document.getElementById('recStatus').textContent = 'REC 24-BIT/48kHz...';
  } else {
    const wavBlob = studioMixRecorder.stop();
    studioMixRecorder = null;
    addTakeToList(wavBlob, 'STUDIO MIX');
    recSynthBtn.classList.remove('active');
    recSynthBtn.textContent = '● BOUNCE STUDIO MIX';
    document.getElementById('recStatus').textContent = '24-BIT WAV READY';
  }
});

// 2. Record Live Vocal / Guitar Mic to 24-Bit WAV
let liveMicRecorder = null;
let activeMicStream = null;
const recMicBtn = document.getElementById('recMicBtn');

recMicBtn.addEventListener('click', async () => {
  initAudio();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  if (!liveMicRecorder) {
    try {
      activeMicStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 2
        }
      });
      const micSource = audioCtx.createMediaStreamSource(activeMicStream);
      liveMicRecorder = await createPCMRecorder(micSource);

      recMicBtn.classList.add('active');
      recMicBtn.textContent = '■ STOP MIC TAKE (24-BIT)';
      document.getElementById('recStatus').textContent = 'MIC 24-BIT ON AIR';
    } catch (err) {
      alert('Microphone permission is required to record vocals or guitar.');
    }
  } else {
    const wavBlob = liveMicRecorder.stop();
    liveMicRecorder = null;
    if (activeMicStream) {
      activeMicStream.getTracks().forEach(t => t.stop());
      activeMicStream = null;
    }
    addTakeToList(wavBlob, 'LIVE MIC');
    recMicBtn.classList.remove('active');
    recMicBtn.textContent = '🎙 RECORD LIVE MIC / GUITAR';
    document.getElementById('recStatus').textContent = 'MIC WAV SAVED';
  }
});