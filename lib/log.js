import fs from 'node:fs';
import crypto from 'node:crypto';

const FILE = process.env.LOG_FILE || new URL('../logs/preguntas.jsonl', import.meta.url).pathname;

export function anon(id) {
  return crypto.createHmac('sha256', process.env.LOG_SALT || 'sin-sal').update(String(id)).digest('hex').slice(0, 10);
}

/** Guarda la pregunta para saber qué consultan las oficinas. `respondida` es una estimación: la respuesta trae "Fuente:". */
export function logQuestion({ channel, user, q, a }) {
  try {
    fs.mkdirSync(new URL('../logs/', import.meta.url), { recursive: true });
    const row = { ts: new Date().toISOString(), canal: channel, usuario: anon(user), pregunta: q.slice(0, 300), respondida: /Fuente:/i.test(a || '') };
    fs.appendFileSync(FILE, JSON.stringify(row) + '\n');
  } catch (e) { console.error('log', e.message); }
}
