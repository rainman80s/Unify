// Multiple CLI accounts: each account runs its CLI with its own config folder, reports its own sign-in,
// and can be switched off per project. Uses fake `claude` / `codex` scripts, never the real CLIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, createRouter, claudeCodeAdapter, codexAdapter, fakeAdapter } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'unify-accounts-'));
// A config folder counts as signed in when it contains a file named "signed-in".
const fakeClaude = join(dir, 'claude');
writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const cfg = process.env.CLAUDE_CONFIG_DIR || 'DEFAULT';
const signedIn = cfg === 'DEFAULT' || fs.existsSync(path.join(cfg, 'signed-in'));
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('9.9.9 (fake)'); process.exit(0); }
if (a[0] === 'auth' && a[1] === 'status') { console.log(JSON.stringify({ loggedIn: signedIn, email: signedIn ? 'me@' + path.basename(cfg) : undefined, subscriptionType: 'max' })); process.exit(0); }
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-' + path.basename(cfg) }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'config=' + path.basename(cfg) }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }));
`);
const fakeCodex = join(dir, 'codex');
writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const home = process.env.CODEX_HOME || 'DEFAULT';
const signedIn = home === 'DEFAULT' || fs.existsSync(path.join(home, 'signed-in'));
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('codex-cli 0.0.0'); process.exit(0); }
if (a[0] === 'login' && a[1] === 'status') { console.log(signedIn ? 'Logged in using ChatGPT' : 'Not logged in'); process.exit(signedIn ? 0 : 1); }
console.log(JSON.stringify({ type: 'thread.started', thread_id: 't-' + path.basename(home) }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'home=' + path.basename(home) } }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`);
chmodSync(fakeClaude, 0o755); chmodSync(fakeCodex, 0o755);

async function collect(it) { const out = []; for await (const e of it) out.push(e); return out; }

test('a Claude Code account uses its own config folder for sign-in status and for runs', async () => {
  const work = mkdtempSync(join(dir, 'work-'));
  const a = claudeCodeAdapter({ bin: fakeClaude, id: 'claude-code@work', name: 'Claude Code · Work', configDir: work });
  assert.equal(a.kind, 'claude-code');
  assert.deepEqual(a.signIn, { cmd: fakeClaude, args: ['auth', 'login'], env: { CLAUDE_CONFIG_DIR: work } });
  assert.deepEqual(await a.status(), { available: false, reason: 'Not signed in', needsSignIn: true });

  writeFileSync(join(work, 'signed-in'), '');
  assert.equal((await a.status()).available, false, 'status is cached briefly');
  a.forgetAccount();
  assert.deepEqual(await a.status(), { available: true });
  const acc = await a.account();
  assert.equal(acc.loggedIn, true); assert.match(acc.email, /^me@work-/); assert.equal(acc.plan, 'max');

  const evs = await collect(a.run({ prompt: 'hi', cwd: dir }));
  assert.match(evs.find(e => e.type === 'text').text, /^config=work-/);
  assert.match(evs.find(e => e.type === 'session').id, /^s-work-/);
});

test('the default Claude Code account leaves CLAUDE_CONFIG_DIR alone', async () => {
  const a = claudeCodeAdapter({ bin: fakeClaude });
  assert.equal(a.id, 'claude-code'); assert.deepEqual(a.signIn.env, {});
  assert.deepEqual(await a.status(), { available: true });
  assert.equal((await collect(a.run({ prompt: 'hi', cwd: dir }))).find(e => e.type === 'text').text, 'config=DEFAULT');
});

test('a Codex account uses its own CODEX_HOME', async () => {
  const home = mkdtempSync(join(dir, 'cwork-'));
  const a = codexAdapter({ bin: fakeCodex, id: 'codex@work', configDir: home });
  assert.deepEqual(a.signIn, { cmd: fakeCodex, args: ['login'], env: { CODEX_HOME: home } });
  assert.equal((await a.status()).needsSignIn, true);
  writeFileSync(join(home, 'signed-in'), ''); a.forgetAccount();
  assert.deepEqual(await a.account(), { loggedIn: true, plan: 'ChatGPT' });
  assert.match((await collect(a.run({ prompt: 'hi', cwd: dir }))).find(e => e.type === 'text').text, /^home=cwork-/);
  assert.ok(existsSync(home));
});

test('an AI switched off for a project is skipped there but still used in other projects', async () => {
  const personal = fakeAdapter({ id: 'claude-code', name: 'Claude Code · Personal' });
  const work = fakeAdapter({ id: 'claude-code@work', name: 'Claude Code · Work' });
  const db = openDb();
  for (const id of ['job', 'home']) { db.createProject({ id, name: id }); db.setPriorities(id, ['claude-code', 'claude-code@work']); }
  const router = createRouter({ db, adapters: [personal, work] });
  router.setEnabled('job', 'claude-code', false);
  assert.equal((await router.send('job', 'work task')).provider, 'claude-code@work');
  assert.equal((await router.send('home', 'personal task')).provider, 'claude-code');
  const st = await router.statuses('job');
  assert.deepEqual(st.map(s => [s.id, s.available, s.off ?? false]), [['claude-code', false, true], ['claude-code@work', true, false]]);
  router.setEnabled('job', 'claude-code', true);
  assert.equal((await router.statuses('job'))[0].available, true);
});

test('accounts can be added and removed while running', async () => {
  const db = openDb(); db.createProject({ id: 'p', name: 'p' }); db.setPriorities('p', ['claude-code', 'claude-code@work']);
  const router = createRouter({ db, adapters: [fakeAdapter({ id: 'claude-code' })] });
  assert.equal((await router.statuses('p'))[1].reason, 'not configured');
  router.addAdapter(fakeAdapter({ id: 'claude-code@work', name: 'Work' }));
  assert.equal((await router.statuses('p'))[1].available, true);
  router.removeAdapter('claude-code@work');
  assert.equal((await router.statuses('p'))[1].reason, 'not configured');
});
