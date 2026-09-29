# Asistente Full Service · Zona Chiloé (web)

Landing de bienvenida con un chat que responde solo con los manuales (Manual FS Giros, Manual Courier App FS, Instructivo Giros) y cita manual y página.

## Probar en tu computador
1. Instala Node 20+ (nodejs.org).
2. `npm install`
3. Consigue una clave GRATIS en https://aistudio.google.com/apikey (cuenta Google). Copia `.env.example` a `.env` y pega la clave en `GEMINI_API_KEY`.
4. `npm start` y abre http://localhost:3000

Sin API key puedes probar la pantalla con `STUB=1 npm start` (respuestas de mentira).

## Publicarlo (gratis: Render.com)
1. Sube esta carpeta a un repositorio de GitHub (sin `.env` ni `node_modules`; ya están en .gitignore).
2. En render.com: New → Web Service → conecta el repo. Build: `npm install`. Start: `npm start`.
3. En Environment agrega:
   - `GEMINI_API_KEY` = tu clave de Google AI Studio
   - `CHAT_ACCESS_KEY` = una clave corta que inventes (ej. `chiloe2026`)
   - `DAILY_MAX` = `300` (tope de consultas por día, controla el gasto)
4. Comparte el link así: `https://TU-APP.onrender.com/?k=chiloe2026`
   Solo quien tenga el link con `?k=` puede usar el chat (evita que cualquiera gaste tu cuenta).

También sirve con el `Dockerfile` en Azure, Railway, Fly.io, etc.

## Actualizar manuales
`python3 scripts/build_kb.py "manual.pdf=Nombre" ...` regenera `data/kb.json`. Luego vuelve a publicar.
Los PDF son mayormente capturas de pantalla, así que algunas páginas tienen poco texto.

## Costos y seguridad
- Usa Gemini (`gemini-2.5-flash`) con el plan gratuito de Google: $0, con límites de consultas por minuto/día (por eso el tope `DAILY_MAX`). Ojo: en el plan gratuito Google puede usar las preguntas para mejorar sus modelos; no se escriben datos de clientes.
- Si un día retiran ese modelo, cambia `MODEL` (ej. `gemini-2.5-flash-lite`).
- Para usar Claude (de pago): `PROVIDER=anthropic` y `ANTHROPIC_API_KEY`.
- Límite de 30 consultas por 10 min por IP y tope diario.
- Cada pregunta queda en `logs/preguntas.jsonl` (usuario anónimo, marca si fue respondida). Revísalo para ver qué falta en los manuales.
- WhatsApp: el código ya trae `/webhook/whatsapp`, pero queda apagado mientras no configures las variables `WHATSAPP_*`.
