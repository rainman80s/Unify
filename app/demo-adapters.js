// Simulated Claude Code and Codex for the cloud preview. No accounts or network; they only write into a throwaway demo repo.
import { fakeAdapter } from '../engine/src/index.js';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const wait = ms => new Promise(r => setTimeout(r, ms));
function streamed(id, name, reply, cwd) {
  const touch = (path, line) => { const f = join(cwd, path); mkdirSync(dirname(f), { recursive: true }); appendFileSync(f, line + '\n'); };
  const a = fakeAdapter({ id, name });
  a.limitPending = false;
  a.run = async function* ({ prompt }) {
    this.prompts.push(prompt);
    const handoff = prompt.startsWith('# Unify.js handoff');
    const request = handoff ? (prompt.match(/## Most recent request from the user\n([\s\S]*?)\n\n##/)?.[1] ?? '') : prompt;
    yield { type: 'session', id: `${id}-demo-session` };
    const words = reply(request, handoff).split(/(?<= )/);
    for (let i = 0; i < words.length; i++) {
      if (i === Math.floor(words.length / 2)) {
        const path = id === 'codex' ? 'src/editor/SlideList.tsx' : 'src/editor/SlideEditor.tsx';
        if (!a.chatOnly) touch(path, `// ${name}: ${request.slice(0, 60)}`);
        yield { type: 'file_edit', path };
      }
      if (this.limitPending && i === Math.floor(words.length / 2)) {
        yield { type: 'command_start', id: `cmd-${Date.now()}`, cmd: 'npm run build' };
        await wait(300);
        this.limitPending = false;
        yield { type: 'limit', reason: `${name} usage limit reached (simulated)` };
        return;
      }
      yield { type: 'text', text: words[i] }; await wait(35);
    }
    yield { type: 'done' };
  };
  return a;
}

export function demoAdapters({ cwd, getModel = () => () => null }) {
  const claude = streamed('claude-code', 'Claude Code', (req) =>
    `On it. For "${req.slice(0, 80)}", I'll start from the project goal and the decisions so far. First I'll sketch the component structure, then wire up the main controls, keeping the volunteer workflow to as few clicks as possible. I'll note any decisions as I go so they carry over if another model takes over.`, cwd);
  const codex = streamed('codex', 'Codex', (req, handoff) =>
    (handoff ? `Picking up from Claude Code's checkpoint. I can see the goal, the recorded decisions, and that src/editor/SlideEditor.tsx was mid-edit, so I'll check that file before changing anything. I won't re-run the interrupted \`npm run build\` until the edit is verified. ` : '') +
    `Continuing with "${req.slice(0, 80)}": next I'll finish the editor layout and add a quick test for the live controls.`, cwd);
  // Simulated paid API: chat-only, reports token usage and an (illustrative) cost. No money is involved.
  const deepseek = streamed('deepseek', 'DeepSeek API', (req, handoff) =>
    (handoff ? `Picking up from the checkpoint in chat-only mode, so I can't edit files myself. ` : '') +
    `For "${req.slice(0, 80)}", here is the change I'd make next, as a patch for you or Claude Code to apply later.`, cwd);
  Object.assign(deepseek, { billing: 'paid', chatOnly: true, model: 'deepseek-chat', pricePerMTok: { input: 0.28, output: 0.42 } });
  const baseRun = deepseek.run;
  deepseek.run = async function* (o) {
    for await (const ev of baseRun.call(this, o)) {
      if (ev.type === 'file_edit') continue; // chat-only: it can't touch files
      if (ev.type === 'done') { const i = Math.ceil(o.prompt.length / 3), out = 400; yield { type: 'usage', inputTokens: i, outputTokens: out, cost: (i * 0.28 + out * 0.42) / 1e6 }; }
      yield ev;
    }
  };
  // Simulated NVIDIA catalog model: free trial, chat-only, no cost.
  const nvidia = streamed('nvidia', 'NVIDIA', (req, handoff) =>
    `${handoff ? 'Continuing from the saved checkpoint in chat-only mode. ' : ''}(${nvidia.model}) For "${req.slice(0, 80)}", here's a suggested approach you can hand back to Claude Code.`, cwd);
  const nvModel = getModel('nvidia');
  Object.assign(nvidia, { billing: 'trial', chatOnly: true, needsKey: true,
    note: 'Simulated. Real NVIDIA trial access is rate-limited and for prototyping, not production.' });
  Object.defineProperty(nvidia, 'model', { get: () => nvModel() || 'mistralai/mistral-large-4-1t-a52b' });
  // A small, illustrative sample of what the catalog lists. The real list comes from NVIDIA's /v1/models with your key.
  nvidia.listModels = async () => ['deepseek-ai/deepseek-r1', 'google/gemma-3-27b-it', 'meta/llama-3.1-8b-instruct', 'mistralai/mistral-large-4-1t-a52b',
    'microsoft/phi-4-mini-instruct', 'mistralai/mistral-small-24b-instruct', 'nvidia/llama-3.3-nemotron-super-49b-v1', 'qwen/qwen2.5-coder-32b-instruct',
    'qwen/qwq-32b'].map(id => ({ id, owner: id.split('/')[0] }));
  const nvRun = nvidia.run;
  nvidia.run = async function* (o) { for await (const ev of nvRun.call(this, o)) if (ev.type !== 'file_edit') yield ev; };
  deepseek.needsKey = true;
  const all = { 'claude-code': claude, codex, nvidia, deepseek };
  return { adapters: [claude, codex, nvidia, deepseek], limitNext(id) { (all[id] ?? claude).limitPending = true; } };
}
