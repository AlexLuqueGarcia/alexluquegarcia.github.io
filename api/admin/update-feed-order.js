// POST /api/admin/update-feed-order
//
// Body: { order: ["2025-bold", "2024-adidas", "2024-olimpic", ...] }
//
// Rewrites projects.json so its array order matches the supplied `order`
// array. Each folder's current flags (pinned, hidden) are preserved —
// this endpoint ONLY reorders; to change flags, use update-project.js.
//
// Why this endpoint exists: projects.json array position determines the
// pin-display order on the landing page (buildFullSequence /
// buildDesktopSequence sort pinned projects by their manifest position).
// So to let the admin control which pinned project appears first, second,
// etc., we need a way to rewrite the whole array order.
//
// Safety: every folder in `order` must already exist in projects.json.
// Folders in the existing manifest but missing from `order` are appended
// at the end (preserving their flags), so partial reorders don't silently
// drop projects.

const { requireAuth, applyCors } = require('./_auth');

const GH_API = 'https://api.github.com';

async function ghGet(path) {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  const res = await fetch(`${GH_API}/repos/${repo}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'portfolio-admin',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} → ${res.status}`);
  return res.json();
}

async function ghPut(path, content, message, sha) {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  const body = {
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
  };
  if (sha) body.sha = sha;
  const res = await fetch(`${GH_API}/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'portfolio-admin',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errTxt = await res.text().catch(() => '');
    throw new Error(`GitHub PUT ${path} → ${res.status} ${errTxt}`);
  }
  return res.json();
}

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const { order } = req.body || {};
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: 'order must be an array of folder names' });
  }
  // Validate folder names — defense against injection in the commit message
  // and against malformed entries corrupting projects.json.
  for (const folder of order) {
    if (typeof folder !== 'string' || !/^[a-z0-9][a-z0-9-_]{0,80}$/.test(folder)) {
      return res.status(400).json({ error: `Invalid folder name: ${folder}` });
    }
  }

  try {
    const manifestPath = 'projects/projects.json';
    const manifestFile = await ghGet(manifestPath);
    if (!manifestFile) return res.status(404).json({ error: 'projects.json not found' });

    let manifest;
    try {
      manifest = JSON.parse(Buffer.from(manifestFile.content, 'base64').toString('utf-8'));
    } catch {
      return res.status(500).json({ error: 'projects.json is not valid JSON' });
    }
    if (!Array.isArray(manifest)) {
      return res.status(500).json({ error: 'projects.json must be an array' });
    }

    // Build a folder → entry lookup from the existing manifest so we can
    // rearrange entries without losing their flags.
    const byFolder = new Map();
    for (const entry of manifest) {
      const folder = typeof entry === 'string' ? entry : entry.folder;
      if (folder) byFolder.set(folder, entry);
    }

    // Every folder in `order` must exist in the current manifest — otherwise
    // we'd be silently creating or referencing ghost projects.
    for (const folder of order) {
      if (!byFolder.has(folder)) {
        return res.status(400).json({ error: `Folder not in projects.json: ${folder}` });
      }
    }

    // Build the new manifest: entries in `order`, then any entries from the
    // old manifest that weren't listed in `order` (appended at the end to
    // preserve them).
    const seen = new Set(order);
    const newManifest = [
      ...order.map(folder => byFolder.get(folder)),
      ...manifest.filter(entry => {
        const folder = typeof entry === 'string' ? entry : entry.folder;
        return !seen.has(folder);
      }),
    ];

    const newJson = JSON.stringify(newManifest, null, 2) + '\n';
    const oldJson = JSON.stringify(manifest, null, 2) + '\n';

    // If nothing actually changed, avoid a pointless commit.
    if (newJson === oldJson) {
      return res.status(200).json({ ok: true, unchanged: true });
    }

    await ghPut(manifestPath, newJson, 'Update feed order', manifestFile.sha);

    return res.status(200).json({ ok: true, count: newManifest.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
