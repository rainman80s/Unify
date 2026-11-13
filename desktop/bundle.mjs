// Copy the engine and web app into desktop/bundle so electron-builder can package them.
import { cpSync, rmSync, writeFileSync } from 'node:fs';
const opts = { recursive: true, filter: src => !src.includes('node_modules') };
rmSync('bundle', { recursive: true, force: true });
cpSync('../app', 'bundle/app', opts);
cpSync('../engine/src', 'bundle/engine/src', opts);
writeFileSync('bundle/package.json', JSON.stringify({ type: 'module' }) + '\n'); // app/ and engine/ are ES modules
console.log('bundled app/ and engine/src/ into desktop/bundle');
