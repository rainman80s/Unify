// Router: runs a turn on the highest-priority available provider; on a limit, hands off to the next one
// with a packet built from already-recorded state.
// Paid providers are never used silently: approvePaid({ provider, projectId, spentUsd }) must return
// { capUsd } (allow up to that total spend for this project) or false. The cap is enforced mid-turn.
import { randomUUID } from 'node:crypto';
import { refreshCheckpoint, renderHandoffPacket } from './context.js';

export function createRouter({ db, adapters, approvePaid = async () => false, onEvent = () => {}, checkpointer = null }) {
  const byId = new Map(adapters.map(a => [a.id, a]));
  const cooling = new Map(); // providerId -> retryAt (ms) after hitting a limit
  const approvals = new Map(); // `${projectId}:${providerId}` -> capUsd

  function record(projectId, ev) {
    const seq = db.appendEvent(projectId, ev);
    refreshCheckpoint(db, projectId); // keep handoff state current after every event
    onEvent({ seq, projectId, ...ev });
  }

  async function snapshot(projectId, provider, turnId, label) {
    if (!checkpointer) return;
    try {
      const cp = await checkpointer.checkpoint({ provider, label });
      if (cp && !cp.unchanged) record(projectId, { turnId, provider, type: 'git_checkpoint', data: cp });
    } catch (e) { record(projectId, { turnId, provider, type: 'error', data: { message: `Checkpoint failed: ${e.message}` } }); }
  }

  async function eligible(projectId, exclude) {
    const order = db.priorities(projectId);
    const out = [];
    for (const id of order) {
      const a = byId.get(id);
      if (!a || exclude.has(id)) continue;
      if ((cooling.get(id) ?? 0) > Date.now()) continue;
      if (!(await a.status()).available) continue;
      out.push(a);
    }
    return out;
  }

  /** Send a user message. Returns { provider, handoffs: [{from,to,reason}], outcome }. */
  async function send(projectId, text, { cwd, signal } = {}) {
    record(projectId, { type: 'user_message', data: { text } });
    const tried = new Set();
    const handoffs = [];
    const before = refreshCheckpoint(db, projectId);
    let prev = before.lastProvider ? byId.get(before.lastProvider) ?? { id: before.lastProvider, name: before.lastProvider } : null;
    let prevReason = null;

    while (true) {
      const [next] = await eligible(projectId, tried);
      if (!next) {
        record(projectId, { type: 'error', data: { message: 'No eligible provider available. Work is saved; resume when a limit resets.' } });
        return { provider: null, handoffs, outcome: 'stalled' };
      }
      tried.add(next.id);
      let capUsd = Infinity;
      if (next.billing === 'paid') {
        const k = `${projectId}:${next.id}`;
        const spentUsd = refreshCheckpoint(db, projectId).spend[next.id]?.usd ?? 0;
        if (!(approvals.get(k) > spentUsd)) {
          const ok = await approvePaid({ provider: next, projectId, spentUsd });
          if (!ok || !(ok.capUsd > spentUsd)) {
            record(projectId, { provider: next.id, type: 'skipped', data: { reason: 'Paid provider not approved, so it was not used.' } });
            continue;
          }
          approvals.set(k, ok.capUsd);
          record(projectId, { provider: next.id, type: 'paid_approved', data: { capUsd: ok.capUsd } });
        }
        capUsd = approvals.get(k);
      }
      // Same provider as last turn: just continue its session. Different provider: send the handoff packet.
      let prompt = text;
      const state = refreshCheckpoint(db, projectId);
      if (prev && prev.id !== next.id) {
        const reason = prevReason ?? (cooling.has(prev.id) ? state.lastError?.message ?? 'paused' : 'switched by priority order');
        prompt = renderHandoffPacket(state, { from: prev.name, to: next.name, reason });
        handoffs.push({ from: prev.id, to: next.id, reason });
        record(projectId, { provider: next.id, type: 'handoff', data: { from: prev.id, to: next.id, reason, packet: prompt } });
      }
      const sessionId = state.sessions[next.id];

      const turnId = randomUUID();
      record(projectId, { turnId, provider: next.id, type: 'turn_start', data: {} });
      let outcome = 'done';
      const turnAbort = new AbortController();
      signal?.addEventListener('abort', () => turnAbort.abort(), { once: true });
      for await (const ev of next.run({ prompt, cwd, signal: turnAbort.signal, sessionId: prev?.id === next.id ? sessionId : undefined,
        maxCostUsd: capUsd - (refreshCheckpoint(db, projectId).spend[next.id]?.usd ?? 0) })) {
        if (ev.type === 'limit') {
          cooling.set(next.id, ev.retryAt ? Number(ev.retryAt) * (ev.retryAt < 1e12 ? 1000 : 1) : Date.now() + 15 * 60_000);
          record(projectId, { turnId, provider: next.id, type: 'turn_interrupted', data: { reason: ev.reason || 'usage limit' } });
          outcome = 'limit'; break;
        }
        if (ev.type === 'error') { record(projectId, { turnId, provider: next.id, type: 'error', data: { message: ev.message } }); outcome = 'error'; break; }
        if (ev.type === 'done') break;
        const { type, ...data } = ev;
        record(projectId, { turnId, provider: next.id, type, data });
        if (type === 'usage' && (refreshCheckpoint(db, projectId).spend[next.id]?.usd ?? 0) >= capUsd) {
          approvals.delete(`${projectId}:${next.id}`);
          record(projectId, { turnId, provider: next.id, type: 'turn_interrupted', data: { reason: `Spending cap of $${capUsd.toFixed(2)} reached for ${next.name}` } });
          outcome = 'cap'; break;
        }
      }
      await snapshot(projectId, next.id, turnId, outcome === 'done' ? 'turn finished' : `stopped: ${outcome}`);
      if (outcome === 'done') {
        record(projectId, { turnId, provider: next.id, type: 'turn_end', data: {} });
        return { provider: next.id, handoffs, outcome };
      }
      if (outcome === 'cap') turnAbort.abort(); // after leaving the stream, so the adapter can close cleanly
      if (outcome === 'cap') { await snapshot(projectId, next.id, turnId, 'stopped: spending cap'); return { provider: null, handoffs, outcome: 'cap' }; }
      if (outcome === 'error') {
        record(projectId, { turnId, provider: next.id, type: 'turn_interrupted', data: { reason: 'error' } });
      }
      prev = next;
      prevReason = refreshCheckpoint(db, projectId).lastError?.message;
    }
  }

  /** Manually take a provider out of rotation (e.g. "Hand off now"), or put it back. */
  function pause(providerId, ms = 60 * 60_000) { cooling.set(providerId, Date.now() + ms); }
  function resume(providerId) { cooling.delete(providerId); }
  function revokePaid(projectId, providerId) { approvals.delete(`${projectId}:${providerId}`); }

  async function statuses(projectId) {
    return Promise.all(db.priorities(projectId).map(async id => {
      const a = byId.get(id);
      if (!a) return { id, name: id, available: false, reason: 'not configured' };
      const until = cooling.get(id) ?? 0;
      if (until > Date.now()) return { id, name: a.name, billing: a.billing, available: false, reason: 'limit / paused', until };
      return { id, name: a.name, billing: a.billing, ...(await a.status()) };
    }));
  }

  return { send, pause, resume, statuses, revokePaid, approvalFor: (projectId, id) => approvals.get(`${projectId}:${id}`) ?? null };
}
