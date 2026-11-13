// Unify.js doctor: checks every real connection with tiny requests and writes a shareable report.
//   npm run doctor                 Claude Code + Codex (+ NVIDIA if NVIDIA_API_KEY is set). Free / uses your plans lightly.
//   npm run doctor -- --handoff    also a real Claude Code -> Codex handoff in a throwaway git repo
//   npm run doctor -- --paid       also one tiny DeepSeek request (needs DEEPSEEK_API_KEY; capped at $0.01)
// Everything runs in temporary folders. API keys are read from env vars and never written to the report.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, platform, release } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDb, createRouter, claudeCodeAdapter, codexAdapter, nvidiaAdapter, deepseekAdapter, gitCheckpointer,
} from '../engine/src/index.js';

const args = new Set(process.argv.slice(2));
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.unify-data', 'doctor', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(outDir, { recursive: true });
process.env.UNIFY_RAW_LOG = outDir; // adapters save raw CLI output here, so parser problems can be fixed from real data

const results = [];
const C = { ok: '\x1b[32m✓\x1b[0m', bad: '\x1b[31m✗\x1b[0m', skip: '\x1b[90m–\x1b[0m' };
function report(name, status, detail = '') {
  results.push({ name, status, detail });
  console.log(`${C[status]} ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`);
}
const sh = (cmd, a) => { try { return execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return null; } };
function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'unify-doctor-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'doctor', GIT_AUTHOR_EMAIL: 'doctor@localhost', GIT_COMMITTER_NAME: 'doctor', GIT_COMMITTER_EMAIL: 'doctor@localhost' };
  writeFileSync(join(dir, 'README.md'), '# Unify.js doctor scratch repo\n');
  for (const a of [['init', '-q'], ['add', '.'], ['commit', '-qm', 'init']]) execFileSync('git', a, { cwd: dir, env });
  return dir;
}
async function collect(adapter, opts, ms = 180_000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  const evs = []; const start = Date.now();
  try { for await (const e of adapter.run({ ...opts, signal: ac.signal })) evs.push(e); }
  catch (e) { evs.push({ type: 'error', message: ac.signal.aborted ? `timed out after ${ms / 1000}s` : e.message }); }
  finally { clearTimeout(t); }
  const text = evs.filter(e => e.type === 'text').map(e => e.text).join('');
  return { evs, text, session: evs.find(e => e.type === 'session')?.id, fail: evs.find(e => e.type === 'error' || e.type === 'limit'), secs: ((Date.now() - start) / 1000).toFixed(1) };
}
const PROMPT1 = 'This is a connection test. Reply with exactly the word UNIFY_OK and nothing else. Do not use any tools.';
const PROMPT2 = 'Connection test, part 2: what exact word did you reply with last time? Answer with only that word. Do not use any tools.';

async function checkAgent(label, adapter) {
  if (!(await adapter.status()).available) return report(`${label}: installed`, 'bad', `not found on PATH (${process.env.PATH.split(':').length} dirs searched)`), false;
  const bin = label === 'Claude Code' ? 'claude' : 'codex';
  report(`${label}: installed`, 'ok', sh(bin, ['--version']) ?? '');
  const cwd = tempRepo();
  const r1 = await collect(adapter, { prompt: PROMPT1, cwd });
  if (r1.fail || !/UNIFY_OK/.test(r1.text)) return report(`${label}: replies`, 'bad', r1.fail?.message ?? r1.fail?.reason ?? `unexpected reply: ${JSON.stringify(r1.text.slice(0, 120))}`), false;
  report(`${label}: replies`, 'ok', `${r1.secs}s`);
  if (!r1.session) return report(`${label}: session id`, 'bad', 'no session id in output; resuming will not work'), false;
  report(`${label}: session id`, 'ok');
  const r2 = await collect(adapter, { prompt: PROMPT2, cwd, sessionId: r1.session });
  if (r2.fail || !/UNIFY_OK/.test(r2.text)) return report(`${label}: remembers the conversation (resume)`, 'bad', r2.fail?.message ?? `reply: ${JSON.stringify(r2.text.slice(0, 120))}`), false;
  report(`${label}: remembers the conversation (resume)`, 'ok', `${r2.secs}s`);
  return true;
}

async function checkApi(label, adapter, envName, { maxCostUsd } = {}) {
  if (!process.env[envName]) return report(`${label}`, 'skip', `set ${envName} to test`);
  if (adapter.listModels) {
    try { const ms = await adapter.listModels(); report(`${label}: model catalog`, 'ok', `${ms.length} models`); }
    catch (e) { return report(`${label}: model catalog`, 'bad', e.message); }
  }
  const r = await collect(adapter, { prompt: PROMPT1, maxCostUsd }, 60_000);
  if (r.fail || !/UNIFY_OK/.test(r.text)) return report(`${label}: replies (${adapter.model})`, 'bad', r.fail?.message ?? r.fail?.reason ?? `reply: ${JSON.stringify(r.text.slice(0, 120))}`);
  const u = r.evs.find(e => e.type === 'usage');
  report(`${label}: replies (${adapter.model})`, 'ok', `${r.secs}s${u ? ` · ${u.inputTokens + u.outputTokens} tokens${u.cost != null ? ` · ~$${u.cost.toFixed(6)}` : ''}` : ''}`);
}

async function checkHandoff() {
  const cwd = tempRepo();
  const db = openDb(); db.createProject({ id: 'doc', name: 'doctor', cwd, goal: 'Connection test for Unify.js' });
  db.setPriorities('doc', ['claude-code', 'codex']);
  db.appendEvent('doc', { type: 'decision', data: { text: 'Store data in SQLite (codeword: amber-heron)' } });
  const router = createRouter({ db, adapters: [claudeCodeAdapter(), codexAdapter()], checkpointer: gitCheckpointer({ cwd, projectId: 'doc' }) });
  const r1 = await router.send('doc', "Create a file named notes.txt containing exactly one line: blue-falcon. Don't do anything else.", { cwd });
  if (r1.provider !== 'claude-code' || !existsSync(join(cwd, 'notes.txt'))) return report('Handoff: Claude Code edits a file', 'bad', `outcome ${r1.outcome}; notes.txt ${existsSync(join(cwd, 'notes.txt')) ? 'exists' : 'missing'}`);
  report('Handoff: Claude Code edits a file', 'ok', readFileSync(join(cwd, 'notes.txt'), 'utf8').trim());
  const snap = sh('git', ['-C', cwd, 'rev-parse', '--verify', '-q', 'refs/unify/doc']);
  report('Handoff: git snapshot saved', snap ? 'ok' : 'bad', snap ? snap.slice(0, 7) : 'no refs/unify/doc');
  router.pause('claude-code'); // simulate Claude hitting its limit
  const r2 = await router.send('doc', 'Using only the handoff notes and the files here: what is the codeword in the recorded decision, and what does notes.txt contain? Reply in one short line. Do not change any files.', { cwd });
  const reply = db.events('doc').filter(e => e.provider === 'codex' && e.type === 'text').map(e => e.data.text).join(' ');
  if (r2.provider !== 'codex') return report('Handoff: Codex continues with context', 'bad', `outcome ${r2.outcome}`);
  const gotDecision = /amber-heron/i.test(reply), gotFile = /blue-falcon/i.test(reply);
  report('Handoff: Codex continues with context', gotDecision && gotFile ? 'ok' : 'bad', `decision ${gotDecision ? '✓' : '✗'} · file ${gotFile ? '✓' : '✗'} · "${reply.slice(0, 100)}"`);
}

console.log(`\nUnify.js doctor · results and raw logs: ${outDir}\n`);
const [maj, min] = process.versions.node.split('.').map(Number);
report('Node.js', maj > 22 || (maj === 22 && min >= 13) ? 'ok' : 'bad', `v${process.versions.node}${maj < 22 ? ' (need 22.13+)' : ''}`);
report('git', sh('git', ['--version']) ? 'ok' : 'bad', sh('git', ['--version']) ?? 'not installed');
const claudeOk = await checkAgent('Claude Code', claudeCodeAdapter());
const codexOk = await checkAgent('Codex', codexAdapter());
await checkApi('NVIDIA', nvidiaAdapter({ getKey: async () => process.env.NVIDIA_API_KEY ?? null }), 'NVIDIA_API_KEY');
if (args.has('--paid')) await checkApi('DeepSeek', deepseekAdapter({ getKey: async () => process.env.DEEPSEEK_API_KEY ?? null }), 'DEEPSEEK_API_KEY', { maxCostUsd: 0.01 });
else report('DeepSeek', 'skip', 'paid: run with --paid (and DEEPSEEK_API_KEY) to test; costs well under $0.01');
if (args.has('--handoff')) { if (claudeOk && codexOk) await checkHandoff(); else report('Handoff', 'skip', 'needs both Claude Code and Codex working'); }
else report('Handoff', 'skip', 'run with --handoff for a real Claude Code -> Codex handoff');

const md = [`# Unify.js doctor report`, ``, `${new Date().toISOString()} · ${platform()} ${release()} · Node ${process.versions.node}`, ``,
  ...results.map(r => `- ${r.status === 'ok' ? '✅' : r.status === 'bad' ? '❌' : '➖'} **${r.name}**${r.detail ? ` — ${r.detail}` : ''}`), ``,
  `Raw CLI output (for fixing parsers) is in the *.jsonl files next to this report. It contains the test prompts and replies, no API keys.`].join('\n');
writeFileSync(join(outDir, 'report.md'), md + '\n');
const bad = results.filter(r => r.status === 'bad').length;
console.log(`\n${bad ? `${bad} check(s) failed.` : 'All run checks passed.'} Report: ${join(outDir, 'report.md')}\n`);
process.exit(bad ? 1 : 0);
