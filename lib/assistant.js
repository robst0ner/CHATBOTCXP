import fs from 'node:fs';

const KB = JSON.parse(fs.readFileSync(new URL('../data/kb.json', import.meta.url), 'utf8'));
const KB_TEXT = KB.map(c => `### [${c.d} · pág. ${c.p}]\n${c.t}`).join('\n\n');
const PROVIDER = (process.env.PROVIDER || 'gemini').toLowerCase(); // gemini (gratis) | anthropic
const MODEL = process.env.MODEL || (PROVIDER === 'gemini' ? 'gemini-3.5-flash-lite' : 'claude-sonnet-5');
const GEMINI_BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const CONTACTO = 'tu supervisor zonal, Roberto Dumenes, por WhatsApp al +56 9 6591 4945';

function rules(channel) {
  const formato = channel === 'whatsapp'
    ? '- Estás respondiendo por WhatsApp: máximo unos 900 caracteres, frases cortas. Puedes usar **negrita** y listas numeradas.'
    : '- Estás respondiendo en un chat web: breve y práctico. Puedes usar **negrita** con moderación y listas numeradas.';
  return `Eres el asistente de las oficinas Full Service de Chilexpress en la zona Chiloé. Respondes dudas de operadores sobre la app Full Service, Giros y Courier.

REGLAS:
- Responde SOLO con información de los MANUALES que vienen abajo. No inventes pasos, montos, plazos, teléfonos ni nombres de botones.
- Si la respuesta no está en los manuales, dilo en una frase y sugiere contactar a ${CONTACTO}. No adivines y no escribas la línea "Fuente:".
- Responde en español de Chile, tuteando. Si es un procedimiento, usa pasos numerados con los nombres exactos de los botones entre comillas.
- Si respondes con información de los manuales, termina SIEMPRE con una línea que empiece con "Fuente:" indicando manual y página, por ejemplo: Fuente: Manual FS · Giros, pág. 35.
- Si la pregunta no es sobre la operación Full Service, responde amablemente que solo puedes ayudar con la app, Giros y Courier.
- No pidas ni repitas datos personales de clientes (RUT, teléfonos, direcciones). Si te los envían, recuerda que no deben compartirse por este canal.
- No uses encabezados ni tablas.
${formato}`;
}

/** Limpia el historial recibido: solo user/assistant, texto corto, empieza y termina en user. */
export function cleanTurns(arr) {
  if (!Array.isArray(arr)) return null;
  let t = arr
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.trim().slice(0, 800) }))
    .slice(-8);
  while (t.length && t[0].role !== 'user') t.shift();
  if (!t.length || t[t.length - 1].role !== 'user') return null;
  return t;
}

async function askGemini(turns, channel) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Falta GEMINI_API_KEY');
  const body = {
    systemInstruction: { parts: [{ text: rules(channel) + '\n\nMANUALES:\n' + KB_TEXT }] },
    contents: turns.map(t => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.content }] })),
    generationConfig: { maxOutputTokens: 1024, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
  };
  const r = await fetch(`${GEMINI_BASE}/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${data?.error?.message || 'error'}`);
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini devolvió respuesta vacía (' + (data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || '?') + ')');
  return { text, usage: data.usageMetadata || null };
}

let client;
async function askAnthropic(turns, channel) {
  if (!client) { const { default: Anthropic } = await import('@anthropic-ai/sdk'); client = new Anthropic(); }
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 700,
    system: [
      { type: 'text', text: rules(channel) },
      { type: 'text', text: 'MANUALES:\n' + KB_TEXT, cache_control: { type: 'ephemeral' } },
    ],
    messages: turns,
  });
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  return { text, usage: res.usage };
}

export async function answer(turns, { channel = 'web' } = {}) {
  if (process.env.STUB === '1') {
    return { text: '[modo prueba] Respuesta de ejemplo.\nFuente: Manual FS · Giros, pág. 1', usage: null };
  }
  return PROVIDER === 'anthropic' ? askAnthropic(turns, channel) : askGemini(turns, channel);
}

export const FRIENDLY_ERROR = `No pude responder en este momento. Intenta de nuevo en unos minutos o escribe a ${CONTACTO}.`;
export const kbInfo = { chunks: KB.length, provider: PROVIDER, model: MODEL };
