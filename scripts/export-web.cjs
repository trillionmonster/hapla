#!/usr/bin/env node

const { chmodSync, copyFileSync, cpSync, mkdtempSync, rmSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { dirname, extname, join, relative } = require('node:path');
const { spawnSync } = require('node:child_process');
const { gzipSync, constants: zlibConstants } = require('node:zlib');

const root = join(__dirname, '..');
const webRoot = join(root, 'packages', 'hapla-web');
const env = { ...process.env, APP_ENV: 'production' };
if (env.HAPLA_SERVER_URL && !env.EXPO_PUBLIC_HAPLA_SERVER_URL) {
  env.EXPO_PUBLIC_HAPLA_SERVER_URL = env.HAPLA_SERVER_URL;
}
delete env.NO_COLOR;

// Export into a private staging directory: a running Web server may be serving
// dist while Metro builds. Keep its index and immutable assets available.
const distRoot = mkdtempSync(join(webRoot, '.export-staging-'));
process.on('exit', () => rmSync(distRoot, { recursive: true, force: true }));

const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'expo', 'export', '--clear', '--platform', 'web', '--output-dir', distRoot],
  { cwd: webRoot, env, stdio: 'inherit' },
);
if (result.error) {
  console.error(`Could not export Hapla Web: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

// Metro preserves KaTeX's relative `fonts/...` URLs but does not copy resources
// referenced from CSS imported out of node_modules. Put the font directory beside
// the emitted CSS so every URL resolves in both local and container builds.
const katexPackageRoot = dirname(require.resolve('katex/package.json', { paths: [webRoot] }));
const katexFontsSource = join(katexPackageRoot, 'dist', 'fonts');
const katexFontsDestination = join(distRoot, '_expo', 'static', 'css', 'fonts');
mkdirSync(katexFontsDestination, { recursive: true });
cpSync(katexFontsSource, katexFontsDestination, { recursive: true });

// Expo/Metro's emitted chunk suffixes are not guaranteed to change when the
// application source changes. Serving those paths as immutable can therefore
// leave an installed browser on old UI code forever. Put every exported static
// chunk under one content-derived release directory so a new index always
// points at a new URL namespace, while unchanged releases remain cacheable.
const staticRoot = join(distRoot, '_expo', 'static');

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : entry.isFile() ? [file] : [];
  });
}

const staticDigest = createHash('sha256');
for (const file of filesIn(staticRoot).sort()) {
  staticDigest.update(relative(staticRoot, file));
  staticDigest.update('\0');
  staticDigest.update(readFileSync(file));
}
const releaseName = `static-${staticDigest.digest('hex').slice(0, 16)}`;
const releaseRoot = join(distRoot, '_expo', releaseName);
renameSync(staticRoot, releaseRoot);

const rewritableExtensions = new Set(['.css', '.html', '.js', '.json', '.map', '.svg', '.txt', '.xml']);
for (const file of filesIn(distRoot)) {
  if (!rewritableExtensions.has(extname(file))) continue;
  const source = readFileSync(file, 'utf8');
  const rewritten = source.replaceAll('/_expo/static/', `/_expo/${releaseName}/`);
  if (rewritten !== source) writeFileSync(file, rewritten);
}

// A TCP forwarder can reset one connection while the browser downloads the
// multi-megabyte entry chunks. Native deferred script tags leave a permanently
// blank root after that one transient failure. Load the three ordered entry
// scripts through a tiny inline bootstrap that retries each asset independently
// and gives the user an explicit status while it recovers.
const entryHtmlPath = join(distRoot, 'index.html');
const entryHtml = readFileSync(entryHtmlPath, 'utf8');
const entryScriptPattern = /<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g;
const entryScripts = [...entryHtml.matchAll(entryScriptPattern)].map((match) => match[1]);
if (entryScripts.length === 0) {
  throw new Error('Expo export emitted no entry scripts; resilient bootstrap was not installed');
}
const bootstrap = `<script id="hapla-resilient-bootstrap">
(() => {
  const assets = ${JSON.stringify(entryScripts)};
  const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  let overlay = document.getElementById('hapla-bootstrap-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'hapla-bootstrap-overlay';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:24px;background:' + (dark ? '#1f1f1f' : '#ffffff') + ';color:' + (dark ? '#b4b4b4' : '#6b6b6b') + ';font:14px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center';
    overlay.innerHTML = '<div id="hapla-bootstrap-status" style="box-sizing:border-box;width:min(360px,100%);padding:16px 20px;border:1px solid ' + (dark ? '#353535' : '#e5e5e5') + ';border-radius:12px;background:' + (dark ? '#252525' : '#f7f7f8') + '"><div id="hapla-bootstrap-label">Loading Hapla…</div></div>';
    document.body.appendChild(overlay);
  }
  const label = () => document.getElementById('hapla-bootstrap-label');
  const setLabel = (value) => { const node = label(); if (node) node.textContent = value; };
  const maxAttempts = 8;
  const load = (index) => {
    if (index >= assets.length) {
      // The overlay is outside React's root. WebRootLayout removes it after its
      // first committed render, so React cannot clear the only visible content
      // while the application is still mounting.
      setLabel('Starting Hapla…');
      setTimeout(() => {
        const status = document.getElementById('hapla-bootstrap-status');
        if (status) status.innerHTML = '<div id="hapla-bootstrap-label">Still starting Hapla…</div><button type="button" style="margin-top:12px;padding:8px 14px;border:0;border-radius:9px;cursor:pointer" onclick="location.reload()">Reload</button>';
      }, 15000);
      return;
    }
    let attempt = 0;
    const tryAsset = () => {
      attempt += 1;
      if (attempt > 1) setLabel('Network interrupted. Reconnecting (' + attempt + '/' + maxAttempts + ')…');
      const script = document.createElement('script');
      script.async = false;
      script.src = assets[index] + (attempt > 1 ? '?__hapla_asset_retry=' + Date.now() + '-' + attempt : '');
      let settled = false;
      const finish = (loaded) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        script.onerror = null;
        script.onload = null;
        if (loaded) {
          load(index + 1);
          return;
        }
        script.remove();
        if (attempt < maxAttempts) {
          setTimeout(tryAsset, Math.min(4000, 250 * Math.pow(2, attempt - 1)));
        } else {
          const status = document.getElementById('hapla-bootstrap-status');
          if (status) status.innerHTML = '<div>Hapla could not finish loading.</div><button type="button" style="margin-top:12px;padding:8px 14px;border:0;border-radius:9px;cursor:pointer" onclick="location.reload()">Retry</button>';
        }
      };
      const timeout = setTimeout(() => finish(false), 25000);
      script.onload = () => finish(true);
      script.onerror = () => finish(false);
      document.body.appendChild(script);
    };
    tryAsset();
  };
  load(0);
})();
</script>`;
const resilientEntryHtml = entryHtml
  .replace(entryScriptPattern, '')
  // output: "single" uses Expo's generated index instead of +html.tsx.
  // Keep its first paint and the runtime permission indicator on one brand.
  .replace(/<link\b[^>]*\brel=["'](?:shortcut )?icon["'][^>]*>/gi, '')
  // Download entry chunks together; the bootstrap below still executes them
  // in order and retries a failed transfer. The first attempt reuses preload.
  .replace('</head>', `${entryScripts.map(src => `<link rel="preload" as="script" href="${src}" />`).join('\n')}
<link rel="icon" type="image/svg+xml" sizes="any" href="/brand/hapla-favicon-v1.svg" />
<link rel="apple-touch-icon" sizes="180x180" href="/brand/hapla-icon-180-v1.png" />
<link rel="manifest" href="/brand/hapla-v1.webmanifest" />
<meta name="theme-color" content="#101820" />
</head>`)
  .replace('</body>', `${bootstrap}\n</body>`);
writeFileSync(entryHtmlPath, resilientEntryHtml);

const compressibleExtensions = new Set([
  '.css', '.html', '.js', '.json', '.map', '.otf', '.svg', '.ttf', '.txt', '.wasm', '.xml',
]);
let compressedFiles = 0;

function precompress(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      precompress(file);
      continue;
    }
    if (!entry.isFile() || !compressibleExtensions.has(extname(entry.name))) continue;
    if (statSync(file).size < 1024) continue;

    const source = readFileSync(file);
    const compressed = gzipSync(source, {
      level: zlibConstants.Z_BEST_COMPRESSION,
      mtime: 0,
    });
    if (compressed.length >= source.length) continue;
    writeFileSync(`${file}.gz`, compressed);
    compressedFiles += 1;
  }
}

precompress(distRoot);
console.log(`Versioned Web assets as ${releaseName}; pre-compressed ${compressedFiles} assets.`);

// Retain prior content-addressed releases for already-open tabs. Publish every
// new asset before atomically replacing the HTML entry points; each response
// therefore sees a complete old or new file, never an empty build directory.
const liveRoot = join(webRoot, 'dist');
const exported = filesIn(distRoot);
const html = (file) => /\.html(?:\.gz)?$/.test(file);
for (const file of [...exported.filter(file => !html(file)), ...exported.filter(html)]) {
  const target = join(liveRoot, relative(distRoot, file));
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.publish-${process.pid}`;
  try { copyFileSync(file, temporary); renameSync(temporary, target); }
  finally { rmSync(temporary, { force: true }); }
}

// CI and operator shells can use a restrictive umask. Nginx serves files as an
// unprivileged worker, so normalize the published tree after the atomic copy.
// This also fixes permissions on retained immutable releases from earlier
// exports without making any file writable by the Web process.
function makeWebReadable(directory) {
  chmodSync(directory, 0o755);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) makeWebReadable(file);
    else if (entry.isFile()) chmodSync(file, 0o644);
  }
}
makeWebReadable(liveRoot);
console.log(`Published ${releaseName} atomically; existing release assets retained.`);
