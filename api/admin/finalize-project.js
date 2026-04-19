// POST /api/admin/finalize-project
// Body: {
//   folder, pinned,
//   info: { name, client, studio, type, year, duration, color,
//           about, team, credits, video, frames }
// }
//
// Writes the info.txt file for this project and adds the project to
// projects.json. Both operations go through the GitHub Contents API.
// Vercel picks up the repo change via GitHub webhook and redeploys the
// site automatically — no additional action needed.

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

// Serialize an info object into the info.txt format expected by the portfolio.
// Multi-line fields (about/team/credits) are written with continuation lines
// indented, matching how parseInfo() consumes them.
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
      // First line goes on the same line as the key; continuation lines are
      // free-form (parseInfo appends them to the previous key).
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

  const { folder, pinned, info } = req.body || {};
  if (!folder || !info) return res.status(400).json({ error: 'folder and info are required' });
  if (!/^[a-z0-9][a-z0-9-_]{0,80}$/.test(folder)) {
    return res.status(400).json({ error: 'Invalid folder' });
  }

  try {
    // 1. Write info.txt. If it already exists (re-running finalize), we
    // include the existing sha so GitHub allows the update.
    const infoPath = `projects/${folder}/info.txt`;
    const existingInfo = await ghGet(infoPath);
    const infoTxt = buildInfoTxt(info);
    await ghPut(
      infoPath,
      infoTxt,
      existingInfo ? `Update ${folder}/info.txt` : `Add ${folder}/info.txt`,
      existingInfo ? existingInfo.sha : null,
    );

    // 2. Update projects.json — add this folder to the array.
    // If pinned=true, replace any existing pinned entry so only one project
    // is pinned at a time (the portfolio picks the first pinned it finds,
    // but enforcing "only one" here keeps the JSON clean).
    const manifestPath = 'projects/projects.json';
    const manifestFile = await ghGet(manifestPath);
    let manifest = [];
    if (manifestFile) {
      try { manifest = JSON.parse(Buffer.from(manifestFile.content, 'base64').toString('utf-8')); }
      catch { manifest = []; }
    }
    if (!Array.isArray(manifest)) manifest = [];

    // Remove this folder from the manifest if it was already present
    // (keeps the ordering clean when re-running finalize on the same folder)
    manifest = manifest.filter(entry => {
      const name = typeof entry === 'string' ? entry : entry.folder;
      return name !== folder;
    });

    // If this one is pinned, unpin any other entries first
    if (pinned) {
      manifest = manifest.map(entry => {
        if (typeof entry === 'object' && entry.pinned) return entry.folder;
        return entry;
      });
    }

    // Prepend pinned entries (so they always appear first in the JSON),
    // append non-pinned entries. The site's pickStripOrder already reads
    // pinned from metadata, so positioning in JSON is purely cosmetic, but
    // pinning-first matches the convention.
    const newEntry = pinned ? { folder, pinned: true } : folder;
    if (pinned) manifest.unshift(newEntry);
    else manifest.push(newEntry);

    const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
    await ghPut(
      manifestPath,
      manifestJson,
      `Add ${folder} to projects.json`,
      manifestFile ? manifestFile.sha : null,
    );

    return res.status(200).json({ ok: true, folder });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
