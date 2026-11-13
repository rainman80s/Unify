// Scripted adapter for tests and the cloud demo. `script` is a list of events; a 'limit' event simulates running out.
export function fakeAdapter({ id, name = id, billing = 'subscription', script = [], available = true, onPrompt } = {}) {
  return {
    id, name, billing, prompts: [],
    async status() { return available ? { available: true } : { available: false, reason: 'offline' }; },
    async *run({ prompt }) {
      this.prompts.push(prompt);
      onPrompt?.(prompt);
      const s = typeof script === 'function' ? script(prompt) : script;
      for (const ev of s) { yield ev; if (ev.type === 'limit' || ev.type === 'error') return; }
    },
  };
}
