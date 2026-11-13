// Router: runs a turn on the highest-priority available provider; on a limit, hands off to the next one
// with a packet built from already-recorded state. Paid providers require explicit approval.
import { randomUUID } from 'node:crypto';
import { refreshCheckpoint, renderHandoffPacket } from './context.js';

export function createRouter({ db, adapters, approvePaid = async () => false, onEvent = () => {} }) {
  const byId = new Map(adapters.map(a => [a.id, a]));
  const cooling = new Map(); // providerId -> retryAt (ms) after hitting a limit

  function record(projectId, ev) {
    const seq = db.appendEvent(projectId, ev);
    refreshCheckpoint(db, projectId); // keep handoff state current after every event
    onEvent({ seq, ...ev });
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
    let prev = null;
    let prompt = text;

    while (true) {
      const [next] = await eligible(projectId, tried);
      if (!next) {
        record(projectId, { type: 'error', data: { message: 'No eligible provider available. Work is saved; resume when a limit resets.' } });
        return { provider: null, handoffs, outcome: 'stalled' };
      }
      tried.add(next.id);
      if (next.billing === 'paid' && !(await approvePaid({ provider: next, projectId }))) {
        record(projectId, { provider: next.id, type: 'skipped', data: { reason: 'paid provider not approved' } });
        continue;
      }
      if (prev) {
        const state = refreshCheckpoint(db, projectId);
        const reason = state.lastError?.message;
        prompt = renderHandoffPacket(state, { from: prev.name, to: next.name, reason });
        handoffs.push({ from: prev.id, to: next.id, reason });
        record(projectId, { provider: next.id, type: 'handoff', data: { from: prev.id, to: next.id, reason } });
      }

      const turnId = randomUUID();
      record(projectId, { turnId, provider: next.id, type: 'turn_start', data: {} });
      let outcome = 'done';
      for await (const ev of next.run({ prompt, cwd, signal })) {
        if (ev.type === 'limit') {
          cooling.set(next.id, ev.retryAt ? Number(ev.retryAt) * (ev.retryAt < 1e12 ? 1000 : 1) : Date.now() + 15 * 60_000);
          record(projectId, { turnId, provider: next.id, type: 'turn_interrupted', data: { reason: ev.reason || 'usage limit' } });
          outcome = 'limit'; break;
        }
        if (ev.type === 'error') { record(projectId, { turnId, provider: next.id, type: 'error', data: { message: ev.message } }); outcome = 'error'; break; }
        if (ev.type === 'done') break;
        const { type, ...data } = ev;
        record(projectId, { turnId, provider: next.id, type, data });
      }
      if (outcome === 'done') {
        record(projectId, { turnId, provider: next.id, type: 'turn_end', data: {} });
        return { provider: next.id, handoffs, outcome };
      }
      if (outcome === 'error') {
        record(projectId, { turnId, provider: next.id, type: 'turn_interrupted', data: { reason: 'error' } });
      }
      prev = next;
    }
  }

  return { send };
}
