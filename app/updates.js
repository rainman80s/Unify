// "New version available" check for the desktop app. Reads the latest GitHub Release of the public repo.
// macOS apps can only update themselves when signed with a Developer ID, so this only links to the download.
// No data about the person is sent: it's an anonymous GET of public release info.
export const RELEASES_REPO = 'rainman80s/Unify';

/** Compare "1.2.3" style versions (a leading "v" and any "-suffix" are ignored). */
export function newerThan(a, b) {
  const p = v => String(v).replace(/^v/, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

export function updateChecker({ currentVersion, repo = RELEASES_REPO, fetchImpl = globalThis.fetch, everyMs = 6 * 3600_000 }) {
  let at = 0, result = null;
  return async function check() {
    if (!currentVersion) return null;
    if (Date.now() - at < everyMs) return result;
    at = Date.now();
    try {
      const r = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`,
        { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Unify.js-update-check' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return result;
      const j = await r.json();
      result = j.tag_name && newerThan(j.tag_name, currentVersion)
        ? { version: j.tag_name.replace(/^v/, ''), url: j.html_url, notes: String(j.name ?? '') } : null;
    } catch { /* offline: try again next time */ }
    return result;
  };
}
