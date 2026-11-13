import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newerThan, updateChecker } from '../../app/updates.js';

test('version comparison', () => {
  assert.equal(newerThan('v0.2.0', '0.1.0'), true);
  assert.equal(newerThan('0.1.0', '0.1.0'), false);
  assert.equal(newerThan('v0.1.10', '0.1.9'), true);
  assert.equal(newerThan('v0.1.0', '0.2.0'), false);
  assert.equal(newerThan('v1.0.0-beta', '0.9.9'), true);
});

test('update check: reports a newer release, ignores older ones and failures, and caches', async () => {
  let calls = 0, tag = 'v0.2.0', ok = true;
  const fetchImpl = async () => { calls++; return { ok, json: async () => ({ tag_name: tag, html_url: 'https://example/rel', name: 'Unify.js 0.2.0' }) }; };
  const check = updateChecker({ currentVersion: '0.1.0', fetchImpl });
  assert.deepEqual(await check(), { version: '0.2.0', url: 'https://example/rel', notes: 'Unify.js 0.2.0' });
  await check(); assert.equal(calls, 1, 'cached between checks');
  const same = updateChecker({ currentVersion: '0.2.0', fetchImpl }); assert.equal(await same(), null);
  ok = false; const failing = updateChecker({ currentVersion: '0.1.0', fetchImpl }); assert.equal(await failing(), null);
  assert.equal(await updateChecker({ currentVersion: null, fetchImpl })(), null, 'no version (browser/dev): no check');
});
