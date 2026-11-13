// First-run setup helpers: find the CLIs, install them with their official installers, and open sign-ins in Terminal.
// Everything that changes the computer runs visibly in Terminal, never silently in the background.
import { execFileSync, execFile } from 'node:child_process';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { runCli } from '../engine/src/adapters/base.js';

/**
 * Apps opened from Finder don't get your shell's PATH, and a fresh install (e.g. ~/.local/bin for Claude Code) isn't on
 * the PATH this process started with. Borrow the login shell's PATH and add the usual install folders.
 */
export function refreshPath() {
  if (process.platform === 'win32') return process.env.PATH;
  const parts = new Set((process.env.PATH ?? '').split(delimiter).filter(Boolean));
  try {
    const sh = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(sh, ['-ilc', 'printf "__P__%s__P__" "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/__P__(.*)__P__/);
    if (m?.[1]) for (const p of m[1].split(delimiter)) if (p) parts.add(p);
  } catch { /* keep what we have */ }
  for (const p of [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']) if (existsSync(p)) parts.add(p);
  process.env.PATH = [...parts].join(delimiter);
  return process.env.PATH;
}

const has = cmd => { try { execFileSync('/usr/bin/which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };

/** Official install commands. Returns { command, how } or null if there's no supported installer on this computer. */
export function installCommand(kind) {
  if (process.platform === 'win32') return null;
  if (kind === 'claude-code') return { command: 'curl -fsSL https://claude.ai/install.sh | bash', how: "Anthropic's official installer" };
  if (kind === 'codex') {
    if (has('brew')) return { command: 'brew install --cask codex', how: 'Homebrew' };
    if (has('npm')) return { command: 'npm install -g @openai/codex', how: 'npm' };
  }
  return null;
}

export const INSTALL_HELP = {
  'claude-code': 'https://docs.claude.com/en/docs/claude-code/setup',
  codex: 'https://github.com/openai/codex',
};

const shq = v => `'${String(v).replace(/'/g, `'\\''`)}'`;

/**
 * Open Terminal running a short script (macOS). The script holds no secrets. Returns false where that isn't possible,
 * so the app can show the command to run by hand instead.
 */
export async function openInTerminal({ dir, name, title, env = {}, lines }) {
  if (process.platform !== 'darwin') return false;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${name.replace(/[^\w-]/g, '_')}.command`);
  await writeFile(file, ['#!/bin/zsh -l', ...Object.entries(env).map(([k, v]) => `export ${k}=${shq(v)}`),
    `echo ${shq(title)}`, 'echo', ...lines,
    `echo; echo 'Done. You can close this window and go back to Unify.js.'`].join('\n') + '\n', { mode: 0o700 });
  return new Promise(r => execFile('open', [file], e => r(!e)));
}
export { shq };

/** Version string, or null if not installed. */
export async function cliVersion(bin) {
  const r = await runCli(bin, ['--version'], { timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim().split('\n')[0] : null;
}

/** One tiny real request, in an empty temporary folder, to prove the AI answers. Uses a little of the person's plan. */
export async function testReply(adapter) {
  const cwd = await mkdtemp(join(tmpdir(), 'unify-setup-'));
  const t0 = Date.now(); let text = '', error = null;
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 120_000);
  try {
    for await (const ev of adapter.run({ prompt: 'This is a connection test from Unify.js. Reply with exactly: UNIFY_OK', cwd, signal: ac.signal })) {
      if (ev.type === 'text') text += ev.text;
      if (ev.type === 'error' || ev.type === 'limit') { error = ev.message ?? ev.reason; break; }
      if (ev.type === 'done') break;
    }
  } catch (e) { error = ac.signal.aborted ? 'No reply within 2 minutes' : e.message; }
  finally { clearTimeout(timer); }
  const ok = !error && /UNIFY_OK/.test(text);
  return { ok, secs: Math.round((Date.now() - t0) / 100) / 10, error: ok ? null : error ?? `Unexpected reply: ${text.slice(0, 120)}` };
}
