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
    res = await fetch(`${API}${path}`, { ...init, headers: { ...headers(token), ...(init.headers || {}) } });
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

export async function latestRun(repo, token) {
  const j = await gh(`/repos/${repo}/actions/workflows/${WORKFLOW}/runs?per_page=1`, token);
  return j?.workflow_runs?.[0] || null;
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Dispatch the workflow and poll its newest run until it completes.
 * onStatus({ phase: 'queued'|'running'|'done'|'failed', text, run })
 */
export async function runWorkflowAndWait(repo, token, { onStatus, intervalMs = 10000, timeoutMs = 20 * 60 * 1000 } = {}) {
  const before = await latestRun(repo, token).catch(() => null);
  await dispatchFetch(repo, token);
  onStatus?.({ phase: 'queued', text: 'Fetch requested — waiting for GitHub to start it' });
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(intervalMs);
    const run = await latestRun(repo, token).catch(() => null);
    const ours = run && (!before || run.id !== before.id);
    if (!ours) { onStatus?.({ phase: 'queued', text: 'Queued on GitHub…' }); continue; }
    if (run.status === 'completed') {
      const ok = run.conclusion === 'success';
      onStatus?.({ phase: ok ? 'done' : 'failed', run, text: ok ? 'Fetch finished' : `Fetch ${run.conclusion || 'failed'}` });
      return run;
    }
    onStatus?.({ phase: run.status === 'in_progress' ? 'running' : 'queued', run, text: run.status === 'in_progress' ? 'Fetching listings and data…' : 'Queued on GitHub…' });
  }
  throw new Error('Timed out waiting for the workflow to finish');
}
