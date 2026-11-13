// Provider adapter contract. Every provider normalizes its output into these events:
//   { type: 'text', text }
//   { type: 'file_edit', path }
//   { type: 'command_start', id, cmd } / { type: 'command_end', id, ok }
//   { type: 'limit', reason, retryAt? }   usage/rate limit: router should hand off
//   { type: 'error', message }            other failure
//   { type: 'session', id }               provider-side session id, so the next turn can resume it
//   { type: 'done' }
// Adapter shape:
//   { id, name, billing: 'subscription'|'paid'|'free', status(): Promise<{available, reason?}>,
//     run({ prompt, cwd, signal }): AsyncIterable<event> }
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const LIMIT_PATTERNS = [
  /usage limit/i, /rate.?limit/i, /\b429\b/, /quota/i, /hit your limit/i, /limit reached/i, /out of credits/i, /overloaded/i,
];
export const looksLikeLimit = (msg = '') => LIMIT_PATTERNS.some(r => r.test(msg));

/** Spawn a CLI that prints JSON lines; yield parsed objects. Never uses a shell. */
// Set UNIFY_RAW_LOG=<dir> to save every raw line a CLI prints (used by `npm run doctor` to check our parsers).
export async function* spawnJsonLines(cmd, args, { cwd, signal, env, rawLog } = {}) {
  const logDir = rawLog && process.env.UNIFY_RAW_LOG;
  if (logDir) mkdirSync(logDir, { recursive: true });
  const child = spawn(cmd, args, { cwd, signal, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  const exited = new Promise(res => child.on('close', code => res(code)));
  const spawnError = new Promise(res => child.on('error', err => res(err)));
  const rl = createInterface({ input: child.stdout });
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (logDir) appendFileSync(join(logDir, `${rawLog}.jsonl`), line + '\n');
    try { yield { json: JSON.parse(line) }; } catch { yield { raw: line }; }
  }
  const code = await Promise.race([exited, spawnError]);
  if (code instanceof Error) yield { exit: { code: -1, stderr: code.message } };
  else yield { exit: { code, stderr } };
}

/** Check that a CLI is installed by running `<cmd> --version`. */
export async function cliInstalled(cmd) {
  return new Promise(res => {
    const c = spawn(cmd, ['--version'], { stdio: 'ignore' });
    c.on('error', () => res(false));
    c.on('close', code => res(code === 0));
  });
}

/** Run a CLI to completion (no shell) and return { code, stdout, stderr }. Used for quick checks like sign-in status. */
export function runCli(cmd, args, { env, timeoutMs = 15_000 } = {}) {
  return new Promise(res => {
    let stdout = '', stderr = '';
    const c = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    c.stdout.on('data', d => { stdout += d; }); c.stderr.on('data', d => { stderr += d; });
    c.on('error', e => res({ code: -1, stdout, stderr: e.message }));
    c.on('close', code => res({ code, stdout, stderr }));
  });
}

/**
 * Cached sign-in check for a CLI account. check() returns { loggedIn, email?, plan? } or null if it can't tell
 * (e.g. an older CLI without a status command), in which case the account is treated as usable.
 */
export function accountCache(check, ttlMs = 20_000) {
  let at = 0, value = null, inflight = null;
  return {
    async get({ fresh = false } = {}) {
      if (!fresh && at && Date.now() - at < ttlMs) return value;
      inflight ??= check().catch(() => null).then(v => { value = v; at = Date.now(); inflight = null; return v; });
      return inflight;
    },
    clear() { at = 0; },
  };
}
