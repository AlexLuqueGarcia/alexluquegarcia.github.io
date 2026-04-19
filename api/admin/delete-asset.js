// POST /api/admin/delete-asset
// Body: { folder, path }
// Deletes a file from Bunny Storage. `path` is relative to the project folder
// — e.g. "01.jpg" for a photo, or "thumbnail/video_003.jpg" for a frame.
// Validates that `path` stays inside the project folder (no ../ escape).

const { requireAuth, applyCors } = require('./_auth');

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const { folder, path } = req.body || {};
  if (!folder || !/^[a-z0-9][a-z0-9-_]{0,80}$/.test(folder)) {
    return res.status(400).json({ error: 'Invalid folder' });
  }
  if (!path || typeof path !== 'string') {
    return res.status(400).json({ error: 'path is required' });
  }
  // Disallow any navigation tokens — paths must be strictly relative filenames
  // optionally inside a single subfolder (thumbnail/video_NNN.jpg).
  if (path.includes('..') || path.startsWith('/') || path.includes('\\')) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  if (!/^([a-z0-9_-]+\/)?[a-z0-9_.-]+$/i.test(path)) {
    return res.status(400).json({ error: 'Invalid path format' });
  }

  const zone = process.env.BUNNY_STORAGE_ZONE;
  const pass = process.env.BUNNY_STORAGE_PASSWORD;
  if (!zone || !pass) return res.status(500).json({ error: 'Bunny Storage not configured' });

  try {
    const delUrl = `https://storage.bunnycdn.com/${zone}/${folder}/${path}`;
    const delRes = await fetch(delUrl, {
      method: 'DELETE',
      headers: { AccessKey: pass },
    });
    if (!delRes.ok && delRes.status !== 404) {
      const errTxt = await delRes.text().catch(() => '');
      return res.status(502).json({ error: `Bunny delete failed: ${delRes.status} ${errTxt}` });
    }
    return res.status(200).json({ ok: true, deleted: path, missing: delRes.status === 404 });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
