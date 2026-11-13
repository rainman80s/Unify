// API key storage. Keys are only ever read by the local server process when a request is made;
// they are never sent to the UI, written to the project log, or included in handoff packets.
//
// - Desktop app: pass encrypt/decrypt backed by Electron safeStorage (macOS Keychain-protected).
// - Plain `npm start`: no encryption is available, so keys come only from environment variables
//   (e.g. DEEPSEEK_API_KEY) and the UI refuses to store them on disk in plain text.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function createSecretStore({ file, encrypt = null, decrypt = null, env = process.env } = {}) {
  const canStore = Boolean(file && encrypt && decrypt);
  const load = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  const save = data => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 }); };
  const envName = name => `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;

  return {
    canStore,
    async get(name) {
      if (env[envName(name)]) return env[envName(name)];
      if (!canStore) return null;
      const blob = load()[name];
      if (!blob) return null;
      try { return decrypt(blob); } catch { return null; }
    },
    async source(name) {
      if (env[envName(name)]) return 'environment';
      return canStore && load()[name] ? 'secure storage' : null;
    },
    async set(name, value) {
      if (!canStore) throw new Error(`Secure storage isn't available here. Set ${envName(name)} in your environment instead, or use the desktop app.`);
      const v = String(value ?? '').trim();
      if (v.length < 8 || /\s/.test(v)) throw new Error('That does not look like an API key.');
      const data = load(); data[name] = encrypt(v); save(data);
    },
    async remove(name) { if (!canStore) return; const data = load(); delete data[name]; save(data); },
  };
}
