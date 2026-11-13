// electron-builder afterPack hook: sign the Mac app before the .dmg is made.
//
// Without an Apple Developer ID, electron-builder skips signing, which leaves Electron's original signature broken and
// Apple Silicon Macs call the app "damaged". So we sign it ourselves:
//   1. With the self-signed "Unify.js Self-Signed" certificate when it's in this Mac's Keychain (the release machine).
//      Every build then has the same identity, so the Keychain keeps trusting updates (no "wants to use your
//      confidential information" prompt after each update). Back it up: ~/Documents/Unify.js signing/ (password is in
//      the Keychain as "Unify.js signing certificate backup password").
//   2. Otherwise ad-hoc (free, works, but each build looks like a new app to the Keychain).
// Override with UNIFY_SIGN_IDENTITY. Replace all this with build.mac.identity once there's a Developer ID.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const SELF_SIGNED = 'Unify.js Self-Signed';
const hasCert = name => { try { execFileSync('security', ['find-certificate', '-c', name], { stdio: 'ignore' }); return true; } catch { return false; } };

exports.default = async function macSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const identity = process.env.UNIFY_SIGN_IDENTITY || (hasCert(SELF_SIGNED) ? SELF_SIGNED : '-');
  execFileSync('codesign', ['--force', '--deep', '--sign', identity, app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • signed (${identity === '-' ? 'ad-hoc' : identity})  ${app}`);
};
