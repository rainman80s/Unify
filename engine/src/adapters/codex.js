// Codex adapter: drives the user's own, already-signed-in `codex` CLI (ChatGPT plan or API key, set up in Codex itself).
// Stream format: `codex exec --json`, checked against codex-cli 0.169:
//   {"type":"thread.started","thread_id":"…"} {"type":"turn.started"} item.started / item.completed … turn.completed | turn.failed
//   It also emits transient {"type":"error","message":"Reconnecting... 2/5 (…)"} lines while retrying, which are not fatal.
// `codex exec resume` does NOT accept --sandbox / --cd, so a resumed turn sets the sandbox via -c and runs in cwd.
import { spawnJsonLines, cliInstalled, looksLikeLimit } from './base.js';

const AUTH = /401|unauthori[sz]ed|not logged in|please (log|sign) ?in|missing bearer/i;

export function parseCodexLine(msg) {
  const item = msg.item ?? {};
  switch (msg.type) {
    case 'thread.started': return msg.thread_id ? [{ type: 'session', id: msg.thread_id }] : [];
    case 'item.started':
      if (item.type === 'command_execution') return [{ type: 'command_start', id: item.id, cmd: item.command }];
      return [];
    case 'item.completed':
      if (item.type === 'agent_message') return [{ type: 'text', text: item.text }];
      if (item.type === 'command_execution') return [{ type: 'command_end', id: item.id, ok: item.exit_code === 0 }];
      if (item.type === 'file_change') return (item.changes ?? []).map(c => ({ type: 'file_edit', path: c.path }));
      return [];
    case 'turn.completed': return [{ type: 'done' }];
    case 'error':
      if (/^Reconnecting/i.test(msg.message ?? '')) return []; // Codex is retrying on its own
    // falls through
    case 'turn.failed': {
      const m = msg.error?.message ?? msg.message ?? 'Codex error';
      if (AUTH.test(m)) return [{ type: 'error', message: 'Codex is not signed in. Run `codex login` in Terminal, then try again.' }];
      return [looksLikeLimit(m) ? { type: 'limit', reason: m } : { type: 'error', message: m }];
    }
    default: return [];
  }
}

export function codexArgs({ prompt, cwd, sessionId, sandbox = 'workspace-write' }) {
  return sessionId
    ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${sandbox}"`, sessionId, prompt]
    : ['exec', '--json', '--skip-git-repo-check', '--sandbox', sandbox, ...(cwd ? ['--cd', cwd] : []), prompt];
}

export function codexAdapter({ bin = 'codex', sandbox = 'workspace-write' } = {}) {
  return {
    id: 'codex', name: 'Codex', billing: 'subscription',
    async status() {
      return (await cliInstalled(bin)) ? { available: true } : { available: false, reason: 'Codex CLI not installed' };
    },
    async *run({ prompt, cwd, signal, sessionId }) {
      let finished = false;
      for await (const item of spawnJsonLines(bin, codexArgs({ prompt, cwd, sessionId, sandbox }), { cwd, signal, rawLog: 'codex' })) {
        if (item.json) {
          for (const ev of parseCodexLine(item.json)) { if (['done', 'error', 'limit'].includes(ev.type)) finished = true; yield ev; }
        } else if (item.exit) {
          if (item.exit.code !== 0 && !finished) {
            const e = item.exit.stderr.trim();
            yield AUTH.test(e) ? { type: 'error', message: 'Codex is not signed in. Run `codex login` in Terminal, then try again.' }
              : looksLikeLimit(e) ? { type: 'limit', reason: e } : { type: 'error', message: e || `exit ${item.exit.code}` };
          } else if (!finished) yield { type: 'error', message: 'Codex stopped without finishing its turn.' };
        }
      }
    },
  };
}
