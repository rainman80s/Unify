// Simulated Claude Code and Codex for the cloud preview. No accounts, no network, no files touched.
import { fakeAdapter } from '../engine/src/index.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
function streamed(id, name, reply) {
  const a = fakeAdapter({ id, name });
  a.limitPending = false;
  a.run = async function* ({ prompt }) {
    this.prompts.push(prompt);
    const handoff = prompt.startsWith('# Unify.js handoff');
    const request = handoff ? (prompt.match(/## Most recent request from the user\n([\s\S]*?)\n\n##/)?.[1] ?? '') : prompt;
    yield { type: 'session', id: `${id}-demo-session` };
    const words = reply(request, handoff).split(/(?<= )/);
    for (let i = 0; i < words.length; i++) {
      if (this.limitPending && i === Math.floor(words.length / 2)) {
        yield { type: 'file_edit', path: 'src/editor/SlideEditor.tsx' };
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

export function demoAdapters() {
  const claude = streamed('claude-code', 'Claude Code', (req) =>
    `On it. For "${req.slice(0, 80)}", I'll start from the project goal and the decisions so far. First I'll sketch the component structure, then wire up the main controls, keeping the volunteer workflow to as few clicks as possible. I'll note any decisions as I go so they carry over if another model takes over.`);
  const codex = streamed('codex', 'Codex', (req, handoff) =>
    (handoff ? `Picking up from Claude Code's checkpoint. I can see the goal, the recorded decisions, and that src/editor/SlideEditor.tsx was mid-edit, so I'll check that file before changing anything. I won't re-run the interrupted \`npm run build\` until the edit is verified. ` : '') +
    `Continuing with "${req.slice(0, 80)}": next I'll finish the editor layout and add a quick test for the live controls.`);
  return { adapters: [claude, codex], limitNext(id) { const a = id === 'codex' ? codex : claude; a.limitPending = true; } };
}
