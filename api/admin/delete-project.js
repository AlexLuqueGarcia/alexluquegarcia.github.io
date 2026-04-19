// POST /api/admin/delete-project
// Body: { folder, deleteBunnyAssets?: boolean }
// Removes the project from projects.json and deletes its info.txt from the
// GitHub repo. If deleteBunnyAssets is true, also attempts to delete the
// Bunny Storage folder (thumbnails) and the Bunny Stream video.
//
// Bunny cleanup is best-effort — a failure there doesn't fail the whole
// delete. The GitHub changes are what actually remove the project from
// the live site; Bunny assets are just storage cost if left behind.

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
  if (!res.ok) throw new Error(`GitHub PUT ${path} → ${res.status}`);
  return res.json();
}

async function ghDelete(path, message, sha) {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  const res = await fetch(`${GH_API}/repos/${repo}/contents/${path}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'portfolio-admin',
    },
    body: JSON.stringify({ message, sha }),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`GitHub DELETE ${path} → ${res.status}`);
  }
  return true;
}

// List all files in a GitHub folder (non-recursive). Used to wipe the
// project folder during delete — info.txt and any other loose files.
async function ghListFolder(path) {
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
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub list ${path} → ${res.status}`);
  const items = await res.json();
  return Array.isArray(items) ? items : [];
}

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const { folder, deleteBunnyAssets } = req.body || {};
  if (!folder || !/^[a-z0-9][a-z0-9-_]{0,80}$/.test(folder)) {
    return res.status(400).json({ error: 'Invalid folder' });
  }

  const errors = [];

  try {
    // 1. Remove from projects.json
    const manifestPath = 'projects/projects.json';
    const manifestFile = await ghGet(manifestPath);
    if (manifestFile) {
      let manifest;
      try { manifest = JSON.parse(Buffer.from(manifestFile.content, 'base64').toString('utf-8')); }
      catch { manifest = []; }
      if (Array.isArray(manifest)) {
        const filtered = manifest.filter(e => {
          const name = typeof e === 'string' ? e : e.folder;
          return name !== folder;
        });
        if (filtered.length !== manifest.length) {
          const manifestJson = JSON.stringify(filtered, null, 2) + '\n';
          await ghPut(manifestPath, manifestJson, `Remove ${folder} from projects.json`, manifestFile.sha);
        }
      }
    }

    // 2. Delete every file inside projects/{folder}/ from the GitHub repo
    // (so the folder stops existing on the next Vercel deploy).
    const folderFiles = await ghListFolder(`projects/${folder}`);
    for (const f of folderFiles) {
      try { await ghDelete(f.path, `Delete ${f.path}`, f.sha); }
      catch (e) { errors.push(`github: ${e.message}`); }
    }

    // 3. (Optional) Delete Bunny assets. Best-effort — doesn't fail the
    // delete if these error out, since the site is already updated.
    if (deleteBunnyAssets) {
      // 3a. Delete the Bunny Storage folder (thumbnails etc.)
      const zone = process.env.BUNNY_STORAGE_ZONE;
      const storagePass = process.env.BUNNY_STORAGE_PASSWORD;
      if (zone && storagePass) {
        try {
          // Bunny Storage supports folder delete by sending DELETE to a
          // trailing-slashed path.
          const delRes = await fetch(
            `https://storage.bunnycdn.com/${zone}/${folder}/`,
            { method: 'DELETE', headers: { AccessKey: storagePass } }
          );
          if (!delRes.ok && delRes.status !== 404) {
            errors.push(`bunny-storage: ${delRes.status}`);
          }
        } catch (e) {
          errors.push(`bunny-storage: ${e.message}`);
        }
      }

      // 3b. Delete the Bunny Stream video(s) — we don't have the GUID on
      // hand so this is skipped. A future enhancement would store the
      // videoId in info.txt and use it here.
    }

    return res.status(200).json({
      ok: true,
      folder,
      errors: errors.length ? errors : undefined,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, errors });
  }
};
