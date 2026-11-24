import { createGMPlugin } from './vendor/gm-plugin-web-sdk.esm.js';
import { encodeStart, encodeStop, encodeAudioMeta, decodeDownstream } from './audio-protocol.js';
import { createTypewriter, scrollBy } from './teleprompter.js';
import { computeHud, formatClock } from './hud-layout.js';
import { speechChunks } from './speech.js';
import { createMeasurer, createPresenter, paintPreview, renderHudFrame } from './hud-renderer.js';

const gm = createGMPlugin();

const DEFAULT_BACKEND_URL = 'ws://127.0.0.1:8800';
const STORAGE_KEY_BACKEND_URL = 'backendUrl';
const INACTIVITY_TIMEOUT_MS = 30000;
const WS_OPEN_TIMEOUT_MS = 8000;
const RECONNECT_DELAY_MS = 1500;
// The glasses-side bridge plugin can still be starting when the page loads
// ("device plugin is not ready for this runtime generation"), so creating
// the display page is retried with backoff instead of failing startup.
const PAGE_RETRY_MIN_MS = 1000;
const PAGE_RETRY_MAX_MS = 15000;
// After stop, how long the backend may go silent before the turn is given
// up. Re-armed on every backend message, so a slow turn that is still
// reporting progress is not cut off.
const PROCESSING_TIMEOUT_MS = 35000;
// Assistant-route replies can take minutes. Once the backend reports
// "waiting", wait this long for the late reply: just past the bridge's
// 600 s expiry, which always sends a final "didn't respond in time" reply first.
const ASSISTANT_WAIT_TIMEOUT_MS = 11 * 60 * 1000;

// Glasses display: one full-screen 600x350 GRAY_4 bitmap drawn on a canvas
// (hud-layout.js / hud-renderer.js). We draw the pixels ourselves, so text
// wraps exactly as measured instead of guessing at the firmware's font.
// Typing pace for replies: a little faster than reading speed, so the text
// can be followed as it scrolls.
const REPLY_CHARS_PER_SECOND = 30;
// Head raise/lower scrolls the reply by this many lines (a third of the box,
// so some context stays on screen). Repeats of the same gesture within the
// debounce window are ignored, in case the Host reports one motion twice.
const SCROLL_STEP_LINES = 3;
const GESTURE_DEBOUNCE_MS = 250;

const STATUS_FOR_BACKEND_STATE = {
  listening: 'LISTENING',
  transcribing: 'TRANSCRIBING…',
  thinking: 'THINKING…',
  waiting: 'WAITING FOR REPLY…',
};

const el = (id) => document.getElementById(id);
const ui = {
  runtimeStatus: el('runtime-status'),
  stateBadge: el('state-badge'),
  toggle: el('toggle-listen'),
  previewCanvas: el('preview-canvas'),
  audioTest: el('audio-test'),
  speakToggle: el('speak-replies'),
  speakNote: el('speak-note'),
  backendUrl: el('backend-url'),
  saveUrl: el('save-url'),
  settingsNote: el('settings-note'),
  eventLog: el('event-log'),
  clearLog: el('clear-log'),
};

/** idle | connecting | listening | processing | error | unavailable */
let state = 'unavailable';
let audioAvailable = false;
let backendUrl = DEFAULT_BACKEND_URL;
let socket;
let captureSession;
let captureGeneration = 0;
let inactivityTimer;
let processingTimer;
let waitingForReply = false;
let reconnectAttempted = false;
let displayAvailable = false;
let devicePageReady = false;
let pageRetryTimer;
let pageRetryMs = PAGE_RETRY_MIN_MS;
let lastStartOptions;
const view = { status: '', transcript: '', reply: '' };

// One conversation per plugin load: the backend keeps memory across turns
// (each turn is its own WebSocket). A reload starts a fresh conversation.
const conversationId = createConversationId();

function createConversationId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function logEvent(kind, data = {}) {
  const item = document.createElement('li');
  const time = document.createElement('span');
  const label = document.createElement('strong');
  const detail = document.createElement('span');
  time.textContent = new Date().toLocaleTimeString([], { hour12: false });
  label.textContent = kind;
  detail.textContent = typeof data === 'string' ? data : JSON.stringify(data);
  item.append(time, label, detail);
  ui.eventLog.prepend(item);
  while (ui.eventLog.children.length > 100) ui.eventLog.lastElementChild.remove();
}

const measureAt = createMeasurer();
const presenter = createPresenter(gm);

function setState(next) {
  state = next;
  ui.stateBadge.dataset.state = next;
  ui.stateBadge.textContent = {
    idle: 'Idle',
    connecting: 'Connecting',
    listening: 'Listening',
    processing: 'Processing',
    error: 'Error',
    unavailable: 'Unavailable',
  }[next] ?? next;
  ui.toggle.textContent = state === 'listening' || state === 'connecting' ? 'Stop listening' : 'Start listening';
  ui.toggle.disabled = state === 'unavailable' || state === 'processing';
}

// The reply types onto the glasses at a steady pace and scrolls to keep the
// newest lines in view; the phone preview always shows the full text.
const typewriter = createTypewriter({
  charsPerSecond: REPLY_CHARS_PER_SECOND,
  onChange: () => void renderDevice(),
});

// First visible reply line while the user has scrolled with head motion, or
// null to follow the typing (newest lines). Every new turn starts at null.
let replyScrollTop = null;
let lastGesture = { name: '', at: 0 };

function currentHud() {
  return computeHud({
    status: view.status,
    state,
    transcript: view.transcript,
    reply: { text: typewriter.target, revealed: typewriter.revealed, scrollTop: replyScrollTop },
    clock: formatClock(new Date()),
    measureAt,
  });
}

function replyLayout() {
  return currentHud().reply?.window ?? { first: 0, maxFirst: 0 };
}

/** Head raised -> scroll up (earlier text); lowered -> down (rejoins live typing at the bottom). */
function handleGesture(event) {
  if (!event?.active) return;
  const direction = { headRaise: -1, headLower: 1 }[event.gesture];
  if (!direction) return;
  const now = Date.now();
  if (lastGesture.name === event.gesture && now - lastGesture.at < GESTURE_DEBOUNCE_MS) return;
  lastGesture = { name: event.gesture, at: now };

  const before = replyLayout();
  if (before.maxFirst === 0) return; // reply fits; nothing to scroll
  replyScrollTop = scrollBy(replyScrollTop, direction * SCROLL_STEP_LINES, before);
  logEvent('reply.scroll', { gesture: event.gesture, firstLine: replyLayout().first, following: replyScrollTop === null });
  void renderDevice();
}

// Draws the HUD once, shows those exact bytes in the phone preview, and
// sends the bands that changed to the glasses.
async function drawDevice() {
  const frame = renderHudFrame(currentHud());
  if (ui.previewCanvas) paintPreview(ui.previewCanvas, frame);
  if (!devicePageReady) return;
  try {
    await presenter.present(frame);
  } catch (error) {
    logEvent('display.error', { code: error.code, message: error.message });
    // Lost the device page (disconnect, bridge plugin restarted): rebuild it.
    devicePageReady = false;
    scheduleDevicePage();
  }
}

async function ensureDevicePage() {
  window.clearTimeout(pageRetryTimer);
  if (!displayAvailable || devicePageReady) return;
  try {
    await gm.display.createPage();
    // A fresh page is blank: resend every band.
    presenter.reset();
    devicePageReady = true;
    pageRetryMs = PAGE_RETRY_MIN_MS;
    ui.runtimeStatus.textContent = 'Glasses connected.';
    logEvent('display.ready');
    void renderDevice();
  } catch (error) {
    ui.runtimeStatus.textContent = `Waiting for glasses: ${error.message}`;
    logEvent('display.waiting', { code: error.code, message: error.message, retryInMs: pageRetryMs });
    scheduleDevicePage();
  }
}

function scheduleDevicePage() {
  window.clearTimeout(pageRetryTimer);
  pageRetryTimer = window.setTimeout(() => { void ensureDevicePage(); }, pageRetryMs);
  pageRetryMs = Math.min(pageRetryMs * 2, PAGE_RETRY_MAX_MS);
}

// Each frame is a Bridge round trip and typing changes the reply every
// ~60 ms, so draws are coalesced: at most one in flight, and the newest state
// is drawn once it finishes (slow links get chunkier typing, never a backlog).
let drawInFlight = false;
let drawPending = false;

async function renderDevice() {
  drawPending = true;
  if (drawInFlight) return;
  drawInFlight = true;
  while (drawPending) {
    drawPending = false;
    await drawDevice();
  }
  drawInFlight = false;
}

function updateUi(statusText, transcriptText = '', replyText = '') {
  replyText = replyText.trimEnd();
  view.status = statusText;
  view.transcript = transcriptText;
  view.reply = replyText;
  if (replyText) {
    typewriter.setTarget(replyText);
    // Background timers are throttled; don't make the glasses wait on them.
    if (document.hidden) typewriter.finish();
  } else {
    replyScrollTop = null;
    if (typewriter.target) typewriter.reset();
  }
  void renderDevice();
}

// Redraw just after each minute boundary so the header clock stays current
// (only the header band changes, so this costs one small band).
function scheduleClockTick() {
  const msToNextMinute = 60000 - (Date.now() % 60000) + 250;
  window.setTimeout(() => {
    void renderDevice();
    scheduleClockTick();
  }, msToNextMinute);
}
scheduleClockTick();

function updateView(changes) {
  const next = { ...view, ...changes };
  updateUi(next.status, next.transcript, next.reply);
}

function resetInactivityTimer() {
  window.clearTimeout(inactivityTimer);
  inactivityTimer = window.setTimeout(() => {
    logEvent('session.timeout', { afterMs: INACTIVITY_TIMEOUT_MS });
    void stopListening('timeout');
  }, INACTIVITY_TIMEOUT_MS);
}

function clearInactivityTimer() {
  window.clearTimeout(inactivityTimer);
  inactivityTimer = undefined;
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sock = new WebSocket(url);
    sock.binaryType = 'arraybuffer';
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.close();
      reject(new Error(`Timed out connecting to ${url}`));
    }, WS_OPEN_TIMEOUT_MS);
    sock.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(sock);
    });
    sock.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(new Error(`Could not connect to ${url}`));
    });
  });
}

function wireSocketLifecycle(sock, generation) {
  sock.addEventListener('message', (event) => {
    if (generation !== captureGeneration) return;
    if (typeof event.data !== 'string') return;
    const message = decodeDownstream(event.data);
    if (!message) return;
    if (state === 'listening') resetInactivityTimer();
    if (state === 'processing' && !waitingForReply) armProcessingTimer(PROCESSING_TIMEOUT_MS, 'ERROR: no reply from backend');
    if (message.type === 'transcript') {
      logEvent('backend.transcript', { final: message.final, text: message.text });
      updateView({ transcript: message.text || '(nothing heard)' });
    } else if (message.type === 'reply') {
      if (message.final) logEvent('backend.reply', { text: message.text });
      updateView({ reply: message.text });
      if (message.final) speakReply(message.text);
      if (message.final && state === 'processing') finishProcessing();
    } else if (message.type === 'state') {
      logEvent('backend.state', { value: message.value });
      if (message.value === 'waiting' && state === 'processing') {
        waitingForReply = true;
        armProcessingTimer(ASSISTANT_WAIT_TIMEOUT_MS, "No reply yet - it will show next time");
      }
      const status = STATUS_FOR_BACKEND_STATE[message.value];
      if (status && message.value !== 'listening') updateView({ status });
    } else if (message.type === 'error') {
      logEvent('backend.error', { message: message.message });
      if (state === 'processing') finishProcessing(`ERROR: ${message.message}`);
      else updateView({ status: `ERROR: ${message.message}` });
    }
  });

  sock.addEventListener('close', (event) => {
    if (generation !== captureGeneration) return;
    logEvent('ws.close', { code: event.code, reason: event.reason });
    if (state === 'processing') {
      finishProcessing('ERROR: backend disconnected');
      return;
    }
    if (state !== 'listening' && state !== 'connecting') return;
    void handleSocketDrop(generation);
  });

  sock.addEventListener('error', () => {
    if (generation !== captureGeneration) return;
    logEvent('ws.error', {});
  });
}

async function handleSocketDrop(generation) {
  if (reconnectAttempted) {
    logEvent('ws.reconnect-failed', {});
    await stopListening('ws-disconnected');
    setState('error');
    updateUi('ERROR: backend disconnected', '', '');
    return;
  }
  reconnectAttempted = true;
  logEvent('ws.reconnecting', { afterMs: RECONNECT_DELAY_MS });
  updateUi('RECONNECTING…', '', '');
  await new Promise((resolve) => window.setTimeout(resolve, RECONNECT_DELAY_MS));
  if (generation !== captureGeneration) return;
  try {
    const sock = await openSocket(backendUrl);
    if (generation !== captureGeneration) {
      sock.close();
      return;
    }
    socket = sock;
    wireSocketLifecycle(sock, generation);
    sock.send(encodeStart(lastStartOptions));
    reconnectAttempted = false;
    setState('listening');
    updateView({ status: 'LISTENING' });
    logEvent('ws.reconnected', {});
  } catch (error) {
    logEvent('ws.reconnect-error', { message: error.message });
    await stopListening('ws-disconnected');
    setState('error');
    updateUi(`ERROR: ${friendlyError(error)}`, '', '');
  }
}

async function consumeCapture(session, generation) {
  try {
    for await (const chunk of session.stream) {
      if (generation !== captureGeneration) break;
      if (!socket || socket.readyState !== WebSocket.OPEN) continue;
      socket.send(encodeAudioMeta(chunk));
      socket.send(chunk.data.buffer.slice(chunk.data.byteOffset, chunk.data.byteOffset + chunk.data.byteLength));
      if (chunk.discontinuity) logEvent('audio.discontinuity', { sequence: chunk.sequence });
    }
  } catch (error) {
    if (generation !== captureGeneration) return;
    logEvent('audio.error', { code: error.code, message: error.message });
    // Capture already stopped on purpose; the reply is still on its way.
    if (state === 'processing') return;
    await stopListening('capture-error');
    setState('error');
    updateUi(`ERROR: ${friendlyError(error)}`, '', '');
  }
}

async function startListening() {
  if (!audioAvailable || state === 'listening' || state === 'connecting' || state === 'processing') return;
  stopSpeaking(); // never record the assistant's own spoken reply into the next question
  const generation = ++captureGeneration;
  reconnectAttempted = false;
  setState('connecting');
  updateUi('CONNECTING…', '', '');
  logEvent('session.start', { backendUrl });

  let sock;
  try {
    sock = await openSocket(backendUrl);
  } catch (error) {
    if (generation !== captureGeneration) return;
    logEvent('ws.error', { message: error.message });
    setState('error');
    updateUi(`ERROR: ${friendlyError(error)}`, '', '');
    return;
  }
  if (generation !== captureGeneration) {
    sock.close();
    return;
  }
  socket = sock;
  wireSocketLifecycle(sock, generation);

  try {
    const session = await gm.audio.openCapture({
      profile: 'interactive',
      pickupMode: 'frontFocus',
      noiseReduction: true,
    });
    if (generation !== captureGeneration) {
      await session.stop().catch(() => {});
      sock.close();
      return;
    }
    // Describe the stream the Host actually opened, not our defaults, so the
    // backend configures its decoder correctly.
    const resolved = session.resolvedOptions ?? {};
    lastStartOptions = {
      sampleRate: resolved.sampleRate ?? 16000,
      codec: resolved.codec ?? 'opus',
      channels: resolved.channels ?? 1,
      frameDurationMs: 20,
      conversationId,
    };
    sock.send(encodeStart(lastStartOptions));
    captureSession = session;
    setState('listening');
    updateUi('LISTENING', '', '');
    resetInactivityTimer();
    logEvent('capture.open', { sessionId: session.sessionId, resolved: lastStartOptions });
    void consumeCapture(session, generation);
  } catch (error) {
    logEvent('capture.error', { code: error.code, message: error.message });
    sock.send(encodeStop());
    sock.close();
    socket = undefined;
    setState('error');
    updateUi(`ERROR: ${friendlyError(error)}`, '', '');
  }
}

async function stopListening(reason = 'user') {
  clearInactivityTimer();
  logEvent('session.stop', { reason });
  const session = captureSession;
  captureSession = undefined;

  // A normal stop (button, timeout, or the phone switching away mid-question)
  // ends capture but keeps the socket open:
  // the backend transcribes and replies after it receives "stop".
  const awaitReply = (reason === 'user' || reason === 'timeout' || reason === 'suspended')
    && state === 'listening' && socket?.readyState === WebSocket.OPEN;
  if (awaitReply) {
    setState('processing');
    updateView({ status: 'TRANSCRIBING…' });
    if (session) {
      try {
        await session.stop();
      } catch (error) {
        logEvent('capture.stop-error', { code: error.code, message: error.message });
      }
    }
    try {
      socket?.send(encodeStop());
    } catch { /* close handler reports the drop */ }
    if (state !== 'processing') return; // reply already arrived while capture was stopping
    armProcessingTimer(PROCESSING_TIMEOUT_MS, 'ERROR: no reply from backend');
    return;
  }

  captureGeneration += 1;
  window.clearTimeout(processingTimer);
  if (session) {
    try {
      await session.stop();
    } catch (error) {
      logEvent('capture.stop-error', { code: error.code, message: error.message });
    }
  }
  if (socket) {
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(encodeStop());
    } catch { /* socket already going away */ }
    socket.close();
    socket = undefined;
  }
  if (state !== 'error') {
    setState(audioAvailable ? 'idle' : 'unavailable');
    updateView({ status: audioAvailable ? 'Press button to talk' : 'Microphone unavailable' });
  }
}

function armProcessingTimer(afterMs, timeoutStatus) {
  window.clearTimeout(processingTimer);
  processingTimer = window.setTimeout(() => {
    logEvent('processing.timeout', { afterMs, waitingForReply });
    finishProcessing(timeoutStatus);
  }, afterMs);
}

/** End of a turn after stop: final reply, backend error, drop, or timeout. */
function finishProcessing(errorStatus) {
  if (state !== 'processing') return;
  captureGeneration += 1;
  waitingForReply = false;
  window.clearTimeout(processingTimer);
  const sock = socket;
  socket = undefined;
  try {
    sock?.close();
  } catch { /* already closed */ }
  setState('idle');
  updateView({ status: errorStatus ?? 'Press button to talk' });
}

function toggleListening() {
  if (state === 'listening' || state === 'connecting') void stopListening('user');
  else if (state === 'idle' || state === 'error') void startListening();
  else if (state === 'processing' && waitingForReply) {
    // Stop waiting and start a new turn; the late reply is queued by the
    // backend and shown at the start of a later turn.
    logEvent('assistant.wait-cancelled', {});
    finishProcessing();
    void startListening();
  }
}

ui.toggle.addEventListener('click', toggleListening);
ui.clearLog.addEventListener('click', () => { ui.eventLog.replaceChildren(); });

ui.saveUrl.addEventListener('click', async () => {
  const value = ui.backendUrl.value.trim();
  if (!/^wss?:\/\/.+/.test(value)) {
    ui.settingsNote.textContent = 'Backend URL must start with ws:// or wss://';
    return;
  }
  backendUrl = value;
  await gm.storage.set(STORAGE_KEY_BACKEND_URL, value);
  ui.settingsNote.textContent = `Saved. Will be used on the next "Start listening".`;
  logEvent('settings.saved', { backendUrl });
});

function stopForLifecycle(reason) {
  stopSpeaking();
  if (state === 'listening' || state === 'connecting') void stopListening(reason);
  else if (state === 'processing') finishProcessing();
}

// Hidden is not unloaded: when the phone shows another app or locks, keep
// the turn, the glasses display and spoken replies going for as long as the
// Host keeps this page alive (the SDK's own permission lab stopped pausing
// on hide for the same reason, 0.2.6). If the Host itself stops capture or
// the socket in the background, the normal error paths end the turn. Only
// real unloads clean up here; visibility and Host lifecycle are just logged
// so on-phone tests show what the Host actually does.
document.addEventListener('visibilitychange', () => {
  logEvent('page.visibility', { hidden: document.hidden, state });
});
// The Host refuses every non-runtime Bridge call (display, mic, storage)
// with NOT_FOREGROUND unless the plugin is in the foreground - a Host rule,
// not something the plugin can work around. While suspended, a turn that
// is already waiting on a late reply keeps its WebSocket, and the reply can still be
// spoken (browser speech is not a Bridge call); the glasses are redrawn with
// the latest state as soon as the plugin is back in front.
gm.on('runtime.lifecycleChanged', (event) => {
  logEvent('runtime.lifecycle', { state: event?.state });
  if (event?.state === 'running') {
    devicePageReady = false;
    pageRetryMs = PAGE_RETRY_MIN_MS;
    void ensureDevicePage();
  } else if (event?.state === 'suspended' && (state === 'listening' || state === 'connecting')) {
    void stopListening('suspended');
  }
});

function friendlyError(error) {
  if (error?.message === 'NOT_FOREGROUND' || error?.code === 'NOT_FOREGROUND') {
    return 'open MemoMind on your phone to talk';
  }
  return error?.message ?? String(error);
}
window.addEventListener('pagehide', () => stopForLifecycle('pagehide'));
window.addEventListener('beforeunload', () => stopForLifecycle('beforeunload'), { once: true });

// --- Spoken replies -------------------------------------------------------
// The assistant's final reply is read aloud with the WebView's speech
// synthesis; the phone OS routes it (to the glasses when they are the audio
// output). Long replies are queued sentence by sentence (speech.js). Speech
// is cancelled as soon as a new turn starts so the mic never records its
// own spoken reply.
const STORAGE_KEY_SPEAK_REPLIES = 'speakReplies';
let speakReplies = true;

// The voice is the phone's own text-to-speech default (Android Settings >
// Text-to-speech): MemoMind's WebView ignores per-utterance voice choices.
function utteranceFor(text) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  return utterance;
}

function stopSpeaking() {
  window.speechSynthesis?.cancel();
}

function speakReply(text) {
  const synth = window.speechSynthesis;
  if (!speakReplies || !text.trim()) return;
  if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') {
    logEvent('speech.unavailable');
    return;
  }
  synth.cancel();
  const chunks = speechChunks(text);
  chunks.forEach((chunk, index) => {
    const utterance = utteranceFor(chunk);
    if (index === 0) utterance.onstart = () => logEvent('speech.start', { chunks: chunks.length });
    if (index === chunks.length - 1) utterance.onend = () => logEvent('speech.end');
    utterance.onerror = (event) => {
      if (event.error === 'interrupted' || event.error === 'canceled') return;
      logEvent('speech.error', { error: event.error });
      if (event.error === 'not-allowed') {
        ui.speakNote.textContent = 'The phone blocked speech until you tap the page once: toggle "Speak replies aloud" off and on.';
      }
    };
    synth.speak(utterance);
  });
}

async function setSpeakReplies(value) {
  speakReplies = value;
  ui.speakToggle.checked = value;
  ui.speakNote.textContent = '';
  if (!value) stopSpeaking();
  try {
    await gm.storage.set(STORAGE_KEY_SPEAK_REPLIES, value);
  } catch (error) {
    logEvent('storage.error', { code: error.code, message: error.message });
  }
}

// Toggling is also a tap on the page, which unlocks speech where the
// WebView requires a user gesture before speechSynthesis may talk.
ui.speakToggle?.addEventListener('change', () => {
  void setSpeakReplies(ui.speakToggle.checked);
  if (ui.speakToggle.checked && window.speechSynthesis) {
    window.speechSynthesis.speak(utteranceFor('Spoken replies on.'));
  }
});

// Probe for spoken replies. The Web SDK has no speak/HFP method: the only
// path is ordinary browser audio (audio.playback permission), routed by the
// phone OS - to the glasses only if the OS treats them as the audio output.
// This plays a tone (Web Audio) and a sentence (Web Speech) and logs what
// the WebView supports; where the sound comes out has to be checked by ear.
async function testAudio() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('Web Audio unavailable');
    const audioCtx = new AudioCtx();
    await audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.6);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.6);
    logEvent('audio.tone', { played: true, sampleRate: audioCtx.sampleRate, state: audioCtx.state });
    osc.onended = () => void audioCtx.close();
  } catch (error) {
    logEvent('audio.tone', { played: false, message: error.message });
  }

  const synth = window.speechSynthesis;
  if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') {
    logEvent('audio.speech', { available: false });
    return;
  }
  const voices = synth.getVoices();
  const utterance = utteranceFor('Hello, this is a speech test from the glasses.');
  utterance.onstart = () => logEvent('audio.speech', { started: true });
  utterance.onend = () => logEvent('audio.speech', { ended: true });
  utterance.onerror = (event) => logEvent('audio.speech', { error: event.error });
  logEvent('audio.speech', { available: true, voices: voices.length });
  window.setTimeout(() => synth.speak(utterance), 800);
}

ui.audioTest?.addEventListener('click', () => void testAudio());

gm.device.onButton((event) => {
  logEvent('device.button', event);
  if (event.action === 'single') toggleListening();
});

gm.device.onGesture((event) => {
  logEvent('device.gesture', event);
  handleGesture(event);
});

gm.device.onConnection((event) => {
  logEvent('device.connection', { connected: event.connected });
  devicePageReady = false;
  if (event.connected) {
    pageRetryMs = PAGE_RETRY_MIN_MS;
    void ensureDevicePage();
  } else {
    window.clearTimeout(pageRetryTimer);
    ui.runtimeStatus.textContent = 'Glasses disconnected.';
  }
});

async function initialize() {
  try {
    await gm.ready();
    ui.runtimeStatus.textContent = 'Bridge ready.';

    const stored = await gm.storage.get(STORAGE_KEY_BACKEND_URL);
    backendUrl = stored?.value || DEFAULT_BACKEND_URL;
    ui.backendUrl.value = backendUrl;

    const storedSpeak = await gm.storage.get(STORAGE_KEY_SPEAK_REPLIES);
    speakReplies = storedSpeak?.value !== false;
    ui.speakToggle.checked = speakReplies;

    const capabilities = await gm.runtime.getCapabilities();
    audioAvailable = Boolean(capabilities.audio);
    logEvent('runtime.ready', { audioAvailable, capabilities: Object.keys(capabilities ?? {}) });

    displayAvailable = Boolean(capabilities.display);
    if (displayAvailable) void ensureDevicePage();

    try {
      await gm.device.subscribeEvents(['button', 'imuGesture', 'connection']);
    } catch (error) {
      logEvent('device.events.error', { code: error.code, message: error.message });
    }

    if (!audioAvailable) {
      setState('unavailable');
      updateUi('Microphone not available on this host', '', '');
    } else {
      setState('idle');
      updateUi('Press button to talk', '', '');
    }
  } catch (error) {
    audioAvailable = false;
    ui.runtimeStatus.textContent = `Bridge error: ${error.message}`;
    setState('unavailable');
    logEvent('runtime.error', { code: error.code, message: error.message });
  }
}

void initialize();
