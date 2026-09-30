import express from 'express';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
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
