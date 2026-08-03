const MAX_FILES = 50;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_TOTAL_SIZE = 90 * 1024 * 1024;
const MAX_THOUGHT_LENGTH = 700;
const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || "https://tyke-life.ch,https://www.tyke-life.ch")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = allowedOrigins(env);
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0] || "*";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "vary": "origin"
  };
}

function isAllowedBrowserOrigin(request, env) {
  const origin = request.headers.get("origin");
  return !origin || allowedOrigins(env).includes(origin);
}

function sanitizeName(value, fallback = "foto") {
  return String(value || fallback)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function extForType(type) {
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  return "jpg";
}

async function listPhotos(request, env) {
  const cors = corsHeaders(request, env);
  const listed = await env.PHOTOS.list({ prefix: "metadata/", limit: 1000 });
  const photos = [];
  for (const object of listed.objects) {
    const metaObject = await env.PHOTOS.get(object.key);
    if (!metaObject) continue;
    try {
      const meta = await metaObject.json();
      photos.push({
        id: meta.id,
        url: new URL("/photo/" + encodeURIComponent(meta.key), request.url).toString(),
        credit: meta.credit || "Tyke Life",
        uploadId: meta.uploadId || "",
        thought: meta.thought || "",
        uploadedAt: meta.uploadedAt,
        width: Number(meta.width || 0),
        height: Number(meta.height || 0)
      });
    } catch (_) {}
  }
  photos.sort((a, b) => String(b.uploadedAt || "").localeCompare(String(a.uploadedAt || "")));
  return json({ photos }, 200, cors);
}

async function servePhoto(request, env, pathname) {
  const cors = corsHeaders(request, env);
  const encoded = pathname.replace(/^\/photo\//, "");
  const key = decodeURIComponent(encoded);
  if (!key || !key.startsWith("photos/")) return json({ error: "Not found" }, 404, cors);
  const object = await env.PHOTOS.get(key);
  if (!object) return json({ error: "Not found" }, 404, cors);
  const headers = new Headers(cors);
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}

async function sendNotification(env, request, upload) {
  if (!env.RESEND_API_KEY) return false;
  const to = env.MAIL_TO || "info@tyke-life.ch";
  const from = env.MAIL_FROM || "Tyke Life Upload <uploads@tyke-life.ch>";
  const links = upload.photos.map(p => new URL("/photo/" + encodeURIComponent(p.key), request.url).toString());
  const subject = `Neue Tyke Life Fotos (${upload.photos.length})`;
  const thoughtLines = upload.thought ? ["", "Gedanken:", upload.thought] : [];
  const text = [
    "Es wurden neue Fotos hochgeladen.",
    "",
    `Credit: ${upload.credit}`,
    `E-Mail: ${upload.email}`,
    `Anzahl: ${upload.photos.length}`,
    ...thoughtLines,
    "",
    ...links
  ].join("\n");
  const thoughtHtml = upload.thought
    ? `<p><strong>Gedanken:</strong><br>${escapeHtml(upload.thought).replace(/\n/g, "<br>")}</p>`
    : "";
  const html = `
    <p>Es wurden neue Fotos hochgeladen.</p>
    <p><strong>Credit:</strong> ${escapeHtml(upload.credit)}<br>
    <strong>E-Mail:</strong> ${escapeHtml(upload.email)}<br>
    <strong>Anzahl:</strong> ${upload.photos.length}</p>
    ${thoughtHtml}
    <ul>${links.map(link => `<li><a href="${link}">${link}</a></li>`).join("")}</ul>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ from, to: [to], subject, text, html, reply_to: upload.email })
  });
  if (!res.ok) {
    console.error("Resend failed", res.status, await res.text());
    return false;
  }
  return true;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
}

async function handleUpload(request, env) {
  const cors = corsHeaders(request, env);
  const form = await request.formData();
  const email = String(form.get("email") || "").trim();
  const name = String(form.get("name") || "").trim();
  const credit = name;
  const thought = String(form.get("thoughts") || "").trim().replace(/\r\n/g, "\n").slice(0, MAX_THOUGHT_LENGTH);
  const files = form.getAll("photos").filter(file => file && typeof file === "object" && "arrayBuffer" in file);
  let dimensions = [];
  try {
    const parsed = JSON.parse(String(form.get("dimensions") || "[]"));
    if (Array.isArray(parsed)) dimensions = parsed;
  } catch (_) {}

  if (!name) return json({ error: "Bitte einen Namen/Credit angeben." }, 400, cors);
  if (name.length > MAX_NAME_LENGTH) return json({ error: "Der Name/Credit ist zu lang." }, 400, cors);
  if (!email || !email.includes("@")) return json({ error: "Bitte eine gültige E-Mail angeben." }, 400, cors);
  if (email.length > MAX_EMAIL_LENGTH) return json({ error: "Die E-Mail-Adresse ist zu lang." }, 400, cors);
  if (!files.length) return json({ error: "Bitte mindestens ein Foto auswählen." }, 400, cors);
  if (files.length > MAX_FILES) return json({ error: `Bitte maximal ${MAX_FILES} Fotos pro Upload.` }, 400, cors);

  let total = 0;
  for (const file of files) {
    total += file.size || 0;
    if (!ALLOWED_TYPES.has(file.type)) return json({ error: "Erlaubt sind nur JPG, PNG und WebP." }, 400, cors);
    if (file.size > MAX_FILE_SIZE) return json({ error: "Ein komprimiertes Foto ist zu gross. Maximum: 5 MB pro Foto." }, 400, cors);
  }
  if (total > MAX_TOTAL_SIZE) return json({ error: "Der Upload ist zu gross. Bitte weniger Fotos gleichzeitig hochladen." }, 400, cors);

  const uploadId = crypto.randomUUID();
  const uploadedAt = new Date().toISOString();
  const saved = [];

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const id = crypto.randomUUID();
    const originalName = sanitizeName(file.name || "foto");
    const width = Math.max(0, Math.min(12000, Math.round(Number(dimensions[index]?.width || 0))));
    const height = Math.max(0, Math.min(12000, Math.round(Number(dimensions[index]?.height || 0))));
    const key = `photos/${uploadedAt.slice(0,10)}/${uploadId}/${id}-${originalName.replace(/\.[^.]+$/, "")}.${extForType(file.type)}`;
    await env.PHOTOS.put(key, file.stream(), {
      httpMetadata: { contentType: file.type },
      customMetadata: { uploadId, credit, email, originalName, thought: thought.slice(0, 1000) }
    });
    const meta = { id, uploadId, key, credit, email, thought, originalName, size: file.size, contentType: file.type, uploadedAt, width, height };
    await env.PHOTOS.put(`metadata/${id}.json`, JSON.stringify(meta), {
      httpMetadata: { contentType: "application/json; charset=utf-8" }
    });
    saved.push(meta);
  }

  const emailSent = await sendNotification(env, request, { uploadId, credit, email, thought, photos: saved });
  return json({ ok: true, emailSent, photos: saved.map(meta => ({
    id: meta.id,
    url: new URL("/photo/" + encodeURIComponent(meta.key), request.url).toString(),
    credit: meta.credit,
    uploadId: meta.uploadId,
    thought: meta.thought || "",
    uploadedAt: meta.uploadedAt,
    width: meta.width,
    height: meta.height
  })) }, 200, cors);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method === "GET" && url.pathname === "/photos") return listPhotos(request, env);
    if (request.method === "GET" && url.pathname.startsWith("/photo/")) return servePhoto(request, env, url.pathname);
    if (request.method === "POST" && url.pathname === "/upload") {
      if (!isAllowedBrowserOrigin(request, env)) return json({ error: "Origin not allowed" }, 403, cors);
      const contentLength = Number(request.headers.get("content-length") || 0);
      if (contentLength > MAX_TOTAL_SIZE + (2 * 1024 * 1024)) return json({ error: "Der Upload ist zu gross." }, 413, cors);
      return handleUpload(request, env);
    }

    return json({ ok: true, service: "tyke-life-upload" }, 200, cors);
  }
};
