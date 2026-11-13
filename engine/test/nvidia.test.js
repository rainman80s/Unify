import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb, createRouter, fakeAdapter, nvidiaAdapter } from '../src/index.js';

async function mockApi(handler) {
  const reqs = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const r = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null }; reqs.push(r); handler(r, res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, reqs, close: () => new Promise(r => { server.close(r); server.closeAllConnections(); }) };
}
const via = api => (u, o) => fetch(u.replace('https://integrate.api.nvidia.com/v1', api.url), o);

test('NVIDIA: lists the catalog, uses the chosen model, and is a free trial (no approval prompt)', async () => {
  const api = await mockApi((r, res) => {
    if (r.url === '/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'qwen/qwq-32b', owned_by: 'qwen' }, { id: 'meta/llama-3.3-70b-instruct' }] })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`); res.end('data: [DONE]\n\n');
  });
  let model = null;
  const nv = nvidiaAdapter({ getKey: async () => 'nvapi-test', getModel: () => model, fetchImpl: via(api) });
  assert.equal(nv.billing, 'trial');
  assert.deepEqual((await nv.listModels()).map(m => m.id), ['meta/llama-3.3-70b-instruct', 'qwen/qwq-32b']);
  model = 'qwen/qwq-32b';
  let asked = false;
  const db = openDb(); db.createProject({ id: 'p', name: 'p' }); db.setPriorities('p', ['nvidia']);
  const r = await createRouter({ db, adapters: [nv], approvePaid: async () => { asked = true; return false; } }).send('p', 'hello');
  assert.equal(r.provider, 'nvidia');
  assert.equal(asked, false);
  assert.equal(api.reqs.at(-1).body.model, 'qwen/qwq-32b');
  assert.equal(api.reqs.at(-1).headers.authorization, 'Bearer nvapi-test');
  await api.close();
});

test('NVIDIA 429 pauses it for about a minute, not the long default, and hands off', async () => {
  const api = await mockApi((r, res) => { res.writeHead(429); res.end('{"detail":"Too Many Requests"}'); });
  const nv = nvidiaAdapter({ getKey: async () => 'nvapi-test', fetchImpl: via(api) });
  const backup = fakeAdapter({ id: 'claude-code', name: 'Claude Code', script: [{ type: 'done' }] });
  const db = openDb(); db.createProject({ id: 'p', name: 'p' }); db.setPriorities('p', ['nvidia', 'claude-code']);
  const router = createRouter({ db, adapters: [nv, backup] });
  assert.equal((await router.send('p', 'x')).provider, 'claude-code');
  const st = (await router.statuses('p')).find(s => s.id === 'nvidia');
  assert.equal(st.available, false);
  assert.ok(st.until - Date.now() <= 61_000 && st.until - Date.now() > 50_000);
  await api.close();
});

test('settings persist in the project database', () => {
  const db = openDb();
  assert.equal(db.getSetting('nvidia.model', 'x'), 'x');
  db.setSetting('nvidia.model', 'qwen/qwq-32b'); db.setSetting('nvidia.model', 'meta/llama-3.1-8b-instruct');
  assert.equal(db.getSetting('nvidia.model'), 'meta/llama-3.1-8b-instruct');
});
