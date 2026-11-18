const fs = require('node:fs');
const path = require('node:path');

const packagePath = path.join(__dirname, '..', 'node_modules', '@noble', 'hashes', 'package.json');
if (!fs.existsSync(packagePath)) {
  console.log('[postinstall] @noble/hashes is not installed; skipping export fix');
} else {
  const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (!manifest.exports['./crypto.js']) {
    manifest.exports['./crypto.js'] = manifest.exports['./crypto'];
    fs.writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log('[postinstall] Added @noble/hashes ./crypto.js compatibility export');
  }
}
