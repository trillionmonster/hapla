/** Unistyles' web Pressable owns a separate ref callback; release its DOM on detach. */
const fs = require('node:fs');
const path = require('node:path');
const files = ['src/components/native/Pressable.tsx', 'lib/module/components/native/Pressable.js', 'lib/commonjs/components/native/Pressable.js'];
function patchPressable(packageRoot) {
  if (!fs.existsSync(path.join(packageRoot, 'package.json'))) return 0;
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  let changed = 0;
  for (const relative of files) {
    const file = path.join(packageRoot, relative);
    let source = fs.readFileSync(file, 'utf8');
    if (source.includes('hapla-release-pressable-ref')) continue;
    const target = /storedRef = ref(?: as unknown as HTMLElement)?;?/;
    if (manifest.version !== '3.1.1' || !target.test(source) || !/return forwardedRef\(ref\);?/.test(source)) throw new Error(`Review Unistyles Pressable cleanup patch: ${manifest.version} ${relative}`);
    const registry = relative.includes('commonjs') ? '_specs.UnistylesShadowRegistry' : 'UnistylesShadowRegistry';
    source = source.replace(target, match => `// hapla-release-pressable-ref\n                          if (storedRef) ${registry}.remove(storedRef, classNames?.hash);\n                          ${match}`);
    source = source.replace(/return forwardedRef\(ref\);?/, `const cleanup = forwardedRef(ref);\n                              if (typeof cleanup === 'function') return () => {\n                                  ${registry}.remove(storedRef, classNames?.hash);\n                                  storedRef = null;\n                                  cleanup();\n                              };\n                              return cleanup;`);
    fs.writeFileSync(file, source); changed++;
  }
  return changed;
}
module.exports = { patchPressable, files };
const changed = patchPressable(path.resolve(__dirname, '../node_modules/react-native-unistyles'));
if (changed) console.log(`[patch] Fixed Unistyles Pressable detach (${changed} files)`);
