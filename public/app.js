import * as P from './prompts.js';

const $ = (id) => document.getElementById(id);

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ===========================================================================
// Server calls
// ===========================================================================

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return r;
}

function postJson(path, body) {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// purpose 'feedback' makes the server use the high-quality feedback model.
async function chat(system, messages, maxTokens, purpose) {
  const r = await postJson('/api/chat', { system, messages, maxTokens, purpose });
  return (await r.json()).text;
}

function parseJson(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('The model did not return JSON:\n' + text.slice(0, 300));
  return JSON.parse(text.slice(s, e + 1));
}

// ===========================================================================
// Settings
// ===========================================================================

let config = null;

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const NEEDS_KEY = { anthropic: 'anthropic', xai: 'xai', elevenlabs: 'elevenlabs', browser: null };
const LABEL = { anthropic: 'Claude', xai: 'Grok', elevenlabs: 'ElevenLabs', browser: 'Browser' };
const KEY_LABEL = { anthropic: 'Anthropic', elevenlabs: 'ElevenLabs', xai: 'xAI (Grok)' };
const MODEL_FIELDS = [
  ['anthropic', 'Claude model'],
  ['anthropicEffort', 'Claude effort'],
  ['xai', 'Grok model'],
  ['xaiEffort', 'Grok effort'],
  ['anthropicFeedback', 'Feedback model (Claude)'],
  ['anthropicFeedbackEffort', 'Feedback effort (Claude)'],
  ['xaiFeedback', 'Feedback model (Grok)'],
  ['xaiFeedbackEffort', 'Feedback effort (Grok)'],
  ['elevenlabsTts', 'ElevenLabs TTS model'],
  ['elevenlabsVoice', 'ElevenLabs voice ID'],
  ['elevenlabsStt', 'ElevenLabs STT model'],
  ['xaiVoice', 'Grok voice'],
  ['xaiStt', 'Grok STT model'],
];

function providerUsable(value) {
  if (value === 'browser') return true;
  return config.keys[NEEDS_KEY[value]]?.set;
}

async function loadConfig() {
  config = await (await api('/api/config')).json();
  // If a chosen provider has no key but another option does, switch to it.
  const patch = {};
  for (const sel of document.querySelectorAll('select[data-provider]')) {
    const kind = sel.dataset.provider;
    if (providerUsable(config.providers[kind])) continue;
    const alt = [...sel.options].map((o) => o.value).find((v) => providerUsable(v) && !(v === 'browser' && kind === 'stt' && !SpeechRecognition));
    if (alt) patch[kind] = alt;
  }
  if (Object.keys(patch).length) await saveConfig({ providers: patch });
  else renderSettings();
}

async function saveConfig(patch) {
  config = await (await postJson('/api/config', patch)).json();
  renderSettings();
}

function renderSettings() {
  for (const sel of document.querySelectorAll('select[data-provider]')) {
    const kind = sel.dataset.provider;
    for (const opt of sel.options) {
      opt.dataset.label ??= opt.textContent;
      let note = '';
      if (!providerUsable(opt.value)) note = ' — no key';
      if (opt.value === 'browser' && kind === 'stt' && !SpeechRecognition) note = ' — not supported here';
      opt.disabled = Boolean(note);
      opt.textContent = opt.dataset.label + note;
    }
    sel.value = config.providers[kind];
  }

  $('keyStatus').innerHTML = Object.entries(config.keys).map(([name, k]) => `
    <label>${KEY_LABEL[name]}</label>
    <span class="${k.set ? 'key-ok' : 'key-missing'}">${k.set ? '✓ set' : 'not set'} <code>${k.envVar}</code></span>
  `).join('');
  const ws = config.anthropicWorkspaceId;
  if (ws) {
    const label = document.createElement('label');
    label.textContent = 'Anthropic workspace';
    const val = document.createElement('span');
    val.className = ws.set ? 'key-ok' : 'key-missing';
    val.innerHTML = `${ws.set ? '' : 'optional '}<code>${ws.envVar}</code> `;
    if (ws.set) val.prepend(ws.value + ' ');
    $('keyStatus').append(label, val);
  }

  const fields = $('modelFields');
  if (!fields.children.length) {
    for (const [key, label] of MODEL_FIELDS) {
      const l = document.createElement('label');
      l.textContent = label;
      l.htmlFor = 'm_' + key;
      const input = document.createElement('input');
      input.id = 'm_' + key;
      input.addEventListener('change', () => saveConfig({ models: { [key]: input.value } }));
      fields.append(l, input);
    }
  }
  for (const [key] of MODEL_FIELDS) $('m_' + key).value = config.models[key] ?? '';

  const p = config.providers;
  $('chips').textContent = `${LABEL[p.inference]} · STT ${LABEL[p.stt]} · TTS ${LABEL[p.tts]}`;
}

for (const sel of document.querySelectorAll('select[data-provider]')) {
  sel.addEventListener('change', () => saveConfig({ providers: { [sel.dataset.provider]: sel.value } }));
}
// Settings is its own page: while it's open, the rest of the app is hidden
// (and keeps its state underneath, so closing returns you where you were).
function setSettingsOpen(open) {
  $('settings').hidden = !open;
  document.body.classList.toggle('settings-open', open);
  $('settingsBtn').textContent = open ? 'Close' : 'Settings';
  if (open) window.scrollTo(0, 0);
}
$('settingsBtn').addEventListener('click', () => setSettingsOpen($('settings').hidden));
$('refreshBtn').addEventListener('click', loadConfig);

// ===========================================================================
// Setup: job spec -> question plan
// ===========================================================================

let plan = store.get('plan');
$('jobSpec').value = store.get('jobSpec') || '';
$('jobSpec').addEventListener('input', () => store.set('jobSpec', $('jobSpec').value));

// --- Job spec from a file (PDF, or plain text) ------------------------------
// Text is extracted in the browser and placed in the textarea, so it can be
// checked/edited and works the same with every inference provider.

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/';
let pdfjsLib = null;

async function pdfToText(file) {
  if (!pdfjsLib) {
    pdfjsLib = await import(PDFJS + 'pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
  }
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    let text = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      text += item.str + (item.hasEOL ? '\n' : (item.str && !item.str.endsWith(' ') ? ' ' : ''));
    }
    pages.push(text);
  }
  await pdf.destroy();
  return pages.join('\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function loadSpecFile(file) {
  if (!file) return;
  const status = $('fileStatus');
  $('genError').textContent = '';
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const isText = file.type.startsWith('text/') || /\.(txt|md)$/i.test(file.name);
  if (!isPdf && !isText) {
    status.textContent = '';
    $('genError').textContent = 'Please choose a PDF or a text file.';
    return;
  }

  status.textContent = `Reading ${file.name}…`;
  try {
    const text = isPdf ? await pdfToText(file) : (await file.text()).trim();
    if (!text) throw new Error('No text found. If it’s a scanned PDF, copy the text in instead.');
    $('jobSpec').value = text;
    store.set('jobSpec', text);
    status.textContent = `Loaded ${file.name} — check the text, then generate questions.`;
  } catch (e) {
    status.textContent = '';
    const offline = /import|fetch|Failed to load|dynamically imported/i.test(e.message);
    $('genError').textContent = offline
      ? 'Could not load the PDF reader (needs an internet connection). ' + e.message
      : `Could not read ${file.name}: ${e.message}`;
  }
}

$('uploadBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  loadSpecFile(e.target.files[0]);
  e.target.value = ''; // allow re-selecting the same file
});

const specBox = $('jobSpec');
specBox.addEventListener('dragover', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  specBox.classList.add('dragover');
});
specBox.addEventListener('dragleave', () => specBox.classList.remove('dragover'));
specBox.addEventListener('drop', (e) => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  specBox.classList.remove('dragover');
  loadSpecFile(e.dataTransfer.files[0]);
});
// A file dropped outside the box shouldn't make the browser navigate away.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

function renderPlan() {
  $('plan').hidden = !plan?.questions?.length;
  if (!plan) return;
  $('planTitle').textContent = plan.role ? `Questions — ${plan.role}` : 'Questions';
  const ol = $('questions');
  ol.innerHTML = '';
  // Collapsed by default: each question shows only its short topic until opened.
  plan.questions.forEach((q, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<details><summary class="q"><span class="topic"></span><span class="tag"></span><button title="Remove">×</button></summary><div class="text"></div></details>`;
    li.querySelector('.topic').textContent = q.topic || `${q.type[0].toUpperCase()}${q.type.slice(1)} question`;
    li.querySelector('.text').textContent = q.text;
    const tag = li.querySelector('.tag');
    tag.textContent = q.type;
    tag.classList.add(q.type);
    li.querySelector('button').addEventListener('click', (e) => {
      e.preventDefault(); // don't toggle the accordion
      plan.questions.splice(i, 1);
      store.set('plan', plan);
      renderPlan();
    });
    ol.append(li);
  });
}

$('genBtn').addEventListener('click', async () => {
  const spec = $('jobSpec').value.trim();
  $('genError').textContent = '';
  if (!spec) { $('genError').textContent = 'Paste a job spec first.'; return; }
  const btn = $('genBtn');
  btn.disabled = true;
  btn.textContent = 'Generating…';
  try {
    const text = await chat(P.questionPlanSystem, [{ role: 'user', content: P.questionPlanUser(spec, Number($('qCount').value)) }], 4000);
    const data = parseJson(text);
    if (!Array.isArray(data.questions) || !data.questions.length) throw new Error('No questions in the response.');
    plan = { role: data.role || 'this role', jobSpec: spec, questions: data.questions };
    store.set('plan', plan);
    renderPlan();
  } catch (e) {
    $('genError').textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate questions';
  }
});

// ===========================================================================
// Speaking (TTS)
// ===========================================================================

let stopCurrentSpeech = null;

// Browsers only allow audio to start soon after a click. The interviewer
// speaks several seconds after Start (mic, model call, TTS download), so we
// unlock a single audio element during the click and reuse it for every line.
const player = new Audio();
let silentUrl = null;
let currentUtterance = null; // keep a reference: Chrome drops speech whose utterance is garbage-collected

function unlockAudio() {
  try { getAudioCtx().resume().catch(() => {}); } catch { /* ignore */ }
  try {
    silentUrl ??= URL.createObjectURL(encodeWav(new Float32Array(1600), 16000)); // 0.1s of silence
    player.src = silentUrl;
    player.play().catch(() => { /* still locked; speak() will offer a Play button */ });
  } catch { /* ignore */ }
  try {
    if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  } catch { /* ignore */ }
}

// Shown when the browser refuses to start audio by itself; a click always works.
function offerPlay(play) {
  $('playBtn').hidden = false;
  $('playBtn').onclick = () => { $('playBtn').hidden = true; play(); };
  if (state === 'speaking') $('statusText').innerHTML = 'The browser blocked the audio — click <b>Play question</b>, or <kbd>Space</kbd> to skip';
}

function speak(text) {
  return config.providers.tts === 'browser' ? speakBrowser(text) : speakServer(text);
}

function speakBrowser(text) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    currentUtterance = u;
    const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
    u.voice = voices.find((v) => v.default) || voices[0] || null;
    u.rate = 1.02;
    let started = false;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      stopCurrentSpeech = null;
      $('playBtn').hidden = true;
      resolve();
    };
    const say = () => { if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel(); speechSynthesis.speak(u); };
    u.onstart = () => { started = true; $('playBtn').hidden = true; };
    u.onend = done;
    u.onerror = (e) => { if (e.error === 'not-allowed') offerPlay(say); else done(); };
    stopCurrentSpeech = () => { speechSynthesis.cancel(); done(); };
    say();
    // Some browsers silently never start: offer the button rather than hang.
    setTimeout(() => { if (!started && !finished) offerPlay(say); }, 3000);
  });
}

async function speakServer(text) {
  const blob = await (await postJson('/api/tts', { text })).blob();
  const url = URL.createObjectURL(blob);
  try {
    await new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        player.onended = player.onerror = null;
        stopCurrentSpeech = null;
        $('playBtn').hidden = true;
        resolve();
      };
      player.onended = done;
      player.onerror = done;
      stopCurrentSpeech = () => { player.pause(); done(); };
      player.src = url;
      player.play().catch((err) => {
        if (finished) return;
        if (err.name === 'NotAllowedError') {
          console.warn('Audio play blocked:', err.message);
          offerPlay(() => player.play().catch(done));
        } else {
          // e.g. the audio couldn't be decoded: don't wait forever.
          showError('Could not play the interviewer’s audio: ' + err.message);
          done();
        }
      });
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ===========================================================================
// Listening (STT)
// ===========================================================================

let mic = null;
let meterRaf = 0;

// One AudioContext for the mic. Created/resumed inside a click (unlockAudio)
// so it's allowed to run.
let audioCtx = null;
function getAudioCtx() {
  audioCtx ??= new AudioContext();
  return audioCtx;
}

// --- Continuous capture -------------------------------------------------------
// The mic is captured all the time into a rolling buffer of raw samples, so an
// answer can include a little audio from *before* listening started (you may
// start talking the instant the question ends) and *after* Space is pressed
// (the last word is often still being spoken). No codec, no re-encoding.

const PRE_ROLL_S = 0.3;
const POST_ROLL_MS = 700;
const KEEP_IDLE_S = 2;

const CAPTURE_WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('capture', Capture);`;

const pcm = { chunks: [], total: 0, rate: 0, captureFrom: null, lastAt: 0 };
let captureReady = false;

function onPcm(data) {
  pcm.chunks.push({ start: pcm.total, data });
  pcm.total += data.length;
  pcm.lastAt = performance.now();
  if (pcm.captureFrom === null) {
    const keepFrom = pcm.total - KEEP_IDLE_S * pcm.rate;
    while (pcm.chunks.length && pcm.chunks[0].start + pcm.chunks[0].data.length < keepFrom) pcm.chunks.shift();
  }
}

function pcmSlice(from, to) {
  const out = new Float32Array(Math.max(0, to - from));
  for (const c of pcm.chunks) {
    const s = Math.max(from, c.start);
    const e = Math.min(to, c.start + c.data.length);
    if (e > s) out.set(c.data.subarray(s - c.start, e - c.start), s - from);
  }
  return out;
}

// Average-and-decimate to 16 kHz (what STT models use).
function downsample(samples, from, to) {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += samples[j];
    out[i] = sum / Math.max(1, b - a);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureMic() {
  if (mic) return;
  // Noise suppression is off: it can swallow quiet word beginnings and endings,
  // and the STT models cope with background noise anyway.
  mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true, channelCount: 1 },
  });
  const ctx = getAudioCtx();
  await ctx.resume().catch(() => {});
  const source = ctx.createMediaStreamSource(mic);
  try {
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(ctx, 'capture');
    pcm.rate = ctx.sampleRate;
    node.port.onmessage = (e) => onPcm(e.data);
    const mute = ctx.createGain();
    mute.gain.value = 0; // keeps the node running without making a sound
    source.connect(node).connect(mute).connect(ctx.destination);
    captureReady = true;
  } catch (e) {
    console.warn('Continuous capture unavailable, using MediaRecorder:', e);
  }
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  const bar = $('meter').querySelector('i');
  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
    bar.style.width = Math.min(100, (peak / 64) * 100) + '%';
    meterRaf = requestAnimationFrame(tick);
  };
  tick();
}

// Listeners: start(); record() -> {wav, seconds} once all audio is in;
// transcribe(wav) -> text (server STT only); abort().

async function transcribeWav(wav) {
  const r = await api('/api/stt', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
  return (await r.json()).text || '';
}

// Preferred: slice the continuous capture.
function pcmListener() {
  let from = 0;
  return {
    server: true,
    start() {
      from = Math.max(0, pcm.total - Math.round(PRE_ROLL_S * pcm.rate));
      pcm.captureFrom = from;
    },
    abort() { pcm.captureFrom = null; },
    async record() {
      await sleep(POST_ROLL_MS); // let the last word arrive
      const to = pcm.total;
      pcm.captureFrom = null;
      if (performance.now() - pcm.lastAt > 1000) throw new Error('The microphone stopped sending audio.');
      const samples = pcmSlice(from, to);
      return { wav: encodeWav(downsample(samples, pcm.rate, 16000), 16000), seconds: samples.length / pcm.rate };
    },
    transcribe: transcribeWav,
  };
}

// Fallback if AudioWorklet isn't available: MediaRecorder.
function mediaRecorderListener() {
  const chunks = [];
  const rec = new MediaRecorder(mic);
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  let startedAt = 0;
  return {
    server: true,
    start() { rec.start(); startedAt = performance.now(); },
    abort() { if (rec.state !== 'inactive') rec.stop(); },
    async record() {
      await sleep(POST_ROLL_MS);
      if (rec.state !== 'inactive') rec.stop();
      await stopped; // all chunks are delivered before onstop
      const blob = new Blob(chunks, { type: rec.mimeType });
      return { wav: await toWav(blob), seconds: (performance.now() - startedAt) / 1000 };
    },
    transcribe: transcribeWav,
  };
}

function serverListener() {
  return captureReady && audioCtx?.state === 'running' ? pcmListener() : mediaRecorderListener();
}

function browserListener() {
  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';
  let finals = '';
  let interim = '';
  let active = true;
  let resolveEnd;
  const ended = new Promise((r) => { resolveEnd = r; });

  rec.onresult = (e) => {
    interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finals += t.trim() + ' ';
      else interim += t;
    }
    $('live').textContent = (finals + interim).trim();
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      active = false;
      showError('Browser speech recognition was blocked. Allow the microphone, or pick another STT provider in Settings.');
    }
  };
  rec.onend = () => {
    // Chrome stops after long silences; keep going until the user presses Space.
    if (active) { try { rec.start(); return; } catch { /* fall through */ } }
    resolveEnd();
  };
  let startedAt = 0;
  return {
    server: false,
    start() { rec.start(); startedAt = performance.now(); },
    abort() { active = false; rec.abort(); },
    // Browser recognition returns text directly; there's no audio to keep.
    async record() {
      await sleep(POST_ROLL_MS);
      active = false;
      rec.stop();
      await ended;
      return { text: (finals + interim).trim(), seconds: (performance.now() - startedAt) / 1000 };
    },
  };
}

// Re-encode whatever MediaRecorder produced as 16 kHz mono WAV, which every
// STT provider accepts regardless of the browser's native recording format.
async function toWav(blob) {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();
  const rate = 16000;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  return encodeWav((await off.startRendering()).getChannelData(0), rate);
}

// 16-bit mono PCM WAV from float samples.
function encodeWav(pcm, rate) {
  const view = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}

// ===========================================================================
// Interview loop
// ===========================================================================

let iv = null;      // current interview session
let state = 'idle'; // idle | thinking | speaking | listening | transcribing | done
let listener = null;

function setState(s, text) {
  state = s;
  $('status').dataset.state = s;
  $('face').dataset.state = s;
  $('playBtn').hidden = true;
  $('reanswerBtn').hidden = true;
  $('recTime').hidden = s !== 'listening';
  $('statusText').innerHTML = text;
  $('meter').hidden = s !== 'listening';
  $('doneBtn').disabled = s !== 'listening';
}

function showError(msg) { $('ivError').textContent = msg || ''; }

// --- Persistence: the session survives refreshes -----------------------------
function saveSession() { if (iv) store.set('session', iv); }

function addLog(who, text, action, meta = {}, audio = null) {
  // qIndex ties each line to its planned question, for per-answer feedback.
  const turn = { who, text, qIndex: iv.qIndex, action, ...meta };
  iv.log.push(turn);
  if (audio) recordings.set(turn, audio);
  saveSession();
  renderTurn(turn, iv);
  return turn;
}

// Short label shown while a line is collapsed.
function turnLabel(turn) {
  if (turn.who === 'You') {
    const n = turn.text.trim().split(/\s+/).filter(Boolean).length;
    return `${n} word${n === 1 ? '' : 's'}${turn.seconds ? ' · ' + fmtTime(turn.seconds) : ''}`;
  }
  if (turn.action === 'end') return 'Closing';
  if (turn.action === 'follow_up') return 'Follow-up';
  if (turn.qIndex === undefined) return '';
  const q = plan?.questions?.[turn.qIndex];
  return `Question ${turn.qIndex + 1}${q?.topic ? ' · ' + q.topic : ''}`;
}

// Transcript lines are collapsed by default (you listen rather than read).
let transcriptOpen = Boolean(store.get('transcriptOpen'));
function setTranscriptOpen(open) {
  transcriptOpen = open;
  store.set('transcriptOpen', open);
  $('toggleText').textContent = open ? 'Hide all text' : 'Show all text';
  for (const d of document.querySelectorAll('#log details.line')) d.open = open;
}

function renderTurn(turn, session) {
  const div = document.createElement('div');
  div.className = 'turn ' + (turn.who === 'Interviewer' ? 'interviewer' : 'you');
  div.innerHTML = '<details class="line"><summary><span class="who"></span><span class="label"></span></summary><div class="body"></div></details>';
  div.querySelector('.line').open = transcriptOpen;
  div.querySelector('.who').textContent = turn.who;
  div.querySelector('.label').textContent = turnLabel(turn);
  div.querySelector('.body').textContent = turn.text;
  if (turn.who === 'You') {
    const area = document.createElement('div');
    area.className = 'fb-area';
    div.append(area);
    renderAnswerFeedback(area, turn, session);
  }
  $('log').prepend(div); // newest on top, next to the controls
}

// --- Per-answer feedback -----------------------------------------------------

let feedbackInFlight = 0;

// The planned question plus every turn on it, up to and including this answer.
function feedbackThread(session, turn) {
  const i = session.log.indexOf(turn);
  if (turn.qIndex === undefined) {
    // Older saved sessions: just the question right before the answer.
    const q = session.log.slice(0, i).reverse().find((t) => t.who === 'Interviewer');
    return q ? [q, turn] : [turn];
  }
  return session.log.slice(0, i + 1).filter((t) => t.qIndex === turn.qIndex);
}

function renderAnswerFeedback(area, turn, session) {
  area.innerHTML = '';
  const links = document.createElement('div');
  links.className = 'turn-links';
  area.append(links);
  const audio = recordings.get(turn);
  if (audio) {
    // Hear exactly what was sent to speech-to-text.
    const play = document.createElement('button');
    play.className = 'link';
    play.textContent = '▶ Play recording';
    let el = null;
    play.addEventListener('click', () => {
      play.blur();
      if (el && !el.paused) { el.pause(); el.currentTime = 0; play.textContent = '▶ Play recording'; return; }
      el ??= new Audio(URL.createObjectURL(audio));
      el.onended = () => { play.textContent = '▶ Play recording'; };
      el.play();
      play.textContent = '■ Stop';
    });
    links.append(play);
  }
  if (turn.feedback) return area.append(feedbackCard(turn.feedback));
  const btn = document.createElement('button');
  btn.className = 'link';
  btn.textContent = 'Get feedback';
  btn.addEventListener('click', () => getAnswerFeedback(area, turn, session, btn));
  links.prepend(btn);
}

async function getAnswerFeedback(area, turn, session, btn) {
  btn.blur(); // keep Space for the interview
  btn.disabled = true;
  btn.textContent = 'Getting feedback… (can take up to a minute)';
  area.querySelector('.error')?.remove();
  feedbackInFlight++;
  try {
    const text = await chat(
      P.answerFeedbackSystem({ role: plan.role, jobSpec: plan.jobSpec }),
      [{ role: 'user', content: P.answerFeedbackUser({ plannedQuestion: plan.questions[turn.qIndex], thread: feedbackThread(session, turn) }) }],
      32000,
      'feedback',
    );
    turn.feedback = parseJson(text);
    if (session === iv) saveSession();
    if (area.isConnected) renderAnswerFeedback(area, turn, session);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Try again';
    const err = document.createElement('div');
    err.className = 'error';
    err.textContent = 'Feedback failed: ' + e.message;
    area.append(err);
  } finally {
    feedbackInFlight--;
  }
}

function feedbackCard(fb) {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const list = (title, items, fn) => {
    if (!items?.length) return null;
    const sec = el('div', 'fb-sec');
    sec.append(el('h3', '', title));
    const ul = el('ul');
    for (const it of items) { const li = el('li'); fn(li, it); ul.append(li); }
    sec.append(ul);
    return sec;
  };

  const card = el('details', 'fb');
  card.open = true;
  const sum = el('summary');
  const rating = String(fb.rating || '').toLowerCase();
  sum.append(el('span', 'rating ' + rating, rating || 'feedback'), el('span', 'fb-summary', fb.summary || ''));
  card.append(sum);

  const parts = [
    list('What worked', fb.strengths, (li, s) => { li.textContent = s; }),
    list('What was missing', fb.gaps, (li, s) => { li.textContent = s; }),
    list('Details to add', fb.missing_details, (li, d) => {
      if (typeof d === 'string') { li.textContent = d; return; }
      li.append(el('strong', '', d.point + ': '), document.createTextNode(d.explanation || ''));
    }),
  ];
  if (fb.improved_answer) {
    const sec = el('div', 'fb-sec');
    sec.append(el('h3', '', 'A stronger answer'), el('blockquote', '', fb.improved_answer));
    parts.push(sec);
  }
  if (fb.tip) {
    const sec = el('div', 'fb-sec');
    sec.append(el('h3', '', 'Tip'), el('p', '', fb.tip));
    parts.push(sec);
  }
  card.append(...parts.filter(Boolean));
  return card;
}

function show(section) {
  // Feedback is revealed separately, under the interview, once requested.
  for (const id of ['setup', 'interview', 'feedback']) $(id).hidden = id !== section;
  store.set('view', section);
}

async function startInterview() {
  if (!plan?.questions?.length) return;
  unlockAudio(); // must happen inside the click, before any await
  document.activeElement?.blur(); // so Space doesn't press a focused button
  iv = { log: [], history: [], qIndex: 0, followUps: 0, started: false, ended: false };
  saveSession();
  store.set('feedback', null);
  $('feedbackText').textContent = '';
  $('log').innerHTML = '';
  $('live').textContent = '';
  $('afterRow').hidden = true;
  $('endBtn').hidden = false;
  setSettingsOpen(false);
  show('interview');
  showError('');
  try {
    await ensureMic();
  } catch {
    showError('Microphone access was denied. Allow it in the browser and try again.');
    setState('idle', 'No microphone');
    return;
  }
  await interviewerTurn(P.kickoffMessage(plan.questions[0]));
}

async function interviewerTurn(userContent) {
  const my = iv;
  $('retryBtn').hidden = true;
  setState('thinking', 'Interviewer is thinking…');
  my.history.push({ role: 'user', content: userContent });
  saveSession();

  let reply;
  try {
    reply = parseJson(await chat(P.interviewerSystem(plan), my.history, 2000));
    if (!reply.say) throw new Error('Empty interviewer reply.');
  } catch (e) {
    if (iv !== my || my.ended) return;
    my.history.pop();
    saveSession();
    showError(e.message);
    setState('idle', 'Something went wrong');
    $('retryBtn').hidden = false;
    $('retryBtn').onclick = () => { unlockAudio(); showError(''); interviewerTurn(userContent); };
    return;
  }
  if (iv !== my || my.ended) return;
  my.history.push({ role: 'assistant', content: JSON.stringify(reply) });

  if (reply.action === 'follow_up') {
    my.followUps++;
  } else if (reply.action === 'next') {
    if (my.started) { my.qIndex++; my.followUps = 0; }
    my.started = true;
    if (my.qIndex >= plan.questions.length) reply.action = 'end';
  }
  const ending = reply.action === 'end';
  my.pendingEnd = ending; // so a refresh during the goodbye still ends cleanly

  addLog('Interviewer', reply.say, reply.action); // also saves
  setState('speaking', 'Interviewer speaking… <kbd>Space</kbd> to skip');
  try { await speak(reply.say); } catch (e) { showError('Speech failed: ' + e.message); }
  if (iv !== my || my.ended) return;

  if (ending) return finishInterview();
  startListening();
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
let recTimer = null;

function startListening(note = '') {
  $('live').textContent = note;
  setState('listening', 'Listening — press <kbd>Space</kbd> when you’ve finished your answer');
  try {
    listener = config.providers.stt === 'browser' ? browserListener() : serverListener();
    listener.start();
    const t0 = performance.now();
    clearInterval(recTimer);
    $('recTime').textContent = '0:00';
    recTimer = setInterval(() => {
      if (state !== 'listening') { clearInterval(recTimer); return; }
      $('recTime').textContent = fmtTime((performance.now() - t0) / 1000);
    }, 250);
  } catch (e) {
    showError('Could not start listening: ' + e.message);
    setState('idle', 'Not listening');
  }
}

// Recordings of your answers, kept in memory for "Play recording" (not saved).
const recordings = new WeakMap();

async function doneAnswering() {
  if (state !== 'listening' || !listener) return;
  const my = iv;
  const l = listener;
  listener = null;
  setState('transcribing', 'Finishing recording…');

  // 1. Get ALL the audio first (including a short tail after Space).
  let rec;
  try {
    rec = await l.record();
  } catch (e) {
    if (iv !== my || my.ended) return;
    showError('Recording failed: ' + e.message);
    return startListening('Recording failed — please give that answer again.');
  }
  if (iv !== my || my.ended) return;

  // 2. Only then transcribe it.
  if (l.server) {
    setState('transcribing', `Transcribing ${fmtTime(rec.seconds)} of audio…`);
    try {
      rec.text = await l.transcribe(rec.wav);
    } catch (e) {
      if (iv !== my || my.ended) return;
      return offerTranscriptionRetry(my, l, rec, e);
    }
  }
  if (iv !== my || my.ended) return;
  await submitAnswer(my, rec);
}

// Keep the recording when transcription fails, so the answer isn't lost.
function offerTranscriptionRetry(my, l, rec, err) {
  showError('Transcription failed: ' + err.message);
  setState('idle', `Your ${fmtTime(rec.seconds)} answer is saved — retry the transcription, or answer again`);
  $('retryBtn').textContent = 'Retry transcription';
  $('retryBtn').hidden = false;
  $('reanswerBtn').hidden = false;
  $('retryBtn').onclick = async () => {
    $('retryBtn').hidden = $('reanswerBtn').hidden = true;
    showError('');
    setState('transcribing', `Transcribing ${fmtTime(rec.seconds)} of audio…`);
    try {
      rec.text = await l.transcribe(rec.wav);
    } catch (e) {
      if (iv === my && !my.ended) offerTranscriptionRetry(my, l, rec, e);
      return;
    }
    if (iv === my && !my.ended) submitAnswer(my, rec);
  };
  $('reanswerBtn').onclick = () => {
    $('retryBtn').hidden = $('reanswerBtn').hidden = true;
    showError('');
    startListening('Give that answer again.');
  };
}

async function submitAnswer(my, rec) {
  $('retryBtn').textContent = 'Retry';
  const answer = (rec.text || '').trim();
  $('live').textContent = '';
  if (!answer) return startListening('Didn’t catch anything — try again.');

  showError('');
  addLog('You', answer, undefined, { seconds: Math.round(rec.seconds) }, rec.wav);
  await interviewerTurn(P.answerMessage({
    answer,
    qIndex: my.qIndex,
    followUps: my.followUps,
    nextQuestion: plan.questions[my.qIndex + 1],
  }));
}

function finishInterview() {
  if (!iv) return;
  iv.ended = true;
  saveSession();
  listener?.abort();
  listener = null;
  stopCurrentSpeech?.();
  $('retryBtn').hidden = true;
  $('live').textContent = '';
  setState('done', 'Interview finished');
  $('afterRow').hidden = false;
  $('endBtn').hidden = true;
}

$('startBtn').addEventListener('click', startInterview);
$('doneBtn').addEventListener('click', doneAnswering);
$('endBtn').addEventListener('click', finishInterview);

$('backBtn').addEventListener('click', () => {
  setState('idle', 'Ready');
  show('setup');
});

$('feedbackBtn').addEventListener('click', async () => {
  const btn = $('feedbackBtn');
  if (!iv?.log.length) return;
  btn.disabled = true;
  btn.textContent = 'Writing overall feedback… (can take a minute)';
  $('feedback').hidden = false;
  $('feedbackText').textContent = '';
  try {
    const transcript = iv.log.map((t) => `${t.who === 'You' ? 'Candidate' : 'Interviewer'}: ${t.text}`).join('\n\n');
    const text = await chat(P.feedbackSystem, [{ role: 'user', content: P.feedbackUser({ role: plan.role, transcript }) }], 32000, 'feedback');
    $('feedbackText').textContent = text;
    store.set('feedback', text);
    $('feedback').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    $('feedbackText').textContent = 'Feedback failed: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Overall feedback';
  }
});

// Space: finish answering, or skip the interviewer's speech.
function isTyping(t) { return t.matches?.('input, textarea, select, [contenteditable="true"]'); }
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || $('interview').hidden || document.body.classList.contains('settings-open') || isTyping(e.target)) return;
  e.preventDefault();
  if (e.repeat) return;
  if (state === 'listening') doneAnswering();
  else if (state === 'speaking') stopCurrentSpeech?.();
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && !$('interview').hidden && !isTyping(e.target)) e.preventDefault();
});

$('toggleText').addEventListener('click', () => setTranscriptOpen(!transcriptOpen));
$('toggleText').textContent = transcriptOpen ? 'Hide all text' : 'Show all text';

// ===========================================================================
// The interviewer's "video" tile: a line-drawn face that blinks, glances away
// while thinking, nods while listening and moves its mouth while speaking.
// ===========================================================================

const face = $('face');
(function blink() {
  setTimeout(() => {
    face.classList.add('blink');
    setTimeout(() => face.classList.remove('blink'), 140);
    blink();
  }, 2500 + Math.random() * 3500);
})();

function audioPlaying() {
  if (config?.providers.tts === 'browser') return 'speechSynthesis' in window && speechSynthesis.speaking;
  return !player.paused && !player.ended && player.src !== silentUrl;
}

let mouthLevel = 0;
setInterval(() => {
  if ($('interview').hidden) return;
  const talking = state === 'speaking' && audioPlaying();
  // Speech-like movement: jump to a random openness, with smoothing.
  const target = talking ? (Math.random() < 0.15 ? 0.1 : 0.3 + Math.random() * 0.7) : 0;
  mouthLevel += (target - mouthLevel) * 0.6;
  $('faceMouth').setAttribute('ry', (1.2 + mouthLevel * 7).toFixed(2));
  $('faceMouth').setAttribute('rx', (11 - mouthLevel * 2).toFixed(2));
}, 90);

// Settings: hear the current voice on its own.
$('testVoiceBtn').addEventListener('click', async () => {
  const status = $('testVoiceStatus');
  unlockAudio();
  status.textContent = 'Speaking…';
  try {
    await speak('Hi, thanks for joining. This is how I will sound during the interview.');
    status.textContent = 'Done. If you heard nothing, check your volume and output device.';
  } catch (e) {
    status.textContent = 'Speech failed: ' + e.message;
  }
});

// ===========================================================================
// Restore after a refresh, and reset
// ===========================================================================

function restoreSession() {
  const saved = store.get('session');
  const feedback = store.get('feedback');
  if (store.get('view') !== 'interview' || !saved?.log || !plan?.questions?.length) return;

  iv = saved;
  show('interview');
  $('log').innerHTML = '';
  for (const t of iv.log) renderTurn(t, iv);
  if (feedback) { $('feedback').hidden = false; $('feedbackText').textContent = feedback; }

  // A refresh during the closing line: treat the interview as finished.
  const last = iv.history.at(-1);
  if (!iv.ended && iv.pendingEnd && last?.role === 'assistant') iv.ended = true;

  if (iv.ended) {
    setState('done', 'Interview finished');
    $('afterRow').hidden = false;
    $('endBtn').hidden = true;
    return;
  }
  setState('idle', 'Interview paused by a page reload');
  $('retryBtn').textContent = 'Resume';
  $('retryBtn').hidden = false;
  $('retryBtn').onclick = resumeInterview;
}

async function resumeInterview() {
  unlockAudio();
  $('retryBtn').hidden = true;
  $('retryBtn').textContent = 'Retry';
  showError('');
  try {
    await ensureMic();
  } catch {
    showError('Microphone access was denied. Allow it in the browser and try again.');
    setState('idle', 'No microphone');
    $('retryBtn').textContent = 'Resume';
    $('retryBtn').hidden = false;
    return;
  }
  const last = iv.history.at(-1);
  if (last?.role === 'user') {
    // The interviewer hadn't replied yet: ask again.
    iv.history.pop();
    return interviewerTurn(last.content);
  }
  if (!last) return interviewerTurn(P.kickoffMessage(plan.questions[0]));
  // The interviewer's question is the newest line in the log: answer it.
  startListening('Answer the interviewer’s last question.');
}

// Two clicks to reset, so it can't happen by accident.
let resetArmed = null;
$('resetBtn').addEventListener('click', () => {
  const btn = $('resetBtn');
  if (!resetArmed) {
    btn.textContent = 'Click again to erase everything';
    btn.classList.add('confirm');
    resetArmed = setTimeout(() => {
      resetArmed = null;
      btn.textContent = 'Reset all data';
      btn.classList.remove('confirm');
    }, 4000);
    return;
  }
  clearTimeout(resetArmed);
  if (iv) iv.ended = true; // stop any in-flight turn from saving again
  listener?.abort();
  stopCurrentSpeech?.();
  for (const k of ['jobSpec', 'plan', 'qCount', 'session', 'feedback', 'view']) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
  location.reload();
});

// Question count is remembered too.
if (store.get('qCount')) $('qCount').value = String(store.get('qCount'));
$('qCount').addEventListener('change', () => store.set('qCount', $('qCount').value));

// ===========================================================================
// Boot
// ===========================================================================

// Live reload when files in public/ change. Never mid-interview or while
// questions are generating: wait until it's safe, so nothing is lost.
let reloadPending = false;
// The session itself is saved, so only in-flight work (a recording, a model
// call, speech) would be lost.
function safeToReload() {
  return ['idle', 'done'].includes(state) && !$('genBtn').disabled && !$('feedbackBtn').disabled && feedbackInFlight === 0
    && $('reanswerBtn').hidden; // an unsent recording is waiting for "Retry transcription"
}
function requestReload() {
  if (safeToReload()) return location.reload();
  if (reloadPending) return;
  reloadPending = true;
  $('reloadNote').hidden = false;
  const wait = setInterval(() => {
    if (safeToReload()) { clearInterval(wait); location.reload(); }
  }, 500);
}
if ('EventSource' in window) {
  new EventSource('/api/live').onmessage = (e) => { if (e.data === 'reload') requestReload(); };
}

if ('speechSynthesis' in window) speechSynthesis.getVoices(); // warm up voice list
renderPlan();
restoreSession();
loadConfig().catch((e) => { $('genError').textContent = 'Could not reach the local server: ' + e.message; });
