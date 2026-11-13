// Codex adapter: drives the user's own, already-signed-in `codex` CLI (ChatGPT plan or API key, set up in Codex itself).
// Stream format: `codex exec --json`. Verify event names against the installed version.
import { spawnJsonLines, cliInstalled, looksLikeLimit } from './base.js';

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
    case 'turn.failed':
    case 'error': {
      const m = msg.error?.message ?? msg.message ?? 'Codex error';
      return [looksLikeLimit(m) ? { type: 'limit', reason: m } : { type: 'error', message: m }];
    }
    default: return [];
  }
}

export function codexAdapter({ bin = 'codex', sandbox = 'workspace-write' } = {}) {
  return {
    id: 'codex', name: 'Codex', billing: 'subscription',
    async status() {
      return (await cliInstalled(bin)) ? { available: true } : { available: false, reason: 'Codex CLI not installed' };
    },
    async *run({ prompt, cwd, signal, sessionId }) {
      const base = ['--json', '--sandbox', sandbox, ...(cwd ? ['--cd', cwd] : [])];
      // Verify `exec resume` flags against the installed Codex version.
      const args = sessionId ? ['exec', 'resume', ...base, sessionId, prompt] : ['exec', ...base, prompt];
      for await (const item of spawnJsonLines(bin, args, { cwd, signal })) {
        if (item.json) yield* parseCodexLine(item.json);
        else if (item.exit && item.exit.code !== 0) {
          yield looksLikeLimit(item.exit.stderr) ? { type: 'limit', reason: item.exit.stderr.trim() } : { type: 'error', message: item.exit.stderr.trim() || `exit ${item.exit.code}` };
        }
      }
    },
  };
}
