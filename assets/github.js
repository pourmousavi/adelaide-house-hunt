// GitHub REST helpers: dispatch the fetch workflow, poll its latest run, read/write data/areas.json.
const API = 'https://api.github.com';
const WORKFLOW = 'fetch.yml';

function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function gh(path, token, init = {}) {
  let res;
  try {
    // no-store: the browser otherwise reuses GitHub's GET answer for 60 s, and a stale sha makes the next save fail with 409
    res = await fetch(`${API}${path}`, { cache: 'no-store', ...init, headers: { ...headers(token), ...(init.headers || {}) } });
  } catch {
    throw new Error('Could not reach api.github.com (offline?)');
  }
  if (!res.ok) {
    let msg = `GitHub ${res.status}`;
    try { const j = await res.json(); if (j?.message) msg += `: ${j.message}`; } catch { /* no body */ }
    if (res.status === 401) msg = 'GitHub rejected the token (401). Check it in Settings.';
    if (res.status === 403 && /rate limit/i.test(msg)) msg = 'GitHub rate limit hit. Try again in a few minutes.';
    if (res.status === 404) msg += ' — check the repo name and that the token can access it.';
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const dispatchFetch = (repo, token) =>
  gh(`/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, token, { method: 'POST', body: JSON.stringify({ ref: 'main' }) });

export async function getFile(repo, token, path) {
  const j = await gh(`/repos/${repo}/contents/${path}?ref=main`, token);
  return { sha: j.sha, content: j.encoding === 'base64' ? decodeB64(j.content) : j.content };
}

export function putFile(repo, token, path, text, { sha, message }) {
  return gh(`/repos/${repo}/contents/${path}`, token, {
    method: 'PUT',
    body: JSON.stringify({ message, content: encodeB64(text), sha: sha || undefined, branch: 'main' }),
  });
}

// Read a JSON file, change it with update(current) -> { data, message, ...extra } (or null to skip), write it back.
// Re-reads and retries when someone else saved in between (409), e.g. the data pipeline or another tab.
export async function updateJson(repo, token, path, fallback, update) {
  for (let attempt = 1; ; attempt++) {
    let current = fallback, sha = null;
    try { const f = await getFile(repo, token, path); sha = f.sha; current = JSON.parse(f.content); }
    catch (e) { if (!/ 404/.test(e.message)) throw e; }
    const r = update(current);
    if (!r) return null;
    try { await putFile(repo, token, path, `${JSON.stringify(r.data, null, 2)}\n`, { sha, message: r.message }); return r; }
    catch (e) { if (!/ 409/.test(e.message) || attempt >= 3) throw e; }
  }
}

export function encodeB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function decodeB64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
