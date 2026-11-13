// Unify.js local server: serves the chat UI and connects it to the engine.
//   npm start                  -> demo mode (simulated Claude Code + Codex; safe anywhere)
//   UNIFY_MODE=real npm start  -> drives your installed, signed-in `claude` and `codex` CLIs in UNIFY_CWD
// Also imported by the desktop app via startServer(). Binds to 127.0.0.1 only: never expose a server that can run coding agents.
import http from 'node:http';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, createRouter, refreshCheckpoint, renderHandoffPacket, claudeCodeAdapter, codexAdapter, deepseekAdapter, nvidiaAdapter, gitCheckpointer } from '../engine/src/index.js';
import { randomUUID } from 'node:crypto';
import { createSecretStore } from './secrets.js';
import { demoAdapters } from './demo-adapters.js';
import { refreshPath, installCommand, INSTALL_HELP, openInTerminal, cliVersion, testReply, shq } from './setup.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { updateChecker } from './updates.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function startServer({ mode = 'demo', port = 4317, host = '127.0.0.1', cwd = process.cwd(), dataDir = join(here, '..', '.unify-data'), Database, secrets = null, appVersion = null, checkUpdates = updateChecker({ currentVersion: appVersion }) } = {}) {
const MODE = mode === 'real' ? 'real' : 'demo';
const PORT = port, HOST = host;
let CWD = cwd;
if (MODE === 'demo') {
  // Demo works in a throwaway git repo so checkpoints are real, but nothing of yours is touched.
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  CWD = mkdtempSync(join(tmpdir(), 'unify-demo-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'demo', GIT_AUTHOR_EMAIL: 'demo@localhost', GIT_COMMITTER_NAME: 'demo', GIT_COMMITTER_EMAIL: 'demo@localhost' };
  writeFileSync(join(CWD, 'README.md'), '# Church presentation app (demo)\n');
  for (const a of [['init', '-q'], ['add', '.'], ['commit', '-qm', 'Initial commit']]) execFileSync('git', a, { cwd: CWD, env });
}

// One project per folder in real mode, so switching folders never mixes their history.
const PROJECT = MODE === 'demo' ? 'default' : 'p_' + createHash('sha256').update(CWD).digest('hex').slice(0, 16);
await mkdir(dataDir, { recursive: true });
const db = openDb(MODE === 'demo' ? ':memory:' : join(dataDir, 'unify.db'), { Database });
if (!db.getProject(PROJECT)) {
  db.createProject({ id: PROJECT, name: MODE === 'demo' ? 'Church presentation app' : basename(CWD), cwd: CWD,
    goal: MODE === 'demo' ? 'A reliable, volunteer-friendly presentation app for live church production' : '' });
  db.setPriorities(PROJECT, ['claude-code', 'codex', 'nvidia', 'deepseek']); // free trial before paid
}

const getModel = id => () => db.getSetting(`${id}.model`);
const demo = MODE === 'demo' ? demoAdapters({ cwd: CWD, getModel }) : null;
const keys = secrets ?? createSecretStore({ file: null });

// CLI accounts. The default Claude Code / Codex use the CLI's normal folder; each extra account (e.g. "Work") gets its own
// config folder (CLAUDE_CONFIG_DIR / CODEX_HOME), so its sign-in, settings and sessions stay separate. Unify never sees the logins.
const KINDS = { 'claude-code': { name: 'Claude Code', make: claudeCodeAdapter }, codex: { name: 'Codex', make: codexAdapter } };
const accountsDir = join(dataDir, 'accounts');
const extraAccounts = () => db.getSetting('accounts', []) ?? [];
const displayName = (kind, label) => label ? `${KINDS[kind].name} · ${label}` : KINDS[kind].name;
const cliAdapter = ({ id, kind, label, configDir = null }) => KINDS[kind].make({ id, name: displayName(kind, label), configDir });
const defaultCli = kind => cliAdapter({ id: kind, kind, label: db.getSetting(`label.${kind}`, null) });
const extraCli = acc => cliAdapter({ ...acc, configDir: join(accountsDir, acc.id) });
const adapters = demo ? demo.adapters : [
  defaultCli('claude-code'), ...extraAccounts().filter(a => a.kind === 'claude-code').map(extraCli),
  defaultCli('codex'), ...extraAccounts().filter(a => a.kind === 'codex').map(extraCli),
  nvidiaAdapter({ getKey: () => keys.get('nvidia'), getModel: getModel('nvidia') }),
  deepseekAdapter({ getKey: () => keys.get('deepseek') })];
const signInWatch = new Map(); // providerId -> interval while waiting for a Terminal sign-in / install to finish
refreshPath(); // find claude/codex even when the app was opened from Finder
// First-run setup works in demo mode too (it's the first thing people see), so it uses the real CLIs, not the simulated ones.
const setupCli = { 'claude-code': demo ? claudeCodeAdapter() : adapters.find(a => a.id === 'claude-code'),
  codex: demo ? codexAdapter() : adapters.find(a => a.id === 'codex') };
const cliById = id => adapters.find(a => a.id === id && a.signIn) ?? setupCli[id] ?? null;
// Kept in a file, not the database, because demo mode's database lives in memory.
const setupFile = join(dataDir, 'setup.json');
const setupDone = () => { try { return !!JSON.parse(readFileSync(setupFile, 'utf8')).done; } catch { return false; } };
function watchUntil(key, check, ms = 10 * 60_000) {
  clearInterval(signInWatch.get(key)); const started = Date.now();
  signInWatch.set(key, setInterval(async () => {
    if ((await check().catch(() => false)) || Date.now() - started > ms) { clearInterval(signInWatch.get(key)); signInWatch.delete(key); await pushSnapshot(); }
  }, 3000));
}
const catalogCache = new Map(); // providerId -> { at, models }
// Projects created before a provider existed: add it at the end of the order (paid ones still need approval to run).
{ const order = db.priorities(PROJECT); const missing = adapters.map(a => a.id).filter(id => !order.includes(id)); if (missing.length) db.setPriorities(PROJECT, [...order, ...missing]); }
const clients = new Set();
const broadcast = msg => { const s = `data: ${JSON.stringify(msg)}\n\n`; for (const c of clients) c.write(s); };
// Paid providers: ask the person in the app, and wait. Nothing paid runs without an answer.
let pending = null; // { id, providerId, name, model, pricePerMTok, spentUsd, resolve }
function approvePaid({ provider, spentUsd }) {
  if (pending) pending.resolve(false);
  return new Promise(resolve => {
    const id = randomUUID();
    const timer = setTimeout(() => { if (pending?.id === id) { pending = null; resolve(false); pushSnapshot(); } }, 15 * 60_000);
    pending = { id, providerId: provider.id, name: provider.name, model: provider.model ?? null, pricePerMTok: provider.pricePerMTok ?? null, spentUsd,
      resolve: v => { clearTimeout(timer); pending = null; resolve(v); } };
    pushSnapshot();
  });
}
const router = createRouter({ db, adapters, approvePaid, onEvent: ev => broadcast({ kind: 'event', event: ev }),
  checkpointer: gitCheckpointer({ cwd: CWD, projectId: PROJECT }) });
let busy = false;

async function snapshot() {
  const state = refreshCheckpoint(db, PROJECT);
  const statuses = await router.statuses(PROJECT);
  const next = statuses.find(s => s.available);
  const from = state.lastProvider ? (statuses.find(s => s.id === state.lastProvider)?.name ?? state.lastProvider) : null;
  const packet = from && next && next.id !== state.lastProvider ? renderHandoffPacket(state, { from, to: next.name, reason: state.lastError?.message }) : null;
  for (const s of statuses) {
    const a = adapters.find(x => x.id === s.id);
    if (a?.billing === 'paid') Object.assign(s, { capUsd: router.approvalFor(PROJECT, s.id), spend: state.spend[s.id] ?? null });
    if (a?.kind) Object.assign(s, { kind: a.kind, extra: extraAccounts().some(x => x.id === a.id),
      label: extraAccounts().find(x => x.id === a.id)?.label ?? db.getSetting(`label.${a.id}`, null), account: await a.account?.() ?? null });
    if (a?.needsKey) Object.assign(s, { needsKey: true, keySource: demo ? 'demo' : await keys.source(s.id), canStoreKey: keys.canStore,
      chatOnly: !!a.chatOnly, model: a.model, note: a.note ?? null, pricePerMTok: a.pricePerMTok ?? null, hasCatalog: typeof a.listModels === 'function' });
  }
  const approval = pending && (({ resolve, ...p }) => p)(pending);
  return { mode: MODE, busy, approval, setupDone: setupDone(), appVersion, update, project: db.getProject(PROJECT), state, statuses, packet,
    preview: renderHandoffPacket(state, { from: from ?? 'the previous model', to: next?.name ?? 'the next model' }),
    events: db.events(PROJECT) };
}
const pushSnapshot = async () => broadcast({ kind: 'snapshot', ...(await snapshot()) });
// Update check in the background, so a slow network never delays the app.
let update = null;
const refreshUpdate = async () => { const u = await checkUpdates().catch(() => null); if (JSON.stringify(u) !== JSON.stringify(update)) { update = u; await pushSnapshot(); } };
const updateTimer = appVersion ? setInterval(refreshUpdate, 6 * 3600_000) : null; updateTimer?.unref?.();
if (appVersion) refreshUpdate();

const readBody = req => new Promise((res, rej) => {
  let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } });
});
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(await readFile(join(here, 'index.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await snapshot());
    if (req.method === 'GET' && url.pathname === '/api/catalog') {
      const a = adapters.find(x => x.id === url.searchParams.get('provider'));
      if (!a?.listModels) return json(res, 404, { error: 'No catalog for this provider' });
      const hit = catalogCache.get(a.id);
      if (hit && Date.now() - hit.at < 10 * 60_000 && !url.searchParams.has('refresh')) return json(res, 200, { models: hit.models, cached: true });
      try { const models = await a.listModels(); catalogCache.set(a.id, { at: Date.now(), models }); return json(res, 200, { models }); }
      catch (e) { return json(res, 502, { error: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/setup') {
      refreshPath();
      const clis = await Promise.all(Object.entries(setupCli).map(async ([kind, a]) => {
        const version = await cliVersion(a.signIn.cmd);
        if (version) a.forgetAccount();
        return { id: a.id, kind, name: KINDS[kind].name, version, account: version ? await a.account() : null,
          install: installCommand(kind), help: INSTALL_HELP[kind] };
      }));
      return json(res, 200, { mode: MODE, platform: process.platform, folder: MODE === 'real' ? CWD : null, done: setupDone(), clis });
    }
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hi\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
    const body = await readBody(req);
    switch (url.pathname) {
      case '/api/send': {
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: 'empty' });
        if (busy) return json(res, 409, { error: 'A turn is already running' });
        busy = true; json(res, 202, { ok: true }); await pushSnapshot();
        try { await router.send(PROJECT, text, { cwd: CWD }); }
        catch (e) { db.appendEvent(PROJECT, { type: 'error', data: { message: String(e.message ?? e) } }); }
        finally { busy = false; await pushSnapshot(); }
        return;
      }
      case '/api/pause': router.pause(body.id); break;
      case '/api/resume': router.resume(body.id); break;
      case '/api/priorities': db.setPriorities(PROJECT, body.order.filter(id => adapters.some(a => a.id === id))); break;
      case '/api/project': db.raw.prepare('UPDATE projects SET goal = ? WHERE id = ?').run(String(body.goal ?? ''), PROJECT);
        db.appendEvent(PROJECT, { type: 'goal', data: { text: String(body.goal ?? '') } }); break;
      case '/api/decision': db.appendEvent(PROJECT, { type: 'decision', data: { text: String(body.text ?? '') } }); break;
      case '/api/approve': {
        if (!pending || pending.id !== body.id) return json(res, 409, { error: 'No matching approval request' });
        const cap = Number(body.capUsd);
        pending.resolve(body.allow && cap > 0 && cap <= 1000 ? { capUsd: cap } : false); break;
      }
      case '/api/model': {
        const a = adapters.find(x => x.id === body.provider);
        const m = String(body.model ?? '');
        if (!a?.needsKey || !/^[\w.\-/:]{1,200}$/.test(m)) return json(res, 400, { error: 'Invalid model' });
        db.setSetting(`${a.id}.model`, m); break;
      }
      case '/api/revoke': router.revokePaid(PROJECT, body.id); break;
      case '/api/keys': {
        if (!adapters.some(a => a.id === body.provider && a.needsKey)) return json(res, 400, { error: 'Unknown provider' });
        catalogCache.delete(body.provider);
        try { body.remove ? await keys.remove(body.provider) : await keys.set(body.provider, body.key); }
        catch (e) { return json(res, 400, { error: e.message }); }
        break;
      }
      case '/api/project-ai': {
        if (!adapters.some(a => a.id === body.id)) return json(res, 400, { error: 'Unknown AI' });
        router.setEnabled(PROJECT, body.id, !!body.on); break;
      }
      case '/api/accounts/add': {
        if (demo) return json(res, 400, { error: 'Open a project folder to add accounts (demo mode uses simulated AIs).' });
        const kind = String(body.kind ?? ''), label = String(body.label ?? '').trim().slice(0, 40);
        if (!KINDS[kind] || !label) return json(res, 400, { error: 'Choose Claude Code or Codex and give the account a name, like "Work".' });
        const base = `${kind}@${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'account'}`;
        let id = base; for (let n = 2; adapters.some(a => a.id === id); n++) id = `${base}-${n}`;
        const acc = { id, kind, label };
        await mkdir(join(accountsDir, id), { recursive: true, mode: 0o700 });
        db.setSetting('accounts', [...extraAccounts(), acc]);
        const a = extraCli(acc);
        const lastOfKind = adapters.findLastIndex(x => x.kind === kind);
        adapters.splice(lastOfKind + 1, 0, a); router.addAdapter(a);
        const order = db.priorities(PROJECT); const after = order.findLastIndex(p => adapters.find(x => x.id === p)?.kind === kind);
        order.splice(after + 1, 0, id); db.setPriorities(PROJECT, order);
        json(res, 200, { ok: true, id }); await pushSnapshot(); return;
      }
      case '/api/accounts/rename': {
        const a = adapters.find(x => x.id === body.id && x.kind); const label = String(body.label ?? '').trim().slice(0, 40);
        if (!a) return json(res, 400, { error: 'Unknown account' });
        const accs = extraAccounts(), i = accs.findIndex(x => x.id === a.id);
        if (i >= 0) { if (!label) return json(res, 400, { error: 'Give the account a name' }); accs[i] = { ...accs[i], label }; db.setSetting('accounts', accs); }
        else db.setSetting(`label.${a.id}`, label || null);
        a.name = displayName(a.kind, label || null); break;
      }
      case '/api/accounts/remove': {
        const acc = extraAccounts().find(x => x.id === body.id); const a = adapters.find(x => x.id === body.id);
        if (!acc || !a) return json(res, 400, { error: 'Only accounts you added can be removed' });
        if (busy) return json(res, 409, { error: 'Wait for the current turn to finish' });
        clearInterval(signInWatch.get(a.id)); signInWatch.delete(a.id);
        // Sign out only if it's signed in (clears its saved login, e.g. from the macOS Keychain). The account's own folder is
        // passed explicitly, so this can't affect your other accounts.
        if (a.configDir && (await a.account({ fresh: true }))?.loggedIn) await a.signOut().catch(() => {});
        await rm(join(accountsDir, acc.id), { recursive: true, force: true });
        await rm(join(accountsDir, `sign-in-${acc.id.replace(/[^\w-]/g, '_')}.command`), { force: true });
        db.setSetting('accounts', extraAccounts().filter(x => x.id !== acc.id));
        adapters.splice(adapters.indexOf(a), 1); router.removeAdapter(a.id);
        db.raw.prepare('DELETE FROM priorities WHERE provider = ?').run(a.id); break;
      }
      case '/api/accounts/signin': {
        const a = cliById(body.id);
        if (!a) return json(res, 400, { error: 'Unknown account' });
        const { cmd, args, env } = a.signIn;
        const command = [...Object.entries(env).map(([k, v]) => `${k}=${shq(v)}`), cmd, ...args].join(' ');
        const opened = await openInTerminal({ dir: accountsDir, name: `sign-in-${a.id}`, title: `Signing in: ${a.name}`, env,
          lines: [[cmd, ...args].map(shq).join(' ')] });
        watchUntil(a.id, async () => (await a.account?.({ fresh: true }))?.loggedIn);
        return json(res, 200, { ok: true, opened, command });
      }
      case '/api/accounts/check': {
        const a = adapters.find(x => x.id === body.id && x.account); if (a) { a.forgetAccount(); await a.account({ fresh: true }); } break;
      }
      case '/api/setup/install': {
        const a = setupCli[body.kind]; const inst = installCommand(body.kind);
        if (!a || !inst) return json(res, 400, { error: 'No automatic installer here', help: INSTALL_HELP[body.kind] ?? null });
        const opened = await openInTerminal({ dir: join(dataDir, 'setup'), name: `install-${body.kind}`, title: `Installing ${a.name} with ${inst.how}`, lines: [inst.command] });
        watchUntil(`install:${body.kind}`, async () => { refreshPath(); return !!(await cliVersion(a.signIn.cmd)); });
        return json(res, 200, { ok: true, opened, command: inst.command });
      }
      case '/api/setup/test': {
        const a = cliById(body.id); if (!a) return json(res, 400, { error: 'Unknown AI' });
        return json(res, 200, await testReply(a));
      }
      case '/api/setup/done': { await mkdir(dataDir, { recursive: true }); writeFileSync(setupFile, JSON.stringify({ done: !!body.done })); break; }
      case '/api/demo/limit': if (!demo) return json(res, 400, { error: 'demo only' }); demo.limitNext(body.id ?? 'claude-code'); break;
      default: return json(res, 404, { error: 'not found' });
    }
    json(res, 200, { ok: true }); await pushSnapshot();
  } catch (e) { if (!res.headersSent) json(res, 500, { error: String(e.message ?? e) }); }
});
await new Promise((res, rej) => { server.once('error', rej); server.listen(PORT, HOST, res); });
const url = `http://${HOST}:${server.address().port}`;
return { url, mode: MODE, cwd: CWD, async close() { pending?.resolve(false); for (const t of signInWatch.values()) clearInterval(t); clearInterval(updateTimer); for (const c of clients) c.end(); await new Promise(r => server.close(r)); db.close(); } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const s = await startServer({ mode: process.env.UNIFY_MODE, port: Number(process.env.PORT ?? 4317), host: process.env.HOST ?? '127.0.0.1', cwd: process.env.UNIFY_CWD ?? process.cwd() });
  console.log(`Unify.js (${s.mode} mode) on ${s.url}${s.mode === 'real' ? `  · working in ${s.cwd}` : ''}`);
}
