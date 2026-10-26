// sharky-games: serves multi-file HTML game builds from R2 and handles admin zip uploads.
// Layout in R2:  builds/<gameId>/v<version>/<path>   uploads/<gameId>/v<version>.zip (temporary)
import { Unzip, UnzipInflate } from 'fflate';

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json',
  wasm: 'application/wasm', data: 'application/octet-stream', pck: 'application/octet-stream',
  bin: 'application/octet-stream', mem: 'application/octet-stream', symbols: 'application/octet-stream',
  unityweb: 'application/octet-stream', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', txt: 'text/plain; charset=utf-8',
  xml: 'application/xml', glb: 'model/gltf-binary', gltf: 'model/gltf+json', atlas: 'text/plain; charset=utf-8',
};
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_FILES = 5000;
const MAX_TOTAL = 2 * 1024 ** 3; // 2 GB unpacked

function typeFor(path) {
  let p = path.toLowerCase(), enc = null;
  if (p.endsWith('.br')) { enc = 'br'; p = p.slice(0, -3); }
  else if (p.endsWith('.gz')) { enc = 'gzip'; p = p.slice(0, -3); }
  const ext = p.split('.').pop();
  return { type: TYPES[ext] || 'application/octet-stream', enc };
}

// Reject traversal, absolute paths, odd chars. Returns normalized path or null.
function safePath(p) {
  if (!p || p.includes('\\') || p.includes('\0') || p.startsWith('/')) return null;
  const parts = p.split('/');
  if (parts.some((s) => s === '..' || s === '.' || s === '')) return null;
  if (parts.some((s) => s.startsWith('__MACOSX') || s === '.DS_Store')) return null;
  return p;
}

function cors(req, env) {
  const o = req.headers.get('Origin') || '';
  const ok = env.PLATFORM_ORIGINS.split(/\s+/).includes(o);
  return ok ? { 'Access-Control-Allow-Origin': o, 'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Max-Age': '86400' } : {};
}
const json = (obj, status, h) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...h } });

// Admin-only for now. Later: allow game authors (check games.author_id) — single place to change.
async function requireUploader(req, env, gameId) {
  if (env.DEV_NO_AUTH === '1') return null; // local wrangler dev only, never set in prod
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return 'no token';
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/is_admin`, {
    method: 'POST', headers: { apikey: env.SUPABASE_ANON, Authorization: auth, 'Content-Type': 'application/json' }, body: '{}' });
  if (!r.ok) return 'auth ' + r.status;
  return (await r.json()) === true ? null : 'not admin';
}

async function serve(req, env, url) {
  // /g/<id>/v<ver>/<path>
  const m = url.pathname.match(/^\/g\/([A-Za-z0-9_-]{1,64})\/(v\d{1,6})(\/.*)?$/);
  if (!m) return new Response('Not found', { status: 404 });
  if (!m[3]) return Response.redirect(url.origin + url.pathname + '/' + url.search, 301);
  let rel; try { rel = decodeURIComponent(m[3].slice(1)); } catch { return new Response('Bad path', { status: 400 }); }
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  if (!safePath(rel)) return new Response('Bad path', { status: 400 });
  const obj = await env.BUILDS.get(`builds/${m[1]}/${m[2]}/${rel}`, { range: req.headers, onlyIf: req.headers });
  if (!obj) return new Response('Not found', { status: 404 });
  const { type, enc } = typeFor(rel);
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('Content-Type', type);
  if (enc) h.set('Content-Encoding', enc);
  h.set('ETag', obj.httpEtag);
  h.set('Cache-Control', 'public, max-age=31536000, immutable'); // versioned paths never change
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  h.set('X-Content-Type-Options', 'nosniff');
  if (type.startsWith('text/html')) {
    // Game-domain CSP: games may load anything they need, but only the platform may embed them.
    h.set('Content-Security-Policy', `default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https:; style-src 'self' 'unsafe-inline' https:; img-src * data: blob:; media-src * data: blob:; connect-src *; worker-src 'self' blob:; frame-ancestors ${env.PLATFORM_ORIGINS}; base-uri 'self'; form-action 'none'`);
  }
  if (!('body' in obj)) return new Response(null, { status: 304, headers: h });
  const status = req.headers.has('Range') && obj.range ? 206 : 200;
  if (status === 206) h.set('Content-Range', `bytes ${obj.range.offset}-${obj.range.offset + obj.range.length - 1}/${obj.size}`);
  return new Response(obj.body, { status, headers: h, encodeBody: enc ? 'manual' : 'automatic' });
}

async function unpack(env, gameId, ver, zipKey) {
  const zobj = await env.BUILDS.get(zipKey);
  if (!zobj) throw new Error('zip not found');
  const files = []; // {name, data}
  let total = 0, err = null;
  const unz = new Unzip((f) => {
    if (f.name.endsWith('/')) return;
    const chunks = [];
    f.ondata = (e, d, final) => {
      if (e) { err = e; return; }
      chunks.push(d); total += d.length;
      if (total > MAX_TOTAL) err = new Error('build too large');
      if (final) files.push({ name: f.name, chunks });
    };
    f.start();
  });
  unz.register(UnzipInflate);
  const reader = zobj.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (err) throw err;
    if (done) { unz.push(new Uint8Array(0), true); break; }
    unz.push(value);
  }
  if (err) throw err;
  const names = files.map((f) => f.name).filter((n) => !n.split('/').some((s) => s.startsWith('__MACOSX')));
  if (names.length > MAX_FILES) throw new Error('too many files');
  // index.html closest to the root becomes the build root
  const idx = names.filter((n) => /(^|\/)index\.html?$/i.test(n)).sort((a, b) => a.split('/').length - b.split('/').length)[0];
  if (!idx) throw new Error('index.html not found in zip');
  const root = idx.slice(0, idx.lastIndexOf('/') + 1);
  const prefix = `builds/${gameId}/v${ver}/`;
  let count = 0, size = 0;
  for (const f of files) {
    if (!f.name.startsWith(root)) continue;
    const rel = safePath(f.name.slice(root.length));
    if (!rel) continue;
    const { type, enc } = typeFor(rel);
    const data = new Blob(f.chunks);
    await env.BUILDS.put(prefix + rel, data, { httpMetadata: { contentType: type, contentEncoding: enc || undefined } });
    count++; size += data.size; f.chunks = null;
  }
  await env.BUILDS.delete(zipKey);
  return { entry: idx.slice(root.length), files: count, size };
}

async function api(req, env, url) {
  const c = cors(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c });
  const q = url.searchParams;
  const gameId = q.get('game_id'), ver = q.get('version');
  if (!ID_RE.test(gameId || '') || !/^\d{1,6}$/.test(ver || '')) return json({ error: 'bad game_id/version' }, 400, c);
  const denied = await requireUploader(req, env, gameId);
  if (denied) return json({ error: denied }, 403, c);
  const zipKey = `uploads/${gameId}/v${ver}.zip`;
  const op = url.pathname.slice('/api/upload/'.length);
  try {
    if (op === 'start' && req.method === 'POST') {
      const mp = await env.BUILDS.createMultipartUpload(zipKey);
      return json({ uploadId: mp.uploadId, key: zipKey }, 200, c);
    }
    if (op === 'part' && req.method === 'PUT') {
      const mp = env.BUILDS.resumeMultipartUpload(zipKey, q.get('upload_id'));
      const part = await mp.uploadPart(Number(q.get('part')), req.body);
      return json(part, 200, c);
    }
    if (op === 'complete' && req.method === 'POST') {
      const { uploadId, parts } = await req.json();
      await env.BUILDS.resumeMultipartUpload(zipKey, uploadId).complete(parts);
      const r = await unpack(env, gameId, ver, zipKey);
      return json({ ...r, src: `${url.origin}/g/${gameId}/v${ver}/${r.entry}` }, 200, c);
    }
    if (op === 'abort' && req.method === 'POST') {
      const { uploadId } = await req.json();
      await env.BUILDS.resumeMultipartUpload(zipKey, uploadId).abort();
      return json({ ok: true }, 200, c);
    }
  } catch (e) { return json({ error: String(e.message || e) }, 400, c); }
  return json({ error: 'unknown op' }, 404, c);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/upload/')) return api(req, env, url);
    if (url.pathname === '/') return new Response('sharky-games', { headers: { 'Content-Type': 'text/plain' } });
    return serve(req, env, url);
  },
};
