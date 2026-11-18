/**
 * Unistyles 3.1.1 passes a ref container to HTMLElement-only cleanup, retaining
 * every unmounted styled DOM node in its global stylesCounter registry.
 * A forwarded React 19 ref cleanup must also release Unistyles: React does not
 * additionally invoke ref(null) when the ref callback returned a cleanup.
 * Patch source and both distributed module formats, since Metro and Node can
 * select different exports. Reapply safely after every dependency install.
 */
const fs = require('node:fs');
const path = require('node:path');

const files = [
  'src/web/utils/createUnistylesRef.ts',
  'lib/module/web/utils/createUnistylesRef.js',
  'lib/commonjs/web/utils/createUnistylesRef.js',
];
const original = 'shadowRegistry.remove(storedRef, classNames?.hash)';
const replacement = 'shadowRegistry.remove(storedRef.current, classNames?.hash)';
const forwardedOriginal = /return forwardedRef\(ref\);?/;
const forwardedReplacement = `const cleanup = forwardedRef(ref);
                  if (typeof cleanup === 'function') {
                      return () => {
                          unistyles.services.shadowRegistry.remove(storedRef.current, classNames?.hash);
                          storedRef.current = null;
                          cleanup();
                      };
                  }
                  return cleanup;`;

function patchUnistylesPackage(packageRoot) {
  if (!fs.existsSync(path.join(packageRoot, 'package.json'))) return 0;
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  let changed = 0;
  for (const relative of files) {
    const file = path.join(packageRoot, relative);
    const content = fs.readFileSync(file, 'utf8');
    const fixedContainer = content.includes(replacement) && !content.includes(original);
    const fixedCleanup = content.includes('const cleanup = forwardedRef(ref)') && content.includes('storedRef.current = null;');
    if (fixedContainer && fixedCleanup) continue;
    if (manifest.version !== '3.1.1' || (!fixedContainer && content.split(original).length !== 2) || (!fixedCleanup && !forwardedOriginal.test(content))) {
      throw new Error(`Review the Unistyles web-ref patch for ${manifest.version}: ${relative}`);
    }
    fs.writeFileSync(file, content.replace(original, replacement).replace(forwardedOriginal, forwardedReplacement));
    changed++;
  }
  return changed;
}

module.exports = { patchUnistylesPackage, files };
const changed = patchUnistylesPackage(path.resolve(__dirname, '../node_modules/react-native-unistyles'));
if (changed) console.log(`[patch] Fixed Unistyles detached DOM cleanup (${changed} files)`);
