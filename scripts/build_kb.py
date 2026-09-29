#!/usr/bin/env python3
"""Regenera data/kb.json desde los PDF de los manuales.
Uso: python3 scripts/build_kb.py "Manual FS - Giros.pdf=Manual FS · Giros" "Manual Courier.pdf=Manual Courier · App FS"
Requiere `pdftotext` (paquete poppler-utils)."""
import json, re, subprocess, sys, pathlib

out = []
for arg in sys.argv[1:]:
    pdf, name = arg.split('=', 1)
    txt = subprocess.run(['pdftotext', '-layout', pdf, '-'], capture_output=True, text=True, check=True).stdout
    for i, page in enumerate(txt.split('\f'), 1):
        t = re.sub(r'[ \t]+', ' ', page)
        t = re.sub(r'\n\s*\n+', '\n', t).strip()
        t = re.sub(r'^.*(MAYO 2023|AGENDA).*$', '', t, flags=re.M)
        t = re.sub(r'^\s*Manual\|.*$', '', t, flags=re.M)
        t = re.sub(r'\n\s*\d{1,2}\s*$', '', t)
        t = re.sub(r'\n{2,}', '\n', t).strip()
        if len(t) < 60 or t.count('…') > 8:   # páginas vacías o índices
            continue
        out.append({'d': name, 'p': i, 't': t})
dest = pathlib.Path(__file__).resolve().parent.parent / 'data' / 'kb.json'
dest.write_text(json.dumps(out, ensure_ascii=False), encoding='utf-8')
print(f'{len(out)} fragmentos guardados en {dest}')
