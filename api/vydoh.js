// «Выдох»: какие этапы психолог открыл каждому клиенту.
// Хранится только служебное: метка клиента (инициалы), секретный токен и номер открытого этапа.
// Ответы клиента сюда не попадают - они остаются в его браузере.
const crypto = require('crypto');
const KEY = 'vydoh:clients';
const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const kvTok = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const blobTok = process.env.BLOB_READ_WRITE_TOKEN;
const blobOn = !!(blobTok || process.env.BLOB_STORE_ID);
const tk = () => (blobTok ? { token: blobTok } : {});
const PSY_KEY = process.env.PSY_KEY || '';

async function kv(cmd) {
  const r = await fetch(kvUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + kvTok, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error('kv ' + r.status);
  return (await r.json()).result;
}
async function load() {
  if (kvUrl && kvTok) { const v = await kv(['GET', KEY]); return v ? JSON.parse(v) : []; }
  if (blobOn) {
    const { get } = require('@vercel/blob');
    const pre = 'vydoh/' + (process.env.STORE_PREFIX || 'p') + '/';
    const r = await get(pre + 'clients.json', { access: process.env.BLOB_ACCESS || 'private', useCache: false, ...tk() }).catch(() => null);
    if (!r || !r.stream) return [];
    const txt = await new Response(r.stream).text();
    try { return JSON.parse(txt) } catch (e) { return [] }
  }
  throw Object.assign(new Error('no-store'), { code: 503 });
}
async function store(arr) {
  if (kvUrl && kvTok) return kv(['SET', KEY, JSON.stringify(arr)]);
  if (blobOn) {
    const { put } = require('@vercel/blob');
    const pre = 'vydoh/' + (process.env.STORE_PREFIX || 'p') + '/';
    return put(pre + 'clients.json', JSON.stringify(arr), { access: process.env.BLOB_ACCESS || 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 0, ...tk() });
  }
  throw Object.assign(new Error('no-store'), { code: 503 });
}
const pub = c => ({ id: c.id, label: c.label, token: c.token, stage: c.stage, informal: !!c.informal, created: c.created, seen: c.seen || null });

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Psy-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const q = req.query || {};
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch (e) { body = {} } }
    const a = q.a || body.a;
    if (a === 'ping') return res.status(200).json({ ok: true, store: !!((kvUrl && kvTok) || blobOn), key: !!PSY_KEY });
    if (a === 'client') {
      const t = String(q.t || '');
      if (!/^[a-f0-9]{24,}$/.test(t)) return res.status(400).json({ error: 'bad' });
      const arr = await load();
      const c = arr.find(x => x.token === t);
      if (!c) return res.status(404).json({ error: 'nf' });
      const today = new Date().toISOString().slice(0, 10);
      if (c.seen !== today) { c.seen = today; await store(arr).catch(() => {}); }
      return res.status(200).json({ label: c.label, stage: c.stage, informal: !!c.informal });
    }
    // дальше только для психолога
    const key = req.headers['x-psy-key'] || body.key;
    if (!PSY_KEY || key !== PSY_KEY) return res.status(401).json({ error: 'key' });
    const arr = await load();
    if (a === 'list') return res.status(200).json({ clients: arr.map(pub) });
    if (a === 'add') {
      const label = String(body.label || '').trim().slice(0, 40);
      if (!label) return res.status(400).json({ error: 'label' });
      const c = { id: crypto.randomBytes(6).toString('hex'), label, token: crypto.randomBytes(16).toString('hex'), stage: 1, created: new Date().toISOString().slice(0, 10) };
      arr.push(c); await store(arr); return res.status(200).json({ client: pub(c) });
    }
    if (a === 'set') {
      const c = arr.find(x => x.id === body.id); if (!c) return res.status(404).json({ error: 'nf' });
      if (body.stage != null) c.stage = Math.max(1, Math.min(9, parseInt(body.stage, 10) || 1));
      if (body.informal != null) c.informal = !!body.informal;
      await store(arr); return res.status(200).json({ client: pub(c) });
    }
    if (a === 'del') {
      const i = arr.findIndex(x => x.id === body.id); if (i < 0) return res.status(404).json({ error: 'nf' });
      arr.splice(i, 1); await store(arr); return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'action' });
  } catch (e) {
    return res.status(e.code === 503 ? 503 : 500).json({ error: e.code === 503 ? 'no-store' : 'server' });
  }
};
