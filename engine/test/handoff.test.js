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
  const { router } = setup([claude, deepseek], ['claude-code', 'deepseek'], { approvePaid: async () => ({ capUsd: 1 }) });
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

test('same provider resumes its session; switching provider sends the packet', async () => {
  const claude = fakeAdapter({ id: 'claude-code', name: 'Claude Code', script: [{ type: 'session', id: 's-123' }, { type: 'text', text: 'ok' }, { type: 'done' }] });
  const runs = [];
  const origRun = claude.run;
  claude.run = function (o) { runs.push(o.sessionId); return origRun.call(this, o); };
  const codex = fakeAdapter({ id: 'codex', name: 'Codex', script: [{ type: 'done' }] });
  const { router } = setup([claude, codex], ['claude-code', 'codex']);
  await router.send('p1', 'first');
  await router.send('p1', 'second');
  assert.deepEqual(runs, [undefined, 's-123']);
  assert.equal(claude.prompts[1], 'second');
  router.pause('claude-code');
  const r = await router.send('p1', 'third');
  assert.equal(r.provider, 'codex');
  assert.match(codex.prompts[0], /Unify\.js handoff[\s\S]*third/);
  const st = await router.statuses('p1');
  assert.equal(st[0].available, false);
});

test('git checkpoint after each turn, without touching branch, index, or files', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const { gitCheckpointer } = await import('../src/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'unify-git-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  g('init', '-q'); writeFileSync(join(dir, 'a.txt'), 'one\n'); g('add', '.'); g('commit', '-qm', 'init');
  const head = g('rev-parse', 'HEAD');

  const claude = fakeAdapter({ id: 'claude-code', name: 'Claude Code' });
  claude.run = async function* () { writeFileSync(join(dir, 'a.txt'), 'two\n'); writeFileSync(join(dir, 'new.txt'), 'x'); yield { type: 'file_edit', path: 'a.txt' }; yield { type: 'limit', reason: 'usage limit' }; };
  const codex = fakeAdapter({ id: 'codex', name: 'Codex', script: [{ type: 'done' }] });
  const db = openDb(); db.createProject({ id: 'p1', name: 'x', goal: 'g' }); db.setPriorities('p1', ['claude-code', 'codex']);
  const router = createRouter({ db, adapters: [claude, codex], checkpointer: gitCheckpointer({ cwd: dir, projectId: 'p1' }) });
  await router.send('p1', 'edit it');

  const cp = g('rev-parse', 'refs/unify/p1');
  assert.equal(g('show', `${cp}:a.txt`), 'two');
  assert.equal(g('show', `${cp}:new.txt`), 'x');
  assert.equal(g('rev-parse', 'HEAD'), head);              // branch untouched
  assert.equal(g('status', '--porcelain'), 'M a.txt\n?? new.txt'); // index untouched: still unstaged
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'two\n'); // files untouched
  assert.match(codex.prompts[0], new RegExp(`commit ${cp.slice(0, 12)}`));
  assert.match(codex.prompts[0], /a\.txt/);
});
