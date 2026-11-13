// Unify.js local server: serves the chat UI and connects it to the engine.
//   npm start                  -> demo mode (simulated Claude Code + Codex; safe anywhere)
//   UNIFY_MODE=real npm start  -> drives your installed, signed-in `claude` and `codex` CLIs in UNIFY_CWD
// Also imported by the desktop app via startServer(). Binds to 127.0.0.1 only: never expose a server that can run coding agents.
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, createRouter, refreshCheckpoint, renderHandoffPacket, claudeCodeAdapter, codexAdapter, deepseekAdapter, gitCheckpointer } from '../engine/src/index.js';
import { randomUUID } from 'node:crypto';
import { createSecretStore } from './secrets.js';
import { demoAdapters } from './demo-adapters.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function startServer({ mode = 'demo', port = 4317, host = '127.0.0.1', cwd = process.cwd(), dataDir = join(here, '..', '.unify-data'), Database, secrets = null } = {}) {
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
  db.setPriorities(PROJECT, ['claude-code', 'codex', 'deepseek']);
}

const demo = MODE === 'demo' ? demoAdapters({ cwd: CWD }) : null;
const keys = secrets ?? createSecretStore({ file: null });
const adapters = demo ? demo.adapters : [claudeCodeAdapter(), codexAdapter(), deepseekAdapter({ getKey: () => keys.get('deepseek') })];
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
    if (a?.billing === 'paid') Object.assign(s, { capUsd: router.approvalFor(PROJECT, s.id), spend: state.spend[s.id] ?? null,
      keySource: demo ? 'demo' : await keys.source(s.id), canStoreKey: keys.canStore, chatOnly: !!a.chatOnly });
  }
  const approval = pending && (({ resolve, ...p }) => p)(pending);
  return { mode: MODE, busy, approval, project: db.getProject(PROJECT), state, statuses, packet,
    preview: renderHandoffPacket(state, { from: from ?? 'the previous model', to: next?.name ?? 'the next model' }),
    events: db.events(PROJECT) };
}
const pushSnapshot = async () => broadcast({ kind: 'snapshot', ...(await snapshot()) });

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
      case '/api/revoke': router.revokePaid(PROJECT, body.id); break;
      case '/api/keys': {
        if (!adapters.some(a => a.id === body.provider && a.billing === 'paid')) return json(res, 400, { error: 'Unknown provider' });
        try { body.remove ? await keys.remove(body.provider) : await keys.set(body.provider, body.key); }
        catch (e) { return json(res, 400, { error: e.message }); }
        break;
      }
      case '/api/demo/limit': if (!demo) return json(res, 400, { error: 'demo only' }); demo.limitNext(body.id ?? 'claude-code'); break;
      default: return json(res, 404, { error: 'not found' });
    }
    json(res, 200, { ok: true }); await pushSnapshot();
  } catch (e) { if (!res.headersSent) json(res, 500, { error: String(e.message ?? e) }); }
});
await new Promise((res, rej) => { server.once('error', rej); server.listen(PORT, HOST, res); });
const url = `http://${HOST}:${server.address().port}`;
return { url, mode: MODE, cwd: CWD, async close() { pending?.resolve(false); for (const c of clients) c.end(); await new Promise(r => server.close(r)); db.close(); } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const s = await startServer({ mode: process.env.UNIFY_MODE, port: Number(process.env.PORT ?? 4317), host: process.env.HOST ?? '127.0.0.1', cwd: process.env.UNIFY_CWD ?? process.cwd() });
  console.log(`Unify.js (${s.mode} mode) on ${s.url}${s.mode === 'real' ? `  · working in ${s.cwd}` : ''}`);
}
