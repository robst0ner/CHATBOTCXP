import crypto from 'node:crypto';

/** Verifica la firma X-Hub-Signature-256 que Meta agrega a cada llamada. */
export function verifySignature(rawBody, header, appSecret) {
  if (!rawBody || !header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
}

/** Extrae los mensajes entrantes del JSON de Meta. Ignora estados de entrega. */
export function parseIncoming(body) {
  const out = [];
  for (const entry of body?.entry ?? []) {
    for (const ch of entry?.changes ?? []) {
      for (const m of ch?.value?.messages ?? []) {
        out.push({ id: m.id, from: m.from, type: m.type, text: m.type === 'text' ? m.text?.body ?? '' : '' });
      }
    }
  }
  return out;
}

/** WhatsApp usa *negrita* con un asterisco. */
export function toWhatsAppFormat(s) {
  return s.replace(/\*\*(.+?)\*\*/g, '*$1*').slice(0, 4000);
}

export const outbox = []; // solo se usa en modo prueba (WHATSAPP_DRY_RUN=1)

export async function sendText(to, body) {
  if (process.env.WHATSAPP_DRY_RUN === '1') { outbox.push({ to, body }); return; }
  const url = `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v21.0'}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body, preview_url: false } }),
  });
  if (!r.ok) throw new Error(`WhatsApp API ${r.status}: ${(await r.text()).slice(0, 300)}`);
}
