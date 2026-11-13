import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb, createRouter, fakeAdapter, deepseekAdapter, refreshCheckpoint } from '../src/index.js';

// A local stand-in for an OpenAI-compatible API. Records requests; never touches the network.
async function mockApi(handler) {
  const reqs = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const r = { headers: req.headers, body: JSON.parse(body || '{}') }; reqs.push(r);
    handler(r, res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, reqs, close: () => new Promise(r => { server.close(r); server.closeAllConnections(); }) };
}
const streamReply = (res, words, usage) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const w of words) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
  res.end('data: [DONE]\n\n');
};
function adapterFor(api, key = 'sk-test') {
  const fetchImpl = (u, o) => fetch(u.replace('https://api.deepseek.com', api.url), o);
  return deepseekAdapter({ getKey: async () => key, fetchImpl });
}
function setup(adapters, order, opts = {}) {
  const db = openDb();
  db.createProject({ id: 'p1', name: 'x', goal: 'g' });
  db.setPriorities('p1', order);
  return { db, router: createRouter({ db, adapters, ...opts }) };
}

test('DeepSeek adapter streams text, reports cost, and sends the key only in the header', async () => {
  const api = await mockApi((r, res) => streamReply(res, ['Hel', 'lo'], { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }));
  const claude = fakeAdapter({ id: 'claude-code', name: 'Claude Code', script: [{ type: 'limit', reason: 'usage limit' }] });
  const asks = [];
  const { db, router } = setup([claude, adapterFor(api)], ['claude-code', 'deepseek'],
    { approvePaid: async a => { asks.push(a); return { capUsd: 5 }; } });
  const r = await router.send('p1', 'hi');
  assert.equal(r.provider, 'deepseek');
  assert.equal(asks.length, 1);
  assert.equal(api.reqs[0].headers.authorization, 'Bearer sk-test');
  assert.match(api.reqs[0].body.messages.at(-1).content, /Unify\.js handoff/); // got the packet
  const spend = refreshCheckpoint(db, 'p1').spend.deepseek;
  assert.equal(spend.usd.toFixed(2), '0.70'); // 0.28 + 0.42
  // The key never lands in the project log.
  assert.ok(!JSON.stringify(db.events('p1')).includes('sk-test'));
  await api.close();
});

test('approval is remembered until the cap; at the cap the provider is stopped and must be re-approved', async () => {
  const api = await mockApi((r, res) => streamReply(res, ['ok'], { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }));
  let asks = 0;
  const { db, router } = setup([adapterFor(api)], ['deepseek'], { approvePaid: async () => (++asks === 1 ? { capUsd: 1 } : false) });
  assert.equal((await router.send('p1', 'one')).provider, 'deepseek');  // spends $0.70 of $1
  assert.equal(asks, 1);
  const second = await router.send('p1', 'two');                         // budget only allows a short reply; goes over
  assert.equal(api.reqs.length, 2);
  assert.ok(api.reqs[1].body.max_tokens > 0 && api.reqs[1].body.max_tokens < 1_000_000);
  assert.equal(second.outcome, 'cap');
  assert.ok(db.events('p1').some(e => e.type === 'turn_interrupted' && /Spending cap/.test(e.data.reason)));
  const third = await router.send('p1', 'three');                        // must ask again; user says no
  assert.equal(asks, 2);
  assert.equal(third.outcome, 'stalled');
  assert.equal(api.reqs.length, 2);
  await api.close();
});

test('HTTP 402 and 429 count as limits; 401 is an error; no key means unavailable', async () => {
  for (const [status, type] of [[402, 'limit'], [429, 'limit'], [401, 'error']]) {
    const api = await mockApi((r, res) => { res.writeHead(status); res.end('{}'); });
    const evs = []; for await (const e of adapterFor(api).run({ prompt: 'x' })) evs.push(e);
    assert.equal(evs.at(-1).type, type, `status ${status}`);
    await api.close();
  }
  assert.equal((await deepseekAdapter({ getKey: async () => null }).status()).available, false);
});

test('secret store: encrypted at rest, env var wins, refuses plain-text storage', async () => {
  const { createSecretStore } = await import('../../app/secrets.js');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const file = join(mkdtempSync(join(tmpdir(), 'unify-keys-')), 'keys.json');
  const enc = s => Buffer.from([...s].reverse().join('')).toString('base64'); // stand-in for safeStorage
  const dec = b => [...Buffer.from(b, 'base64').toString()].reverse().join('');
  const store = createSecretStore({ file, encrypt: enc, decrypt: dec, env: {} });
  await store.set('deepseek', 'sk-secret-123456');
  assert.equal(await store.get('deepseek'), 'sk-secret-123456');
  assert.ok(!readFileSync(file, 'utf8').includes('sk-secret-123456'));
  await assert.rejects(store.set('deepseek', 'short'));
  await store.remove('deepseek'); assert.equal(await store.get('deepseek'), null);

  const envStore = createSecretStore({ file: null, env: { DEEPSEEK_API_KEY: 'sk-from-env' } });
  assert.equal(await envStore.get('deepseek'), 'sk-from-env');
  assert.equal(envStore.canStore, false);
  await assert.rejects(envStore.set('deepseek', 'sk-secret-123456'), /Secure storage isn't available/);
});
