// First-run setup helpers (app/setup.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeAdapter } from '../src/index.js';
import { testReply, installCommand, shq } from '../../app/setup.js';

test('setup test reply: passes on UNIFY_OK, explains failures', async () => {
  const ok = fakeAdapter({ id: 'a', script: [{ type: 'text', text: 'UNIFY_OK' }, { type: 'done' }] });
  assert.equal((await testReply(ok)).ok, true);
  const limited = fakeAdapter({ id: 'b', script: [{ type: 'limit', reason: 'usage limit reached' }] });
  assert.deepEqual([(await testReply(limited)).ok, (await testReply(limited)).error], [false, 'usage limit reached']);
  const odd = fakeAdapter({ id: 'c', script: [{ type: 'text', text: 'hello' }, { type: 'done' }] });
  assert.match((await testReply(odd)).error, /Unexpected reply: hello/);
});

test('install commands are the official ones', () => {
  if (process.platform === 'win32') return;
  assert.equal(installCommand('claude-code').command, 'curl -fsSL https://claude.ai/install.sh | bash');
  const codex = installCommand('codex');
  if (codex) assert.match(codex.command, /^(brew install --cask codex|npm install -g @openai\/codex)$/);
  assert.equal(installCommand('nope'), null);
});

test('shell quoting survives quotes and spaces', () => {
  assert.equal(shq("it's a /path with spaces"), `'it'\\''s a /path with spaces'`);
});
