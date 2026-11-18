const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { files } = require('./fix-unistyles-web-pressable.cjs');
const root = path.resolve(__dirname, '../node_modules/react-native-unistyles');
function load(file, deps, globals = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const code = ts.transpileModule(source, { fileName: file, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', ...Object.keys(globals), code)(name => { if (!(name in deps)) throw Error(name); return deps[name]; }, module, module.exports, ...Object.values(globals));
  return module.exports;
}
for (const file of files) test(`actual ${file} releases styles after hover changes and both ref cleanup conventions`, async () => {
  class Element {}
  const globals = { HTMLElement: Element, document: { querySelector: () => null } };
  const services = {};
  services.registry = new (load('src/web/registry.ts', { './css': { CSSState: class { remove() {} } }, './utils': {} }, globals).UnistylesRegistry)(services);
  services.shadowRegistry = new (load('src/web/shadowRegistry.ts', { '../specs/NativePlatform/NativePlatform.nitro': { UnistyleDependency: {} }, '../utils': {}, './utils': { isServer: () => false }, './variants': {} }, globals).UnistylesShadowRegistry)(services);
  const { Pressable } = load(file, { react: { forwardRef: render => render }, 'react-native': { Pressable: 'Pressable' }, 'react/jsx-runtime': { jsx: (_, props) => ({ props }) }, '../../core': { getClassName: value => value }, '../../specs': { UnistylesShadowRegistry: services.shadowRegistry }, '../../web/utils': { isServer: () => false } }, globals);
  let cleanups = 0;
  for (const react19 of [false, true]) {
    const refs = Array.from({ length: 50 }, () => {
      const forwarded = react19 ? node => { assert.ok(node instanceof Element); return () => cleanups++; } : { current: null };
      const element = Pressable({ style: state => ({ hash: state.hovered ? 'hover' : 'normal' }) }, forwarded);
      element.props.style({ hovered: false });
      const cleanup = element.props.ref(new Element());
      element.props.style({ hovered: true });
      return { props: element.props, cleanup };
    });
    assert.equal(services.registry.stylesCounter.get('hover').size, 50);
    for (const ref of refs) react19 ? ref.cleanup() : ref.props.ref(null);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(services.registry.stylesCounter.get('hover').size, 0);
    assert.equal(services.registry.stylesCounter.get('normal').size, 0);
  }
  assert.equal(cleanups, 50);
});
