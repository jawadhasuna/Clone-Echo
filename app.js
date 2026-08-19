// ============================================================
// Atom Voice — Turn-Based Cloned-Voice Chat
// ============================================================

// Speech recognition transcribes based on the SPOKEN language, not
// romanization — set this to match what you actually say out loud.
// Examples: "en-US", "hi-IN" (Hindi), "ur-PK" (Urdu).
const RECOGNITION_LANG = "en-US";

// ---- DOM references ----
const orb = document.getElementById("orb");
const statusEl = document.getElementById("status");
const errorBanner = document.getElementById("errorBanner");
const orbInner = document.querySelector(".orb-inner");

// ---- State ----
let turnState = "idle"; // "idle" | "listening" | "thinking" | "talking"
let recognition = null;
let playbackContext = null;
let playbackAnalyser = null;
let activeSource = null;

let reactivityFrame = null;
let currentOrbMode = "idle"; // mirrors turnState for the animation loop

// iOS home-screen web apps run in their own WebKit instance, separate from
// Safari, and speech recognition is commonly denied there outright. Detect it
// so the error can say something the user can actually act on.
const isStandalone =
  window.navigator.standalone === true ||
  window.matchMedia("(display-mode: standalone)").matches;

const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

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
async function getGeminiReply(message) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
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
// Speech recognition (mic -> text)
// ============================================================
function createRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;

  const rec = new SpeechRecognition();
  rec.lang = RECOGNITION_LANG;
  rec.continuous = false;
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  return rec;
}

// ============================================================
// Turn flow
// ============================================================
async function startTurn() {
  if (turnState !== "idle") return;

  recognition = createRecognition();
  if (!recognition) {
    showError("Your browser doesn't support speech recognition. Try Chrome or Edge.");
    return;
  }

  try {
    clearError();
    turnState = "listening";
    setOrbState("listening");
    setStatus("listening", true);

    // Start inside the tap's gesture so iOS/Safari don't suspend the
    // playback context we'll need a moment later.
    ensurePlaybackContext();
  } catch (err) {
    console.error(err);
    showError("Something went wrong starting the call. Try again.");
    resetToIdle();
    return;
  }

  recognition.onresult = async (event) => {
    const transcript = event.results[0][0].transcript.trim();

    if (!transcript) {
      resetToIdle();
      return;
    }

    try {
      turnState = "thinking";
      setOrbState("connecting");
      setStatus("thinking", true);

      const reply = await getGeminiReply(transcript);

      setStatus("generating", true);
      const audioBuffer = await getClonedSpeech(reply);

      turnState = "talking";
      await playReplyAudio(audioBuffer);

      resetToIdle();
    } catch (err) {
      console.error(err);
      showError(err.message || "Something went wrong. Tap the circle to try again.");
      resetToIdle();
    }
  };

  recognition.onerror = (event) => {
    console.error("Speech recognition error:", event.error);
    if (event.error === "no-speech") {
      showError("Didn't catch that — tap the circle and try again.");
    } else if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      showError(
        isStandalone && isIOS
          ? "The mic doesn't work when this is opened from the home screen. Remove the icon, open clonesecho.vercel.app in Safari, and add it again."
          : "Microphone access was blocked. Check browser permissions and try again."
      );
    } else if (event.error === "network") {
      showError("Speech recognition needs a network connection — check your connection and try again.");
    } else {
      showError(`Speech recognition error: ${event.error}`);
    }
    resetToIdle();
  };

  recognition.onend = () => {
    // If recognition ended without ever firing onresult AND without
    // onerror (this can happen silently on some mobile browsers), make
    // sure we don't get stuck in "listening" — and actually tell the
    // person something happened instead of quietly resetting.
    if (turnState === "listening") {
      showError("Didn't catch any speech — tap the circle and try again.");
      resetToIdle();
    }
  };

  recognition.start();
}

function resetToIdle() {
  turnState = "idle";
  setOrbState("idle");
  setStatus("offline");
}

function cancelTurn() {
  if (recognition) {
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.abort();
    } catch (e) {
      /* already stopped */
    }
    recognition = null;
  }
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
  else cancelTurn();
});
