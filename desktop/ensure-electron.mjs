// Makes sure the Electron binary is unpacked after `npm install`.
//
// On newer Node versions (seen on Node 26), Electron's own postinstall downloads the zip
// but its unzip step exits silently partway through, leaving no `path.txt` and an
// incomplete `dist/`. Then `npm start` fails with "Electron failed to install correctly".
// This script checks for that and unpacks the (checksum-verified) zip with the system
// unzip tool instead. It does nothing when Electron installed correctly.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronDir = path.dirname(require.resolve('electron/package.json'));
const { version } = require('electron/package.json');
const distDir = path.join(electronDir, 'dist');
const pathFile = path.join(electronDir, 'path.txt');

const platformPath = {
  darwin: 'Electron.app/Contents/MacOS/Electron',
  linux: 'electron',
  win32: 'electron.exe',
}[process.platform];

function installed() {
  try {
    return (
      existsSync(pathFile) &&
      readFileSync(path.join(distDir, 'version'), 'utf8').trim().replace(/^v/, '') === version &&
      existsSync(path.join(distDir, platformPath))
    );
  } catch {
    return false;
  }
}

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD || !platformPath || installed()) process.exit(0);

console.log(`[ensure-electron] Electron ${version} is not fully unpacked; unpacking it with the system unzip tool.`);
const electronRequire = createRequire(path.join(electronDir, 'install.js'));
const { downloadArtifact } = electronRequire('@electron/get');
const zip = await downloadArtifact({
  version,
  artifactName: 'electron',
  platform: process.platform,
  arch: process.arch,
  checksums: electronRequire('./checksums.json'),
});

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });
if (process.platform === 'darwin') {
  execFileSync('ditto', ['-x', '-k', zip, distDir], { stdio: 'inherit' }); // keeps the app bundle's symlinks
} else if (process.platform === 'win32') {
  execFileSync('tar', ['-xf', zip, '-C', distDir], { stdio: 'inherit' });
} else {
  execFileSync('unzip', ['-q', zip, '-d', distDir], { stdio: 'inherit' });
}
writeFileSync(pathFile, platformPath);

if (!installed()) {
  console.error('[ensure-electron] Electron still is not installed correctly. Try Node 22 LTS, delete node_modules, and run npm install again.');
  process.exit(1);
}
console.log('[ensure-electron] Electron is ready.');
