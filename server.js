// Interview Practice — local server
// Zero dependencies. Requires Node 18+ (uses built-in fetch, FormData, Blob).
// Run:  node server.js   then open http://localhost:3456

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3456;
const HOST = '127.0.0.1'; // local only
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_PATH = path.join(__dirname, 'config.json');

const ENV_PATH = path.join(__dirname, '.env');

// ---------------------------------------------------------------------------
// API keys come from .env (re-read on every request, so edits apply without
// a restart). Provider/model choices are made in the UI and saved to
// config.json, which never contains keys.
// ---------------------------------------------------------------------------

const KEY_VARS = {
  anthropic: 'ANTHROPIC_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  xai: 'XAI_API_KEY',
};

function parseEnvFile() {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(ENV_PATH, 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, ''); // strip trailing comment on unquoted values
    out[m[1]] = v.trim();
  }
  return out;
}

function loadKeys() {
  const env = parseEnvFile();
  const keys = {};
  for (const [name, varName] of Object.entries(KEY_VARS)) {
    keys[name] = env[varName] || process.env[varName] || '';
  }
  return keys;
}

const DEFAULTS = {
  providers: { inference: 'anthropic', stt: 'browser', tts: 'browser' },
  models: {
    anthropic: 'claude-sonnet-5-5',
    anthropicEffort: 'low',
    xai: 'grok-4.7',
    xaiEffort: 'low',
    elevenlabsTts: 'eleven_multilingual_v2',
    elevenlabsVoice: 'JBFqnCBsd6RMkjVDRZzb',
    elevenlabsStt: 'scribe_v2',
    xaiVoice: 'rex',
    xaiStt: 'grok-voice-transcribe-2.0',
  },
};

function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* first run */ }
  return {
    keys: loadKeys(),
    providers: { ...DEFAULTS.providers, ...(saved.providers || {}) },
    models: { ...DEFAULTS.models, ...(saved.models || {}) },
  };
}

function saveConfig(cfg) {
  // Keys are deliberately not written here.
  const { providers, models } = cfg;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ providers, models }, null, 2));
}

// What the browser sees: which keys exist, never the keys themselves.
function publicConfig(cfg) {
  const keys = {};
  for (const [name, value] of Object.entries(cfg.keys)) {
    keys[name] = { set: Boolean(value), envVar: KEY_VARS[name] };
  }
  return { keys, providers: cfg.providers, models: cfg.models };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  return buf.length ? JSON.parse(buf.toString('utf8')) : {};
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function requireKey(cfg, name, label) {
  if (!cfg.keys[name]) throw new HttpError(400, `No ${label} key. Set ${KEY_VARS[name]} in .env.`);
  return cfg.keys[name];
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function upstreamError(label, r) {
  let detail = '';
  try { detail = (await r.text()).slice(0, 500); } catch { /* ignore */ }
  return new HttpError(502, `${label} error ${r.status}: ${detail}`);
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

async function chatAnthropic(cfg, { system, messages, maxTokens }) {
  const key = requireKey(cfg, 'anthropic', 'Anthropic');
  const body = {
    model: cfg.models.anthropic,
    max_tokens: maxTokens || 4000,
    system,
    messages,
  };
  if (cfg.models.anthropicEffort) body.output_config = { effort: cfg.models.anthropicEffort };

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await upstreamError('Anthropic', r);
  const data = await r.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function chatXai(cfg, { system, messages, maxTokens }) {
  const key = requireKey(cfg, 'xai', 'xAI (Grok)');
  const body = {
    model: cfg.models.xai,
    max_tokens: maxTokens || 4000,
    messages: [{ role: 'system', content: system }, ...messages],
  };
  if (cfg.models.xaiEffort) body.reasoning_effort = cfg.models.xaiEffort;

  const call = (b) => fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });

  let r = await call(body);
  // Some models reject reasoning_effort; retry once without it.
  if (r.status === 400 && body.reasoning_effort) {
    delete body.reasoning_effort;
    r = await call(body);
  }
  if (!r.ok) throw await upstreamError('xAI', r);
  const data = await r.json();
  return data.choices?.[0]?.message?.content || '';
}

// ---------------------------------------------------------------------------
// Speech to text (audio arrives as WAV from the browser)
// ---------------------------------------------------------------------------

async function sttElevenlabs(cfg, audio, mime) {
  const key = requireKey(cfg, 'elevenlabs', 'ElevenLabs');
  const form = new FormData();
  form.append('model_id', cfg.models.elevenlabsStt);
  form.append('file', new Blob([audio], { type: mime }), 'answer.wav');
  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: form,
  });
  if (!r.ok) throw await upstreamError('ElevenLabs STT', r);
  return (await r.json()).text || '';
}

async function sttXai(cfg, audio, mime) {
  const key = requireKey(cfg, 'xai', 'xAI (Grok)');
  const form = new FormData();
  form.append('model', cfg.models.xaiStt);
  form.append('file', new Blob([audio], { type: mime }), 'answer.wav');
  const r = await fetch('https://api.x.ai/v1/stt', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!r.ok) throw await upstreamError('xAI STT', r);
  return (await r.json()).text || '';
}

// ---------------------------------------------------------------------------
// Text to speech (returns MP3 bytes)
// ---------------------------------------------------------------------------

async function ttsElevenlabs(cfg, text) {
  const key = requireKey(cfg, 'elevenlabs', 'ElevenLabs');
  const voice = encodeURIComponent(cfg.models.elevenlabsVoice);
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: cfg.models.elevenlabsTts }),
  });
  if (!r.ok) throw await upstreamError('ElevenLabs TTS', r);
  return Buffer.from(await r.arrayBuffer());
}

async function ttsXai(cfg, text) {
  const key = requireKey(cfg, 'xai', 'xAI (Grok)');
  const r = await fetch('https://api.x.ai/v1/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: cfg.models.xaiVoice, language: 'en' }),
  });
  if (!r.ok) throw await upstreamError('xAI TTS', r);
  return Buffer.from(await r.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleApi(req, res, pathname) {
  const cfg = loadConfig();

  if (pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, publicConfig(cfg));
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    const patch = await readJson(req);
    if (patch.providers) {
      for (const k of ['inference', 'stt', 'tts']) {
        if (typeof patch.providers[k] === 'string') cfg.providers[k] = patch.providers[k];
      }
    }
    if (patch.models) {
      for (const [k, v] of Object.entries(patch.models)) {
        if (k in cfg.models && typeof v === 'string') cfg.models[k] = v.trim();
      }
    }
    saveConfig(cfg);
    return sendJson(res, 200, publicConfig(cfg));
  }

  if (pathname === '/api/chat' && req.method === 'POST') {
    const input = await readJson(req);
    const fn = { anthropic: chatAnthropic, xai: chatXai }[cfg.providers.inference];
    if (!fn) throw new HttpError(400, 'Choose an inference provider in Settings.');
    const text = await fn(cfg, input);
    return sendJson(res, 200, { text });
  }

  if (pathname === '/api/stt' && req.method === 'POST') {
    const audio = await readBody(req);
    const mime = req.headers['content-type'] || 'audio/wav';
    const fn = { elevenlabs: sttElevenlabs, xai: sttXai }[cfg.providers.stt];
    if (!fn) throw new HttpError(400, 'Server STT is not selected.');
    const text = await fn(cfg, audio, mime);
    return sendJson(res, 200, { text });
  }

  if (pathname === '/api/tts' && req.method === 'POST') {
    const { text } = await readJson(req);
    const fn = { elevenlabs: ttsElevenlabs, xai: ttsXai }[cfg.providers.tts];
    if (!fn) throw new HttpError(400, 'Server TTS is not selected.');
    const audio = await fn(cfg, text);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length });
    return res.end(audio);
  }

  throw new HttpError(404, 'Not found');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (!pathname.startsWith('/api/')) return serveStatic(res, pathname);
  try {
    await handleApi(req, res, pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err.message);
    sendJson(res, status, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Interview Practice running at http://localhost:${PORT}`);
});
