// Unify.js local server: serves the chat UI and connects it to the engine.
//   npm start              -> demo mode (simulated Claude Code + Codex; safe anywhere)
//   UNIFY_MODE=real npm start  -> drives your installed, signed-in `claude` and `codex` CLIs in UNIFY_CWD
// Binds to 127.0.0.1 only by default: never expose a server that can run coding agents.
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, createRouter, refreshCheckpoint, renderHandoffPacket, claudeCodeAdapter, codexAdapter } from '../engine/src/index.js';
import { demoAdapters } from './demo-adapters.js';

const here = dirname(fileURLToPath(import.meta.url));
const MODE = process.env.UNIFY_MODE === 'real' ? 'real' : 'demo';
const PORT = Number(process.env.PORT ?? 4317);
const HOST = process.env.HOST ?? '127.0.0.1';
const CWD = process.env.UNIFY_CWD ?? process.cwd();
const PROJECT = 'default';

const dataDir = join(here, '..', '.unify-data');
await mkdir(dataDir, { recursive: true });
const db = openDb(MODE === 'demo' ? ':memory:' : join(dataDir, 'unify.db'));
if (!db.getProject(PROJECT)) {
  db.createProject({ id: PROJECT, name: MODE === 'demo' ? 'Church presentation app' : 'My project', cwd: CWD,
    goal: MODE === 'demo' ? 'A reliable, volunteer-friendly presentation app for live church production' : '' });
  db.setPriorities(PROJECT, ['claude-code', 'codex']);
}

const demo = MODE === 'demo' ? demoAdapters() : null;
const adapters = demo ? demo.adapters : [claudeCodeAdapter(), codexAdapter()];
const clients = new Set();
const broadcast = msg => { const s = `data: ${JSON.stringify(msg)}\n\n`; for (const c of clients) c.write(s); };
const router = createRouter({ db, adapters, onEvent: ev => broadcast({ kind: 'event', event: ev }) });
let busy = false;

async function snapshot() {
  const state = refreshCheckpoint(db, PROJECT);
  const statuses = await router.statuses(PROJECT);
  const next = statuses.find(s => s.available);
  const from = state.lastProvider ? (statuses.find(s => s.id === state.lastProvider)?.name ?? state.lastProvider) : null;
  const packet = from && next && next.id !== state.lastProvider ? renderHandoffPacket(state, { from, to: next.name, reason: state.lastError?.message }) : null;
  return { mode: MODE, busy, project: db.getProject(PROJECT), state, statuses, packet,
    preview: renderHandoffPacket(state, { from: from ?? 'the previous model', to: next?.name ?? 'the next model' }),
    events: db.events(PROJECT) };
}
const pushSnapshot = async () => broadcast({ kind: 'snapshot', ...(await snapshot()) });

const readBody = req => new Promise((res, rej) => {
  let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } });
});
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
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
      case '/api/demo/limit': if (!demo) return json(res, 400, { error: 'demo only' }); demo.limitNext(body.id ?? 'claude-code'); break;
      default: return json(res, 404, { error: 'not found' });
    }
    json(res, 200, { ok: true }); await pushSnapshot();
  } catch (e) { if (!res.headersSent) json(res, 500, { error: String(e.message ?? e) }); }
}).listen(PORT, HOST, () => console.log(`Unify.js (${MODE} mode) on http://${HOST}:${PORT}${MODE === 'real' ? `  · working in ${CWD}` : ''}`));
