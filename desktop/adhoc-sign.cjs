// electron-builder afterPack hook: ad-hoc sign the Mac app before the .dmg is made.
// Without a Developer ID, electron-builder skips signing, which leaves Electron's original signature broken, and
// Apple Silicon Macs then refuse to open the app ("damaged"). An ad-hoc signature is free and keeps it valid.
// Remove this hook once the build has a real Developer ID (set build.mac.identity instead).
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed  ${app}`);
};
