const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');
const { patchUnistylesPackage, files } = require('./fix-unistyles-web-ref.cjs');
const packageRoot = path.resolve(__dirname, '../node_modules/react-native-unistyles');

function load(relative, dependencies, globals = {}) {
  const source = fs.readFileSync(path.join(packageRoot, relative), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const requireDependency = (name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  };
  new Function('require', 'module', 'exports', ...Object.keys(globals), output)(requireDependency, module, module.exports, ...Object.values(globals));
  return module.exports;
}

for (const file of files) test(`actual ${file} releases unmounted nodes from the actual registry`, async () => {
  class Element {}
  const globals = { HTMLElement: Element, document: { querySelector: () => null } };
  let removedStyles = 0;
  const services = {};
  const { UnistylesRegistry } = load('src/web/registry.ts', {
    './css': { CSSState: class { remove() { removedStyles++; } } }, './utils': {},
  }, globals);
  services.registry = new UnistylesRegistry(services);
  const { UnistylesShadowRegistry } = load('src/web/shadowRegistry.ts', {
    '../specs/NativePlatform/NativePlatform.nitro': { UnistyleDependency: {} },
    '../utils': {}, './utils': { isServer: () => false }, './variants': {},
  }, globals);
  services.shadowRegistry = new UnistylesShadowRegistry(services);
  const { createUnistylesRef } = load(file, { '../services': { services }, './common': { isServer: () => false } }, globals);
  const refs = Array.from({ length: 50 }, () => {
    const forwarded = { current: null };
    const ref = createUnistylesRef([{ hash: 'shared-style' }, []], forwarded);
    const node = new Element();
    ref(node);
    assert.equal(forwarded.current, node);
    return { ref, forwarded };
  });
  assert.equal(services.registry.stylesCounter.get('shared-style').size, 50);
  for (const { ref, forwarded } of refs) { ref(null); assert.equal(forwarded.current, null); }
  await Promise.resolve(); await Promise.resolve();
  assert.equal(services.registry.stylesCounter.get('shared-style').size, 0);
  assert.equal(removedStyles, 1);

  let forwardedCleanups = 0;
  const cleanups = Array.from({ length: 50 }, () => {
    const ref = createUnistylesRef([{ hash: 'react19-style' }, []], (node) => {
      assert.ok(node instanceof Element);
      return () => { forwardedCleanups++; };
    });
    return ref(new Element());
  });
  assert.equal(services.registry.stylesCounter.get('react19-style').size, 50);
  // React 19 invokes the returned cleanup and never follows it with ref(null).
  for (const cleanup of cleanups) { assert.equal(typeof cleanup, 'function'); cleanup(); }
  await Promise.resolve(); await Promise.resolve();
  assert.equal(services.registry.stylesCounter.get('react19-style').size, 0);
  assert.equal(forwardedCleanups, 50);
  assert.equal(removedStyles, 2);
});

test('dependency installation patch is idempotent and rejects unexpected upstream code', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hapla-unistyles-patch-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '3.1.1' }));
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), 'shadowRegistry.remove(storedRef, classNames?.hash); return forwardedRef(ref);');
    }
    assert.equal(patchUnistylesPackage(root), 3);
    assert.equal(patchUnistylesPackage(root), 0);
    fs.writeFileSync(path.join(root, files[0]), 'upstream changed');
    assert.throws(() => patchUnistylesPackage(root), /Review the Unistyles web-ref patch/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
