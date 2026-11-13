// Simulated Claude Code -> Codex handoff. Run: npm run demo
import { openDb, createRouter, fakeAdapter } from './src/index.js';
const db = openDb();
db.createProject({ id: 'demo', name: 'Church presentation app', goal: 'Volunteer-friendly presentation app for live church production' });
db.setPriorities('demo', ['claude-code', 'codex']);
const claude = fakeAdapter({ id: 'claude-code', name: 'Claude Code', script: [
  { type: 'decision', text: 'Keep the live controls to three big buttons' },
  { type: 'text', text: 'Drafting the slide editor layout...' },
  { type: 'file_edit', path: 'src/editor/SlideEditor.tsx' },
  { type: 'limit', reason: 'Claude usage limit reached (simulated)' },
] });
const codex = fakeAdapter({ id: 'codex', name: 'Codex', script: [{ type: 'text', text: 'Picked up the editor layout.' }, { type: 'done' }],
  onPrompt: p => console.log('\n----- packet sent to Codex -----\n' + p) });
const r = await createRouter({ db, adapters: [claude, codex] }).send('demo', 'Build the slide editor');
console.log('Result:', r);
