import express from 'express';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { answer, cleanTurns, FRIENDLY_ERROR, kbInfo } from './lib/assistant.js';
import { verifySignature, parseIncoming, sendText, toWhatsAppFormat, outbox } from './lib/whatsapp.js';
import { logQuestion } from './lib/log.js';

const app = express();
app.set('trust proxy', 1); // detrás de Render/Azure/Cloudflare, para leer la IP real
const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

app.use(express.json({ limit: '30kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: false }));

// ---------- Login simple (una sola clave compartida, protege toda la página) ----------
// Se activa solo si defines SITE_PASSWORD en las variables de entorno. Sin ella, el sitio queda abierto.
const SITE_PASSWORD = env.SITE_PASSWORD || '';
const AUTH_TOKEN = SITE_PASSWORD ? crypto.createHmac('sha256', SITE_PASSWORD).update('fs-auth-v1').digest('hex') : '';
function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}
function isAuthed(req) { return !SITE_PASSWORD || getCookie(req, 'fs_auth') === AUTH_TOKEN; }

function loginPage(error) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ingresar · Full Service Chiloé</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0A0A0A;font-family:'Segoe UI',Arial,sans-serif;color:#1F1F1F;padding:20px}
.box{width:100%;max-width:360px;background:#FFF;border-top:8px solid #FFE600;border-radius:12px;padding:28px 24px;box-shadow:0 14px 40px rgba(0,0,0,.35)}
h1{margin:0 0 4px;font-size:20px;font-weight:900}p{margin:0 0 18px;font-size:13px;color:#6A6A6A}
label{display:block;font-size:12px;font-weight:800;text-transform:uppercase;color:#6A6A6A;margin-bottom:6px}
input{width:100%;font-size:16px;padding:11px 12px;border:1px solid #CFCFCF;border-radius:9px;background:#F6F6F4}
input:focus{outline:3px solid #1B6BD1;outline-offset:1px}
button{width:100%;margin-top:14px;font-weight:800;font-size:15px;background:#0A0A0A;color:#FFE600;border:0;border-radius:9px;padding:12px;cursor:pointer}
.err{background:#FDECEC;color:#B02020;border-radius:8px;padding:9px 11px;font-size:13px;margin-bottom:14px}
</style></head><body><form class="box" method="POST" action="/login">
<h1>Full Service · Zona Chiloé</h1><p>Ingresa la clave para acceder.</p>
${error ? '<div class="err">' + error + '</div>' : ''}
<label for="p">Clave</label>
<input id="p" name="password" type="password" autofocus autocomplete="current-password" required>
<button type="submit">Entrar</button>
</form></body></html>`;
}

const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: 'Demasiados intentos. Espera unos minutos.' });
app.get('/login', (req, res) => { if (isAuthed(req)) return res.redirect('/'); res.send(loginPage('')); });
app.post('/login', loginLimiter, (req, res) => {
  if (SITE_PASSWORD && req.body?.password === SITE_PASSWORD) {
    res.cookie('fs_auth', AUTH_TOKEN, { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
    return res.redirect('/');
  }
  res.status(401).send(loginPage('Clave incorrecta. Inténtalo de nuevo.'));
});
app.get('/logout', (_req, res) => { res.clearCookie('fs_auth'); res.redirect('/login'); });

// Puerta: exige sesión para todo, salvo el propio login, /health y el webhook de WhatsApp.
app.use((req, res, next) => {
  if (isAuthed(req) || req.method === 'OPTIONS') return next();
  const p = req.path;
  if (p === '/login' || p === '/logout' || p === '/health' || p.startsWith('/webhook')) return next();
  if (p.startsWith('/api')) {
    if (env.CHAT_ACCESS_KEY && req.get('x-access-key') === env.CHAT_ACCESS_KEY) return next();
    return res.status(401).json({ error: 'Sesión requerida. Inicia sesión en la página.' });
  }
  res.send(loginPage(''));
});

// ---------- Tope diario de consultas (control de costos) ----------
const DAILY_MAX = Number(env.DAILY_MAX || 500);
let day = new Date().toISOString().slice(0, 10), count = 0;
function underDailyCap() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; count = 0; }
  return ++count <= DAILY_MAX;
}

// ---------- API web ----------
app.use('/api', (req, res, next) => {
  const o = req.headers.origin;
  if (o && allowed.includes(o)) {
    res.set({ 'Access-Control-Allow-Origin': o, Vary: 'Origin', 'Access-Control-Allow-Headers': 'content-type,x-access-key', 'Access-Control-Allow-Methods': 'POST,OPTIONS' });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiadas consultas seguidas. Intenta de nuevo en unos minutos.' },
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  if (env.CHAT_ACCESS_KEY && req.get('x-access-key') !== env.CHAT_ACCESS_KEY) {
    return res.status(401).json({ error: 'Acceso no autorizado. Abre la página con el enlace que te entregó tu supervisor.' });
  }
  const turns = cleanTurns(req.body?.messages);
  if (!turns) return res.status(400).json({ error: 'Escribe una pregunta.' });
  if (!underDailyCap()) return res.status(429).json({ error: 'Se alcanzó el límite de consultas de hoy. Escribe a tu supervisor por WhatsApp.' });
  try {
    const { text } = await answer(turns, { channel: 'web' });
    logQuestion({ channel: 'web', user: req.ip, q: turns[turns.length - 1].content, a: text });
    res.json({ text });
  } catch (e) {
    console.error('chat', e?.status || '', e?.message);
    const limited = /429|quota|rate|exhaust|resource has been|limit/i.test(e?.message || '');
    if (limited) return res.status(429).json({ error: 'Se alcanzó el límite de consultas por ahora (servicio gratuito). Prueba de nuevo en un rato o escribe a tu supervisor por WhatsApp al +56 9 6591 4945.' });
    res.status(502).json({ error: FRIENDLY_ERROR });
  }
});

// ---------- WhatsApp (Meta Cloud API) ----------
app.get('/webhook/whatsapp', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': tok, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && env.WHATSAPP_VERIFY_TOKEN && tok === env.WHATSAPP_VERIFY_TOKEN) return res.status(200).send(String(challenge));
  res.sendStatus(403);
});

const sessions = new Map();          // teléfono -> { turns, ts }
const seen = new Set(); const seenQ = []; // ids ya procesados (Meta reintenta)
const SESSION_TTL = 30 * 60 * 1000;

function remember(id) {
  seen.add(id); seenQ.push(id);
  if (seenQ.length > 5000) seen.delete(seenQ.shift());
}

async function handleIncoming(m) {
  if (seen.has(m.id)) return;
  remember(m.id);
  if (m.type !== 'text' || !m.text.trim()) {
    return sendText(m.from, 'Por ahora solo puedo leer mensajes de texto. Escríbeme tu duda sobre la app, Giros o Courier.');
  }
  const now = Date.now();
  let s = sessions.get(m.from);
  if (!s || now - s.ts > SESSION_TTL) s = { turns: [], ts: now };
  s.turns.push({ role: 'user', content: m.text.trim().slice(0, 800) });
  s.turns = s.turns.slice(-6); s.ts = now;
  sessions.set(m.from, s);
  if (!underDailyCap()) return sendText(m.from, 'Hoy se alcanzó el límite de consultas. Escribe a tu supervisor zonal, Roberto Dumenes, al +56 9 6591 4945.');
  try {
    const turns = cleanTurns(s.turns);
    const { text } = await answer(turns, { channel: 'whatsapp' });
    s.turns.push({ role: 'assistant', content: text });
    logQuestion({ channel: 'whatsapp', user: m.from, q: m.text, a: text });
    await sendText(m.from, toWhatsAppFormat(text));
  } catch (e) {
    console.error('whatsapp', e?.status || '', e?.message);
    s.turns.pop(); // no dejar la pregunta sin respuesta en el historial
    try { await sendText(m.from, FRIENDLY_ERROR); } catch (e2) { console.error('whatsapp send', e2.message); }
  }
}

app.post('/webhook/whatsapp', (req, res) => {
  if (env.WHATSAPP_APP_SECRET && !verifySignature(req.rawBody, req.get('x-hub-signature-256'), env.WHATSAPP_APP_SECRET)) {
    return res.sendStatus(401);
  }
  res.sendStatus(200); // Meta exige responder rápido; el resto se procesa aparte
  for (const m of parseIncoming(req.body)) handleIncoming(m).catch(e => console.error('handle', e.message));
});

// Solo para pruebas automáticas
if (env.WHATSAPP_DRY_RUN === '1') app.get('/_debug/outbox', (_req, res) => res.json(outbox));

app.get('/health', (_req, res) => res.json({ ok: true, ...kbInfo, whatsapp: Boolean(env.WHATSAPP_TOKEN) }));
app.use(express.static(path.join(here, 'public')));

const port = Number(env.PORT || 3000);
if (env.STUB !== '1') {
  if ((env.PROVIDER || 'gemini').toLowerCase() === 'anthropic') { if (!env.ANTHROPIC_API_KEY) console.warn('⚠ Falta ANTHROPIC_API_KEY.'); }
  else if (!env.GEMINI_API_KEY) console.warn('⚠ Falta GEMINI_API_KEY: el asistente no podrá responder.');
}
if (env.WHATSAPP_TOKEN && !env.WHATSAPP_APP_SECRET) console.warn('⚠ WhatsApp activo sin WHATSAPP_APP_SECRET: cualquiera podría enviar mensajes falsos al webhook.');
app.listen(port, () => console.log(`Asistente Full Service escuchando en http://localhost:${port}`));
