// Publish a release: npm run release   (bump "version" in this package.json first)
// Builds both Mac .dmg files and uploads them as a GitHub Release tagged v<version>. The app's update check reads it.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';

const run = (cmd, args, opts = {}) => (execFileSync(cmd, args, { encoding: 'utf8', ...opts }) ?? '').trim();
const fail = msg => { console.error(`\n✗ ${msg}\n`); process.exit(1); };
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = `v${version}`;

if (run('git', ['status', '--porcelain'])) fail('Commit or stash your changes first, so the release matches what is on GitHub.');
if (run('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') fail('Releases are made from the main branch.');
try { run('gh', ['--version']); } catch { fail('Install and sign in to the GitHub CLI first: brew install gh && gh auth login'); }
if (run('git', ['tag', '--list', tag])) fail(`${tag} already exists. Bump "version" in desktop/package.json.`);
run('git', ['push', 'origin', 'main'], { stdio: 'inherit' });

console.log(`Building ${tag}…`);
rmSync('dist', { recursive: true, force: true }); // never upload a stale build
execFileSync('npm', ['run', 'dist:mac'], { stdio: 'inherit' });
const dmgs = ['Unify.js-mac-arm64.dmg', 'Unify.js-mac-x64.dmg'].map(f => `dist/${f}`);
for (const f of dmgs) if (!existsSync(f)) fail(`Missing ${f} after the build`);

const notes = `Download **Unify.js-mac-arm64.dmg** for Apple Silicon Macs (M1 or newer), or **Unify.js-mac-x64.dmg** for Intel Macs.

First open: macOS blocks it because it isn't signed with an Apple Developer ID yet. Double-click it once, choose Done, then go to **System Settings → Privacy & Security** and click **Open Anyway** next to Unify.js. You only do this once.`;
run('gh', ['release', 'create', tag, ...dmgs, '--target', 'main', '--title', `Unify.js ${version}`, '--notes', notes], { stdio: 'inherit' });
console.log(`\n✓ Released ${tag}. Installed copies will show "Update available" within a few hours.`);
