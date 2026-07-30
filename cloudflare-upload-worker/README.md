# Tyke Life Upload Worker

Cloudflare Worker fuer Foto-Uploads nach Cloudflare R2. Die bestehende GitHub-Pages-Seite ruft diesen Worker fuer Galerie und Upload auf.

## Was der Worker macht

- `POST /upload`: nimmt Name, E-Mail und bis zu 50 komprimierte Fotos entgegen.
- Speichert die Fotos in R2 unter `photos/...`.
- Speichert Metadaten unter `metadata/...`.
- Sendet pro Upload eine E-Mail an `info@tyke-life.ch` via Resend.
- `GET /photos`: liefert alle Fotos fuer die Galerie.
- `GET /photo/...`: liefert ein einzelnes Foto aus R2.

## Setup

1. Cloudflare R2 aktivieren und Bucket erstellen:

```powershell
npx wrangler r2 bucket create tyke-life-photos
```

2. Resend einrichten:

- Account erstellen
- Domain `tyke-life.ch` verifizieren
- API Key erstellen
- Secret setzen:

```powershell
npx wrangler secret put RESEND_API_KEY
```

3. Deploy:

```powershell
cd cloudflare-upload-worker
npx wrangler deploy
```

4. Nach dem Deploy die Worker-URL in `index.html` ersetzen:

```js
const UPLOAD_API_BASE = "https://DEINE-WORKER-URL.workers.dev";
```

## Hinweise

- Ohne gesetzten `RESEND_API_KEY` werden Fotos gespeichert, aber die E-Mail-Benachrichtigung wird als nicht gesendet markiert.
- Die Website komprimiert Bilder vor dem Upload im Browser zu JPEG. Der Worker akzeptiert JPG, PNG und WebP als Sicherheitsnetz.
- Limits sind im `worker.js` gesetzt: 50 Dateien, 5 MB pro komprimierte Datei, 90 MB pro Upload.