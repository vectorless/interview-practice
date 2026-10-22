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
$('settingsBtn').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; });
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

function speak(text) {
  return config.providers.tts === 'browser' ? speakBrowser(text) : speakServer(text);
}

function speakBrowser(text) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
    u.voice = voices.find((v) => v.default) || voices[0] || null;
    u.rate = 1.02;
    const done = () => { stopCurrentSpeech = null; resolve(); };
    u.onend = done;
    u.onerror = done;
    stopCurrentSpeech = () => speechSynthesis.cancel();
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

async function speakServer(text) {
  const blob = await (await postJson('/api/tts', { text })).blob();
  const url = URL.createObjectURL(blob);
  return new Promise((resolve) => {
    const audio = new Audio(url);
    const done = () => {
      stopCurrentSpeech = null;
      URL.revokeObjectURL(url);
      resolve();
    };
    audio.onended = done;
    audio.onerror = done;
    stopCurrentSpeech = () => { audio.pause(); done(); };
    audio.play().catch(done);
  });
}

// ===========================================================================
// Listening (STT)
// ===========================================================================

let mic = null;
let meterRaf = 0;

async function ensureMic() {
  if (mic) return;
  mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(mic).connect(analyser);
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

// Each listener has start() and finish() -> Promise<string>, plus abort().
function serverListener() {
  const chunks = [];
  const rec = new MediaRecorder(mic);
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  return {
    start() { rec.start(); },
    abort() { if (rec.state !== 'inactive') rec.stop(); },
    async finish() {
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
      const blob = new Blob(chunks, { type: rec.mimeType });
      let wav;
      try { wav = await toWav(blob); } catch { return ''; } // nothing decodable recorded
      const r = await api('/api/stt', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
      return (await r.json()).text || '';
    },
  };
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
  return {
    start() { rec.start(); },
    abort() { active = false; rec.abort(); },
    async finish() {
      active = false;
      rec.stop();
      await ended;
      return (finals + interim).trim();
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
  const pcm = (await off.startRendering()).getChannelData(0);

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
  $('statusText').innerHTML = text;
  $('meter').hidden = s !== 'listening';
  $('doneBtn').disabled = s !== 'listening';
}

function showError(msg) { $('ivError').textContent = msg || ''; }

// --- Persistence: the session survives refreshes -----------------------------
function saveSession() { if (iv) store.set('session', iv); }

function addLog(who, text) {
  // qIndex ties each line to its planned question, for per-answer feedback.
  const turn = { who, text, qIndex: iv.qIndex };
  iv.log.push(turn);
  saveSession();
  renderTurn(turn, iv);
}

function renderTurn(turn, session) {
  const div = document.createElement('div');
  div.className = 'turn ' + (turn.who === 'Interviewer' ? 'interviewer' : 'you');
  div.innerHTML = '<div class="who"></div><div class="body"></div>';
  div.querySelector('.who').textContent = turn.who;
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
  if (turn.feedback) return area.append(feedbackCard(turn.feedback));
  const btn = document.createElement('button');
  btn.className = 'link';
  btn.textContent = 'Get feedback';
  btn.addEventListener('click', () => getAnswerFeedback(area, turn, session, btn));
  area.append(btn);
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
  document.activeElement?.blur(); // so Space doesn't press a focused button
  iv = { log: [], history: [], qIndex: 0, followUps: 0, started: false, ended: false };
  saveSession();
  store.set('feedback', null);
  $('feedbackText').textContent = '';
  $('log').innerHTML = '';
  $('live').textContent = '';
  $('afterRow').hidden = true;
  $('endBtn').hidden = false;
  $('settings').hidden = true;
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
    $('retryBtn').onclick = () => { showError(''); interviewerTurn(userContent); };
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

  addLog('Interviewer', reply.say); // also saves
  setState('speaking', 'Interviewer speaking… <kbd>Space</kbd> to skip');
  try { await speak(reply.say); } catch (e) { showError('Speech failed: ' + e.message); }
  if (iv !== my || my.ended) return;

  if (ending) return finishInterview();
  startListening();
}

function startListening(note = '') {
  $('live').textContent = note;
  setState('listening', 'Listening — press <kbd>Space</kbd> when you’ve finished your answer');
  try {
    listener = config.providers.stt === 'browser' ? browserListener() : serverListener();
    listener.start();
  } catch (e) {
    showError('Could not start listening: ' + e.message);
    setState('idle', 'Not listening');
  }
}

async function doneAnswering() {
  if (state !== 'listening' || !listener) return;
  const my = iv;
  const l = listener;
  listener = null;
  setState('transcribing', 'Transcribing…');
  let answer = '';
  try {
    answer = await l.finish();
  } catch (e) {
    if (iv !== my || my.ended) return;
    showError('Transcription failed: ' + e.message);
    return startListening('Transcription failed — please give that answer again.');
  }
  if (iv !== my || my.ended) return;
  $('live').textContent = '';
  if (!answer.trim()) return startListening('Didn’t catch anything — try again.');

  showError('');
  addLog('You', answer);
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
  if (e.code !== 'Space' || $('interview').hidden || isTyping(e.target)) return;
  e.preventDefault();
  if (e.repeat) return;
  if (state === 'listening') doneAnswering();
  else if (state === 'speaking') stopCurrentSpeech?.();
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && !$('interview').hidden && !isTyping(e.target)) e.preventDefault();
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
  return ['idle', 'done'].includes(state) && !$('genBtn').disabled && !$('feedbackBtn').disabled && feedbackInFlight === 0;
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
