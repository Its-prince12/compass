/* Compass cloud backup: stores encrypted backup envelopes in Vercel Blob.
   The envelope is encrypted in the browser (AES-GCM, passphrase only the user
   knows) - this function only ever sees opaque base64. Backups are versioned
   by timestamp; old ones are pruned to the latest 30. */
const BLOB_API = 'https://blob.vercel-storage.com';
const PREFIX = 'backups/compass-';
const KEEP = 30;

function token() {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  if (!t) throw new Error('backup storage is not configured');
  return t;
}
async function blob(path, opts = {}) {
  const r = await fetch(BLOB_API + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token(), 'x-api-version': '7', ...(opts.headers || {}) }
  });
  return r;
}
const tsOf = p => Number((p.match(/compass-(\d+)-/) || [])[1] || 0);

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      let body;
      try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
      catch { return res.status(400).json({ error: 'Invalid JSON' }); }
      const data = body && typeof body.data === 'string' ? body.data : '';
      if (!data || data.length > 2_000_000) return res.status(400).json({ error: 'Bad backup data' });
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      const pathname = `${PREFIX}${ts}-${rand}.json`;
      const put = await blob('/' + pathname, {
        method: 'PUT',
        headers: { 'x-content-type': 'application/json', 'x-access': 'private' },
        body: data
      });
      if (!put.ok) return res.status(502).json({ error: 'Storage upload failed (' + put.status + ')' });
      // prune old backups, keep latest KEEP
      try {
        const lr = await blob('/?prefix=' + encodeURIComponent('backups/') + '&limit=100');
        if (lr.ok) {
          const j = await lr.json();
          const olds = (j.blobs || []).map(b => b.pathname || b.url).filter(p => p && p.includes('/compass-'))
            .sort((a, b) => tsOf(b) - tsOf(a)).slice(KEEP);
          for (const p of olds) {
            const name = p.split('/').pop();
            await blob('/' + name, { method: 'DELETE' }).catch(() => {});
          }
        }
      } catch {}
      return res.status(200).json({ ok: true, ts });
    }
    if (req.method === 'GET') {
      const action = (req.query && req.query.action) || 'list';
      if (action === 'list') {
        const lr = await blob('/?prefix=' + encodeURIComponent('backups/') + '&limit=100');
        if (!lr.ok) return res.status(502).json({ error: 'Storage list failed (' + lr.status + ')' });
        const j = await lr.json();
        const items = (j.blobs || [])
          .map(b => ({ ts: tsOf(b.pathname || ''), size: b.size || 0, url: b.url }))
          .filter(x => x.ts > 0)
          .sort((a, b) => b.ts - a.ts);
        return res.status(200).json({ backups: items });
      }
      if (action === 'get') {
        const ts = String((req.query && req.query.ts) || '');
        if (!/^\d+$/.test(ts)) return res.status(400).json({ error: 'Bad timestamp' });
        const lr = await blob('/?prefix=' + encodeURIComponent(PREFIX + ts) + '&limit=5');
        if (!lr.ok) return res.status(502).json({ error: 'Storage list failed' });
        const j = await lr.json();
        const hit = (j.blobs || [])[0];
        if (!hit) return res.status(404).json({ error: 'Backup not found' });
        const dr = await fetch(hit.url);
        if (!dr.ok) return res.status(502).json({ error: 'Download failed' });
        return res.status(200).json({ ts: Number(ts), data: await dr.text() });
      }
      return res.status(400).json({ error: 'Unknown action' });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(503).json({ error: e.message || 'Backup service unavailable' });
  }
}
