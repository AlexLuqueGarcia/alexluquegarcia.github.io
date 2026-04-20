// POST /api/admin/update-project
// Body: { folder, pinned, info }
// Updates an existing project's info.txt and optionally toggles its pinned
// state in projects.json. Does NOT support renaming folders or changing
// the video — those require delete + re-create.

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

function buildInfoTxt(info) {
  const lines = [];
  const singleFields = ['name', 'client', 'studio', 'type', 'year', 'duration', 'color', 'video', 'frames'];
  for (const k of singleFields) {
    if (info[k] !== undefined && info[k] !== null && info[k] !== '') {
      lines.push(`${k}: ${String(info[k]).trim()}`);
    }
  }
  const multiFields = ['about', 'team', 'credits'];
  for (const k of multiFields) {
    const v = info[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      const bodyLines = String(v).split('\n').map(l => l.trim()).filter(Boolean);
      if (bodyLines.length === 0) continue;
      lines.push(`${k}: ${bodyLines[0]}`);
      for (let i = 1; i < bodyLines.length; i++) lines.push(bodyLines[i]);
    }
  }
  return lines.join('\n') + '\n';
}

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const { folder, pinned, hidden, info } = req.body || {};
  if (!folder || !info) return res.status(400).json({ error: 'folder and info are required' });
  if (!/^[a-z0-9][a-z0-9-_]{0,80}$/.test(folder)) {
    return res.status(400).json({ error: 'Invalid folder' });
  }

  try {
    // 1. Update info.txt — must exist
    const infoPath = `projects/${folder}/info.txt`;
    const existingInfo = await ghGet(infoPath);
    if (!existingInfo) return res.status(404).json({ error: `${infoPath} not found` });

    // Preserve the existing video + frames fields if caller didn't specify them
    // (editing metadata shouldn't require re-uploading the video).
    const preservedKeys = ['video', 'frames'];
    if (existingInfo.content) {
      const existingTxt = Buffer.from(existingInfo.content, 'base64').toString('utf-8');
      preservedKeys.forEach(k => {
        if (!info[k]) {
          const m = existingTxt.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'));
          if (m) info[k] = m[1].trim();
        }
      });
    }

    const infoTxt = buildInfoTxt(info);
    await ghPut(infoPath, infoTxt, `Update ${folder}/info.txt`, existingInfo.sha);

    // 2. Update projects.json if pinned or hidden state changed. Multiple
    //    projects can be pinned simultaneously (order is preserved by the
    //    feed-order endpoint; this endpoint just flips flags in place).
    const manifestPath = 'projects/projects.json';
    const manifestFile = await ghGet(manifestPath);
    if (!manifestFile) return res.status(404).json({ error: 'projects.json not found' });

    let manifest;
    try { manifest = JSON.parse(Buffer.from(manifestFile.content, 'base64').toString('utf-8')); }
    catch { return res.status(500).json({ error: 'projects.json is not valid JSON' }); }

    const idx = manifest.findIndex(e => {
      const name = typeof e === 'string' ? e : e.folder;
      return name === folder;
    });
    if (idx < 0) return res.status(404).json({ error: `${folder} not in projects.json` });

    const currentEntry = manifest[idx];
    const currentPinned = typeof currentEntry === 'object' && !!currentEntry.pinned;
    const currentHidden = typeof currentEntry === 'object' && !!currentEntry.hidden;
    const targetPinned = !!pinned;
    const targetHidden = !!hidden;

    if (currentPinned !== targetPinned || currentHidden !== targetHidden) {
      // Build the new entry — plain string if no flags, object otherwise.
      // This keeps projects.json tidy: projects with no special flags stay
      // as simple strings in the manifest.
      let newEntry;
      if (targetPinned || targetHidden) {
        newEntry = { folder };
        if (targetPinned) newEntry.pinned = true;
        if (targetHidden) newEntry.hidden = true;
      } else {
        newEntry = folder;
      }
      manifest[idx] = newEntry;

      const action = [];
      if (currentPinned !== targetPinned) action.push(targetPinned ? 'pin' : 'unpin');
      if (currentHidden !== targetHidden) action.push(targetHidden ? 'hide' : 'unhide');

      const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
      await ghPut(
        manifestPath,
        manifestJson,
        `${action.join(' + ')} ${folder}`,
        manifestFile.sha,
      );
    }

    return res.status(200).json({ ok: true, folder });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
