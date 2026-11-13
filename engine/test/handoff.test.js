import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, createRouter, fakeAdapter, refreshCheckpoint, parseClaudeLine, parseCodexLine } from '../src/index.js';

function setup(adapters, order, opts = {}) {
  const db = openDb();
  db.createProject({ id: 'p1', name: 'Church app', goal: 'Volunteer-friendly presentation app' });
  db.setPriorities('p1', order);
  return { db, router: createRouter({ db, adapters, ...opts }) };
}

const claudeHitsLimit = fakeAdapter({ id: 'claude-code', name: 'Claude Code', script: [
  { type: 'decision', text: 'macOS-first, SwiftUI-free web UI' },
  { type: 'text', text: 'Building the slide editor. ' },
  { type: 'file_edit', path: 'src/editor.js' },
  { type: 'command_start', id: 'c1', cmd: 'npm run migrate' },
  { type: 'limit', reason: 'Claude usage limit reached' },
] });

test('limit mid-turn hands off to Codex with pre-built context', async () => {
  const codex = fakeAdapter({ id: 'codex', name: 'Codex', script: [{ type: 'text', text: 'Continuing.' }, { type: 'done' }] });
  const { db, router } = setup([claudeHitsLimit, codex], ['claude-code', 'codex']);
  const r = await router.send('p1', 'Start the slide editor');

  assert.equal(r.provider, 'codex');
  assert.deepEqual(r.handoffs.map(h => [h.from, h.to]), [['claude-code', 'codex']]);
  const packet = codex.prompts[0];
  for (const needle of ['Volunteer-friendly presentation app', 'macOS-first', 'src/editor.js', 'Start the slide editor', 'Building the slide editor', 'Claude usage limit reached'])
    assert.ok(packet.includes(needle), `packet missing: ${needle}`);
  // The half-finished command is flagged, not silently re-run.
  assert.match(packet, /Interrupted actions[\s\S]*npm run migrate/);
  // Claude was never asked to summarize after it ran out.
  assert.equal(claudeHitsLimit.prompts.length, 1);
  assert.deepEqual(refreshCheckpoint(db, 'p1').providersUsed, ['claude-code', 'codex']);
});

test('paid providers are never used without approval', async () => {
  const deepseek = fakeAdapter({ id: 'deepseek', billing: 'paid', script: [{ type: 'done' }] });
  const claude = fakeAdapter({ id: 'claude-code', script: [{ type: 'limit', reason: 'rate limit' }] });
  const { router } = setup([claude, deepseek], ['claude-code', 'deepseek']);
  const r = await router.send('p1', 'hi');
  assert.equal(r.outcome, 'stalled');
  assert.equal(deepseek.prompts.length, 0);
});

test('paid provider runs when the user approves', async () => {
  const deepseek = fakeAdapter({ id: 'deepseek', billing: 'paid', script: [{ type: 'done' }] });
  const claude = fakeAdapter({ id: 'claude-code', script: [{ type: 'limit', reason: 'rate limit' }] });
  const { router } = setup([claude, deepseek], ['claude-code', 'deepseek'], { approvePaid: async () => true });
  assert.equal((await router.send('p1', 'hi')).provider, 'deepseek');
});

test('provider on cooldown is skipped on the next message', async () => {
  const claude = fakeAdapter({ id: 'claude-code', script: [{ type: 'limit', reason: 'usage limit' }] });
  const codex = fakeAdapter({ id: 'codex', script: [{ type: 'done' }] });
  const { router } = setup([claude, codex], ['claude-code', 'codex']);
  await router.send('p1', 'one');
  await router.send('p1', 'two');
  assert.equal(claude.prompts.length, 1);
  assert.equal(codex.prompts.length, 2);
});

test('checkpoint survives reopening the database', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const file = join(mkdtempSync(join(tmpdir(), 'unify-')), 'p.db');
  let db = openDb(file);
  db.createProject({ id: 'p1', name: 'x', goal: 'g' });
  db.appendEvent('p1', { type: 'decision', provider: 'claude-code', data: { text: 'Use SQLite' } });
  refreshCheckpoint(db, 'p1'); db.close();
  db = openDb(file);
  assert.equal(db.latestCheckpoint('p1').state.decisions[0].text, 'Use SQLite');
});

test('Claude Code stream-json parsing', () => {
  assert.deepEqual(parseClaudeLine({ type: 'assistant', message: { content: [
    { type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'a.js' } },
    { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } }] } }),
  [{ type: 'text', text: 'hi' }, { type: 'file_edit', path: 'a.js' }, { type: 'command_start', id: 't2', cmd: 'ls' }]);
  assert.equal(parseClaudeLine({ type: 'result', is_error: true, result: 'Claude AI usage limit reached' })[0].type, 'limit');
  assert.equal(parseClaudeLine({ type: 'result', subtype: 'success', result: 'ok' })[0].type, 'done');
});

test('Codex --json parsing', () => {
  assert.deepEqual(parseCodexLine({ type: 'item.completed', item: { type: 'agent_message', text: 'yo' } }), [{ type: 'text', text: 'yo' }]);
  assert.deepEqual(parseCodexLine({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'b.js' }] } }), [{ type: 'file_edit', path: 'b.js' }]);
  assert.equal(parseCodexLine({ type: 'turn.failed', error: { message: "You've hit your usage limit" } })[0].type, 'limit');
});
