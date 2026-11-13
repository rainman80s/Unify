// Chat-completions adapter for OpenAI-compatible APIs (DeepSeek, NVIDIA NIM, OpenRouter, ...).
// These are paid / metered: the router only uses them with the user's approval and under a spending cap.
// Chat-only: the model cannot edit files or run commands, so it is told to propose changes instead.
import { randomUUID } from 'node:crypto';
import { looksLikeLimit } from './base.js';

const SYSTEM = `You are working inside Unify.js in chat-only mode: you cannot run commands, read files, or edit files yourself.
Give concrete code and exact steps; the user or a coding agent will apply them. Say clearly what you could not verify.`;

/** Parse a server-sent-events body into JSON chunks. */
export async function* sseJson(body) {
  const dec = new TextDecoder(); let buf = '';
  for await (const part of body) {
    buf += dec.decode(part, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try { yield JSON.parse(data); } catch { /* ignore keep-alives */ }
    }
  }
}

/** Clean up a pasted key: stray whitespace, quotes, a leading "Bearer ", or a whole sample program with the key inside. */
export function normalizeKey(key) {
  if (typeof key !== 'string') return key ?? null;
  const embedded = key.match(/\bnvapi-[A-Za-z0-9_-]{20,}/); // NVIDIA's "Copy" button copies sample code, not just the key
  if (embedded) return embedded[0];
  const k = key.trim().replace(/^["']|["']$/g, '').trim().replace(/^Bearer\s+/i, '').trim();
  return k || null;
}

/**
 * id, name, baseUrl, model: provider details.
 * getKey(): reads the key from secure storage at call time. The key is never written to events or logs.
 * pricePerMTok: { input, output } in USD per million tokens (an estimate; verify current pricing), or null if unknown.
 */
export function openAICompatibleAdapter({ id, name, baseUrl, model, getModel = null, getKey, pricePerMTok = null, billing = 'paid',
  rateLimitPauseMs = null, note = null, fetchImpl = globalThis.fetch }) {
  const currentModel = () => (getModel && getModel()) || model;
  const readKey = async () => normalizeKey(await getKey());
  const histories = new Map(); // sessionId -> messages (in memory; the project log is the durable record)
  return {
    id, name, billing, chatOnly: true, needsKey: true, note, pricePerMTok,
    get model() { return currentModel(); },
    /** List models the key can use (OpenAI-compatible GET /models). */
    async listModels() {
      const key = await readKey(); if (!key) throw new Error(`${name}: no API key`);
      const r = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${key}` } });
      if (!r.ok) throw new Error(r.status === 401 ? `${name}: the API key was rejected` : `${name}: HTTP ${r.status}`);
      const j = await r.json();
      return (j.data ?? []).map(m => ({ id: m.id, owner: m.owned_by ?? m.id.split('/')[0] })).sort((a, b) => a.id.localeCompare(b.id));
    },
    async status() { return (await readKey()) ? { available: true } : { available: false, reason: 'No API key added' }; },
    async *run({ prompt, signal, sessionId, maxCostUsd = Infinity }) {
      const key = await readKey();
      if (!key) { yield { type: 'error', message: `${name}: no API key` }; return; }
      const sid = sessionId && histories.has(sessionId) ? sessionId : randomUUID();
      const messages = histories.get(sid) ?? [{ role: 'system', content: SYSTEM }];
      messages.push({ role: 'user', content: prompt });
      histories.set(sid, messages);
      yield { type: 'session', id: sid };

      // Usage is only reported at the end of a reply, so bound the reply up front to what the budget allows.
      let maxTokens;
      if (Number.isFinite(maxCostUsd) && pricePerMTok) {
        const estInputTokens = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 3); // generous estimate
        const left = maxCostUsd - (estInputTokens * pricePerMTok.input) / 1e6;
        maxTokens = Math.floor((left * 1e6) / pricePerMTok.output);
        if (maxTokens < 64) { messages.pop(); yield { type: 'limit', reason: `${name}: not enough budget left under your spending cap` }; return; }
        maxTokens = Math.min(maxTokens, 8192);
      }

      let res;
      try {
        res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST', signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: currentModel(), messages, stream: true, stream_options: { include_usage: true }, ...(maxTokens ? { max_tokens: maxTokens } : {}) }),
        });
      } catch (e) { yield { type: 'error', message: `${name}: ${e.message}` }; return; }
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 500);
        if (res.status === 429 || res.status === 402 || looksLikeLimit(text))
          yield { type: 'limit', reason: res.status === 402 ? `${name}: out of credit` : `${name}: rate limited (${res.status})`,
            ...(res.status === 429 && rateLimitPauseMs ? { retryAt: Date.now() + rateLimitPauseMs } : {}) };
        else if (res.status === 404 || res.status === 410)
          yield { type: 'error', message: `${name}: the model '${currentModel()}' is not available (retired, renamed, or not on your account). Choose another model in My AIs.`, detail: text };
        else yield { type: 'error', message: res.status === 401 ? `${name}: the API key was rejected (check that you copied the whole key and that it hasn't been replaced by a newer one)${text ? `. ${name} said: ${text.slice(0, 200)}` : ''}` : `${name}: HTTP ${res.status} ${text}` };
        return;
      }
      let reply = '';
      for await (const chunk of sseJson(res.body)) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) { reply += delta; yield { type: 'text', text: delta }; }
        if (chunk.usage) {
          const inTok = chunk.usage.prompt_tokens ?? 0, outTok = chunk.usage.completion_tokens ?? 0;
          const cost = pricePerMTok ? (inTok * pricePerMTok.input + outTok * pricePerMTok.output) / 1e6 : null;
          yield { type: 'usage', inputTokens: inTok, outputTokens: outTok, cost };
        }
      }
      messages.push({ role: 'assistant', content: reply });
      yield { type: 'done' };
    },
  };
}

// DeepSeek defaults. Prices are an ESTIMATE for deepseek-chat (USD per 1M tokens, cache-miss input).
// Check https://api-docs.deepseek.com/quick_start/pricing before relying on them.
export const deepseekAdapter = ({ getKey, fetchImpl, model = 'deepseek-chat' } = {}) => openAICompatibleAdapter({
  id: 'deepseek', name: 'DeepSeek API', baseUrl: 'https://api.deepseek.com', model, getKey, fetchImpl,
  pricePerMTok: { input: 0.28, output: 0.42 },
});

// NVIDIA API catalog (build.nvidia.com). OpenAI-compatible. Free trial access is rate-limited (reported ~40 requests/min
// per model) and meant for prototyping, not production; terms and limits change, so it's labelled as a trial, never "unlimited".
// A 429 here usually clears within a minute, so it only pauses briefly instead of the long default cooldown.
export const nvidiaAdapter = ({ getKey, getModel, fetchImpl, model = 'mistralai/mistral-large-4-1t-a52b' } = {}) => openAICompatibleAdapter({
  id: 'nvidia', name: 'NVIDIA', baseUrl: 'https://integrate.api.nvidia.com/v1', model, getModel, getKey, fetchImpl,
  billing: 'trial', rateLimitPauseMs: 60_000,
  note: 'Free trial access: rate-limited and for prototyping, not production. Check NVIDIA\'s current terms for each model.',
});
