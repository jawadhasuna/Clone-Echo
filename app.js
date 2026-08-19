// ============================================================
// Atom Voice — Turn-Based Cloned-Voice Chat
// ============================================================

// Speech recognition transcribes based on the SPOKEN language, not
// romanization — set this to match what you actually say out loud.
// Examples: "en-US", "hi-IN" (Hindi), "ur-PK" (Urdu).
const SEND_SAMPLE_RATE = 16000;   // what Gemini wants, and small to upload
const SILENCE_MS = 1500;          // quiet for this long ends the turn
const SPEECH_LEVEL = 0.045;       // RMS above this counts as speech
const MAX_TURN_MS = 20000;        // hard stop so a stuck mic cannot hang

// ---- DOM references ----
const orb = document.getElementById("orb");
const statusEl = document.getElementById("status");
const errorBanner = document.getElementById("errorBanner");
const orbInner = document.querySelector(".orb-inner");

// ---- State ----
let turnState = "idle"; // "idle" | "listening" | "thinking" | "talking"
let micStream = null;
let micContext = null;
let micSourceNode = null;
let micProcessorNode = null;
let micAnalyser = null;
let recordedChunks = [];
let recordedSampleRate = 16000;
let silenceTimer = null;
let maxTurnTimer = null;
let sawSpeech = false;
let playbackContext = null;
let playbackAnalyser = null;
let activeSource = null;

let reactivityFrame = null;
let currentOrbMode = "idle"; // mirrors turnState for the animation loop

// ============================================================
// UI helpers
// ============================================================
function setStatus(text, live = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("live", live);
}

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.classList.add("visible");
}

function clearError() {
  errorBanner.textContent = "";
  errorBanner.classList.remove("visible");
}

function setOrbState(state) {
  // state: "idle" | "connecting" (thinking) | "listening" | "talking"
  currentOrbMode = state;
  orb.classList.remove("listening", "talking", "connecting");
  if (state !== "idle") orb.classList.add(state);
}

// ============================================================
// Real-time reactive animation: scales/glows the orb based on
// actual audio volume (your voice while listening, the reply's
// voice while talking) instead of a generic canned pulse.
// ============================================================
function getVolumeLevel(analyser) {
  if (!analyser) return 0;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(data);
  let sumSquares = 0;
  for (let i = 0; i < data.length; i++) {
    const normalized = (data[i] - 128) / 128;
    sumSquares += normalized * normalized;
  }
  const rms = Math.sqrt(sumSquares / data.length);
  return Math.min(1, rms * 4); // amplify quiet signals so motion reads clearly
}

function reactivityLoop() {
  let level = 0;
  if (currentOrbMode === "talking") {
    level = getVolumeLevel(playbackAnalyser);
  } else if (currentOrbMode === "listening") {
    // No real audio level available here (Web Speech API keeps its own
    // mic capture private — reading it ourselves means a second, competing
    // mic stream, which is what broke recognition on mobile). This is a
    // simulated breathing pulse instead: alive-looking, but not tied to
    // your actual voice.
    level = 0.35 + 0.25 * Math.sin(performance.now() / 450);
  }
  const prev = parseFloat(orb.style.getPropertyValue("--level")) || 0;
  const smoothed = prev + (level - prev) * 0.35;
  orb.style.setProperty("--level", smoothed.toFixed(3));

  if (orbInner) {
    // Do NOT touch animation-duration here. Changing it on a running
    // animation makes the browser re-derive the current position from the
    // elapsed time, so the gradient jumps. Once per frame that reads as a
    // flicker. Blur is a plain filter and can safely track the level.
    const blurAmount = 16 - smoothed * 6;
    orbInner.style.filter = `blur(${blurAmount.toFixed(1)}px) saturate(1.4) contrast(1.25)`;
  }

  reactivityFrame = requestAnimationFrame(reactivityLoop);
}

function startReactivityLoop() {
  if (!reactivityFrame) reactivityLoop();
}

// Run continuously from page load so the liquid noise drifts gently
// even before any call starts, not just while active.
startReactivityLoop();

// ============================================================
// Playback of the cloned-voice reply
// ============================================================
function ensurePlaybackContext() {
  if (!playbackContext) {
    playbackContext = new (window.AudioContext || window.webkitAudioContext)();
    playbackAnalyser = playbackContext.createAnalyser();
    playbackAnalyser.fftSize = 256;
    playbackAnalyser.connect(playbackContext.destination);
  }
  if (playbackContext.state === "suspended") playbackContext.resume();
}

function playReplyAudio(arrayBuffer) {
  return new Promise((resolve, reject) => {
    ensurePlaybackContext();
    playbackContext.decodeAudioData(
      arrayBuffer,
      (audioBuffer) => {
        const source = playbackContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(playbackAnalyser);
        activeSource = source;
        setOrbState("talking");
        setStatus("speaking", true);
        source.onended = () => {
          activeSource = null;
          resolve();
        };
        source.start();
      },
      (err) => reject(err)
    );
  });
}

function stopPlayback() {
  if (activeSource) {
    try {
      activeSource.stop();
    } catch (e) {
      /* already stopped */
    }
    activeSource = null;
  }
}

// ============================================================
// Backend calls
// ============================================================
/** Takes { audio, mimeType } now - Gemini transcribes and replies in one call. */
async function getGeminiReply(payload) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Chat request failed (${response.status})`);
  }
  const data = await response.json();
  return data.reply;
}

async function getClonedSpeech(text) {
  const response = await fetch("/api/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Speech request failed (${response.status})`);
  }
  return response.arrayBuffer();
}

// ============================================================
// Microphone capture
// ------------------------------------------------------------
// Deliberately NOT the Web Speech API. On iOS that routes through Apple's
// dictation service, which refuses with service-not-allowed unless Dictation
// is enabled at the OS level - the microphone itself is fine. Capturing raw
// audio and letting Gemini transcribe it removes that dependency entirely,
// the same way Atom-Voice does.
// ============================================================

function downsample(buffer, from, to) {
  if (to === from) return buffer;
  const ratio = from / to;
  const out = new Float32Array(Math.round(buffer.length / ratio));
  let o = 0, i = 0;
  while (o < out.length) {
    const next = Math.round((o + 1) * ratio);
    let sum = 0, n = 0;
    for (; i < next && i < buffer.length; i++) { sum += buffer[i]; n++; }
    out[o++] = n ? sum / n : 0;
  }
  return out;
}

/** Float samples -> a complete 16-bit PCM WAV file. */
function encodeWav(chunks, sampleRate) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const str = (off, t) => { for (let i = 0; i < t.length; i++) view.setUint8(off + i, t.charCodeAt(i)); };

  str(0, "RIFF");
  view.setUint32(4, 36 + total * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, 1, true);            // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, total * 2, true);

  let off = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, off += 2) {
      const v = Math.max(-1, Math.min(1, c[i]));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
  }
  return buffer;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function startRecording() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  micContext = new (window.AudioContext || window.webkitAudioContext)();
  if (micContext.state === "suspended") await micContext.resume();

  recordedChunks = [];
  recordedSampleRate = SEND_SAMPLE_RATE;
  sawSpeech = false;

  micSourceNode = micContext.createMediaStreamSource(micStream);
  micAnalyser = micContext.createAnalyser();
  micAnalyser.fftSize = 256;
  micSourceNode.connect(micAnalyser);

  micProcessorNode = micContext.createScriptProcessor(4096, 1, 1);
  micProcessorNode.onaudioprocess = (e) => {
    if (turnState !== "listening") return;
    const input = e.inputBuffer.getChannelData(0);
    recordedChunks.push(downsample(new Float32Array(input), micContext.sampleRate, SEND_SAMPLE_RATE));

    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);

    if (rms > SPEECH_LEVEL) {
      sawSpeech = true;
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    } else if (sawSpeech && !silenceTimer) {
      silenceTimer = setTimeout(() => finishRecording(), SILENCE_MS);
    }
  };

  micSourceNode.connect(micProcessorNode);
  // ScriptProcessorNode only fires while connected to a destination, but the
  // raw mic must never be audible - route it through a zero-gain node.
  const mute = micContext.createGain();
  mute.gain.value = 0;
  micProcessorNode.connect(mute);
  mute.connect(micContext.destination);
}

function stopRecording() {
  if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
  if (micProcessorNode) { micProcessorNode.onaudioprocess = null; micProcessorNode.disconnect(); }
  if (micSourceNode) micSourceNode.disconnect();
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (micContext) micContext.close();
  micProcessorNode = micSourceNode = micStream = micContext = micAnalyser = null;
}

// ============================================================
// Turn flow
// ============================================================
async function startTurn() {
  if (turnState !== "idle") return;

  try {
    clearError();
    turnState = "listening";
    setOrbState("listening");
    setStatus("listening", true);

    // Start inside the tap's gesture so iOS does not suspend the playback
    // context we need a moment later.
    ensurePlaybackContext();
    await startRecording();

    // Safety net: never let a stuck mic hold the turn open forever.
    maxTurnTimer = setTimeout(() => {
      if (turnState === "listening") finishRecording();
    }, MAX_TURN_MS);
  } catch (err) {
    console.error(err);
    showError(
      err && err.name === "NotAllowedError"
        ? "Microphone blocked. Tap AA in the address bar > Website Settings > Microphone > Allow."
        : "Couldn't start the microphone. Try again."
    );
    stopRecording();
    resetToIdle();
  }
}

/** Called by the silence detector, the timeout, or a second tap. */
async function finishRecording() {
  if (turnState !== "listening") return;

  if (maxTurnTimer) { clearTimeout(maxTurnTimer); maxTurnTimer = null; }
  const chunks = recordedChunks;
  const heardSomething = sawSpeech;
  stopRecording();

  if (!heardSomething || !chunks.length) {
    showError("Didn't catch any speech — tap the heart and try again.");
    resetToIdle();
    return;
  }

  try {
    turnState = "thinking";
    setOrbState("connecting");
    setStatus("thinking", true);

    const wav = encodeWav(chunks, recordedSampleRate);
    const reply = await getGeminiReply({
      audio: arrayBufferToBase64(wav),
      mimeType: "audio/wav",
    });

    setStatus("generating", true);
    const audioBuffer = await getClonedSpeech(reply);

    turnState = "talking";
    await playReplyAudio(audioBuffer);

    resetToIdle();
  } catch (err) {
    console.error(err);
    showError(err.message || "Something went wrong. Tap the heart to try again.");
    resetToIdle();
  }
}

function resetToIdle() {
  turnState = "idle";
  setOrbState("idle");
  setStatus("offline");
}

function cancelTurn() {
  if (maxTurnTimer) { clearTimeout(maxTurnTimer); maxTurnTimer = null; }
  stopRecording();
  stopPlayback();
  clearError();
  resetToIdle();
}

// ============================================================
// Controls
// ============================================================
// The heart is now the only control: click to start, click again to cancel.
// Removing the stop button without this would leave a turn with no way out.
orb.addEventListener("click", () => {
  if (turnState === "idle") startTurn();
  else if (turnState === "listening") finishRecording();  // tap to send early
  else cancelTurn();
});
