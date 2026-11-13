// Context engine: folds events into structured state continuously, and renders handoff packets.
// Nothing here calls a model, so the packet is always ready even if the active provider just died.

export function emptyState(project) {
  return {
    goal: project.goal || '',
    decisions: [],      // { text, by, at }
    tasks: [],          // { id, text, status }
    filesTouched: [],
    commandsRun: [],    // { cmd, provider, completed }
    lastUserRequest: '',
    lastAssistantText: '',
    inFlight: null,     // { provider, turnId, step } while a turn is running
    interrupted: [],    // side-effecting actions that started but never confirmed completion
    lastError: null,
    providersUsed: [],
    lastProvider: null, // who ran the most recent turn
    sessions: {},
    spend: {},         // providerId -> { usd, inputTokens, outputTokens, unpriced } for metered providers
    checkpoint: null,   // { commit, base, diffstat } latest git snapshot of the working tree       // providerId -> provider-side session id, for resuming
  };
}

const MAX_TEXT = 4000;
const uniqPush = (arr, v) => { if (v && !arr.includes(v)) arr.push(v); };

export function applyEvent(state, ev) {
  const s = state;
  const d = ev.data;
  if (ev.provider) uniqPush(s.providersUsed, ev.provider);
  switch (ev.type) {
    case 'user_message': s.lastUserRequest = d.text; break;
    case 'turn_start': s.lastProvider = ev.provider; s.inFlight = { provider: ev.provider, turnId: ev.turn_id, step: 'starting' }; s.lastAssistantText = ''; break;
    case 'text': s.lastAssistantText = (s.lastAssistantText + d.text).slice(-MAX_TEXT); if (s.inFlight) s.inFlight.step = 'writing a response'; break;
    case 'file_edit': uniqPush(s.filesTouched, d.path); if (s.inFlight) s.inFlight.step = `editing ${d.path}`; break;
    case 'command_start':
      s.commandsRun.push({ cmd: d.cmd, provider: ev.provider, completed: false, id: d.id });
      if (s.inFlight) s.inFlight.step = `running \`${d.cmd}\``; break;
    case 'command_end': { const c = s.commandsRun.find(c => c.id === d.id); if (c) c.completed = true; break; }
    case 'decision': s.decisions.push({ text: d.text, by: ev.provider || 'user', at: ev.at }); break;
    case 'task': {
      const t = s.tasks.find(t => t.id === d.id);
      if (t) Object.assign(t, d); else s.tasks.push({ status: 'open', ...d });
      break;
    }
    case 'git_checkpoint': s.checkpoint = { commit: d.commit, base: d.base, diffstat: d.diffstat, by: ev.provider }; break;
    case 'usage': {
      const sp = s.spend[ev.provider] ??= { usd: 0, inputTokens: 0, outputTokens: 0, unpriced: false };
      sp.inputTokens += d.inputTokens ?? 0; sp.outputTokens += d.outputTokens ?? 0;
      if (d.cost == null) sp.unpriced = true; else sp.usd += d.cost;
      break;
    }
    case 'session': s.sessions[ev.provider] = d.id; break;
    case 'goal': s.goal = d.text; break;
    case 'error': s.lastError = { provider: ev.provider, message: d.message }; break;
    case 'turn_end':
      s.inFlight = null; break;
    case 'turn_interrupted':
      // Record what was mid-flight; never auto-replay it.
      for (const c of s.commandsRun) if (!c.completed && !s.interrupted.some(i => i.id === c.id)) s.interrupted.push({ ...c });
      s.lastError = { provider: ev.provider, message: d.reason };
      if (s.inFlight) s.inFlight.interruptedBecause = d.reason;
      break;
  }
  return s;
}

/** Bring a project's checkpoint up to date with every event so far. Cheap; run after every event. */
export function refreshCheckpoint(db, projectId) {
  const project = db.getProject(projectId);
  const cp = db.latestCheckpoint(projectId);
  const state = cp ? cp.state : emptyState(project);
  const evs = db.events(projectId, cp ? cp.upto_seq : 0);
  if (!evs.length && cp) return cp.state;
  for (const ev of evs) applyEvent(state, ev);
  db.saveCheckpoint(projectId, evs.length ? evs.at(-1).seq : 0, state);
  return state;
}

/** Render the prompt the next provider receives. Plain text so every provider can read it. */
export function renderHandoffPacket(state, { from, to, reason }) {
  const list = (xs, f) => xs.length ? xs.map(f).join('\n') : '- (none recorded)';
  const missing = [];
  if (!state.goal) missing.push('No project goal has been set.');
  if (!state.decisions.length) missing.push('No decisions have been recorded yet.');
  return `# Unify.js handoff
You are continuing work started by ${from}${reason ? ` (stopped: ${reason})` : ''}. You are ${to}.
The user's project state below was recorded by Unify.js as the work happened. Trust the repository over this summary if they disagree.

## Goal
${state.goal || '(not set)'}

## Decisions and constraints
${list(state.decisions, d => `- ${d.text} (by ${d.by})`)}

## Tasks
${list(state.tasks, t => `- [${t.status === 'done' ? 'x' : ' '}] ${t.text}`)}

## Most recent request from the user
${state.lastUserRequest || '(none)'}

## Where the previous model stopped
${state.inFlight ? `It was ${state.inFlight.step}.` : 'Its last turn had finished.'}
Last output (may be cut off):
"""
${state.lastAssistantText.slice(-1500) || '(none)'}
"""

## Files touched so far
${list(state.filesTouched, f => `- ${f}`)}

## Code checkpoint
${state.checkpoint ? `Unify.js saved the working tree after ${state.checkpoint.by}'s last turn as commit ${state.checkpoint.commit.slice(0, 12)} (ref refs/unify/...).${state.checkpoint.base ? `\nChanges since HEAD (\`git diff ${state.checkpoint.base.slice(0, 12)} ${state.checkpoint.commit.slice(0, 12)}\`):\n${state.checkpoint.diffstat || '(none)'}` : ''}` : '(no git checkpoint: not a git repository)'}

## Interrupted actions — DO NOT re-run without checking
${list(state.interrupted, c => `- \`${c.cmd}\` (started by ${c.provider}, completion unknown)`)}

## Known gaps
${missing.length ? missing.map(m => `- ${m}`).join('\n') : '- None detected.'}

Continue from where the work stopped. First check the current files for any partial edits.
`;
}
