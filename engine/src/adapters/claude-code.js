// Claude Code adapter: drives the user's own, already-signed-in `claude` CLI.
// Unify.js never handles Claude credentials; billing is whatever the user's Claude Code uses.
// Stream format: `claude -p --output-format stream-json --verbose`. Verify against the installed version.
import { spawnJsonLines, cliInstalled, looksLikeLimit } from './base.js';

export function parseClaudeLine(msg) {
  const out = [];
  if (msg.type === 'assistant') {
    for (const b of msg.message?.content ?? []) {
      if (b.type === 'text') out.push({ type: 'text', text: b.text });
      else if (b.type === 'tool_use') {
        const input = b.input ?? {};
        if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(b.name) && input.file_path) out.push({ type: 'file_edit', path: input.file_path });
        else if (b.name === 'Bash') out.push({ type: 'command_start', id: b.id, cmd: input.command });
      }
    }
  } else if (msg.type === 'user') {
    for (const b of msg.message?.content ?? []) if (b.type === 'tool_result') out.push({ type: 'command_end', id: b.tool_use_id, ok: !b.is_error });
  } else if (msg.type === 'result') {
    const text = String(msg.result ?? msg.error ?? msg.subtype ?? '');
    if (msg.is_error || msg.subtype?.startsWith('error')) out.push(looksLikeLimit(text) ? { type: 'limit', reason: text } : { type: 'error', message: text });
    else out.push({ type: 'done', sessionId: msg.session_id });
  } else if (msg.type === 'rate_limit_event' || (msg.type === 'system' && looksLikeLimit(msg.message ?? ''))) {
    if (msg.rate_limit_info?.status !== 'allowed') out.push({ type: 'limit', reason: msg.message ?? 'rate limited', retryAt: msg.rate_limit_info?.resetsAt });
  }
  return out;
}

export function claudeCodeAdapter({ bin = 'claude', permissionMode = 'acceptEdits' } = {}) {
  return {
    id: 'claude-code', name: 'Claude Code', billing: 'subscription',
    async status() {
      return (await cliInstalled(bin)) ? { available: true } : { available: false, reason: 'Claude Code CLI not installed' };
    },
    async *run({ prompt, cwd, signal }) {
      const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', permissionMode];
      for await (const item of spawnJsonLines(bin, args, { cwd, signal })) {
        if (item.json) yield* parseClaudeLine(item.json);
        else if (item.exit && item.exit.code !== 0) {
          yield looksLikeLimit(item.exit.stderr) ? { type: 'limit', reason: item.exit.stderr.trim() } : { type: 'error', message: item.exit.stderr.trim() || `exit ${item.exit.code}` };
        }
      }
    },
  };
}
