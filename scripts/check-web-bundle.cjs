const fs = require('node:fs');
const path = require('node:path');
const { gzipSync } = require('node:zlib');

const distRoot = path.resolve(__dirname, '../packages/hapla-web/dist');
const forbidden = [
    'Vitest failed to access its internal state',
    '__vitest_worker__',
];

function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const absolute = path.join(directory, entry.name);
        return entry.isDirectory() ? walk(absolute) : [absolute];
    });
}

if (!fs.existsSync(distRoot)) {
    throw new Error(`Web dist directory does not exist: ${distRoot}`);
}

const offenders = [];
for (const file of walk(distRoot)) {
    if (!/\.(?:js|html)$/.test(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const marker = forbidden.find((value) => source.includes(value));
    if (marker) offenders.push(`${path.relative(distRoot, file)} (${marker})`);
}

if (offenders.length > 0) {
    throw new Error(`Test runtime leaked into the production Web bundle:\n${offenders.join('\n')}`);
}

// A live dist retains older immutable releases for already-open browser tabs.
// Check the release referenced by the currently published entry point.
const entryHtml = fs.readFileSync(path.join(distRoot, 'index.html'), 'utf8');
const activeReleases = [...new Set([...entryHtml.matchAll(/\/_expo\/(static-[a-f0-9]{16})\//g)].map(match => match[1]))];
if (activeReleases.length !== 1) {
    throw new Error(`Expected one active static release in index.html; found ${activeReleases.length}`);
}
const staticRoot = path.join(distRoot, '_expo', activeReleases[0]);
const cssRoot = path.join(staticRoot, 'css');
const katexCssFiles = walk(cssRoot).filter((file) => /katex.*\.css$/.test(path.basename(file)));
if (katexCssFiles.length !== 1) {
    throw new Error(`Expected exactly one emitted KaTeX stylesheet; found ${katexCssFiles.length}`);
}
const katexCss = fs.readFileSync(katexCssFiles[0], 'utf8');
const katexFontUrls = [...katexCss.matchAll(/url\((?:["'])?(fonts\/[^)"']+)(?:["'])?\)/g)]
    .map((match) => match[1]);
if (katexFontUrls.length === 0) {
    throw new Error('KaTeX stylesheet contains no local font references');
}
const missingKatexFonts = [...new Set(katexFontUrls)]
    .filter((fontUrl) => !fs.existsSync(path.resolve(cssRoot, fontUrl)));
if (missingKatexFonts.length > 0) {
    throw new Error(`KaTeX fonts missing from Web bundle:\n${missingKatexFonts.join('\n')}`);
}

const webBundleRoot = path.join(staticRoot, 'js/web');
const bundleFiles = walk(webBundleRoot).filter((file) => file.endsWith('.js'));
const largestMatching = (pattern) => bundleFiles
    .filter((file) => pattern.test(path.basename(file)))
    .sort((left, right) => fs.statSync(right).size - fs.statSync(left).size)[0];
const entryBundles = [
    largestMatching(/^__common-.*\.js$/),
    largestMatching(/^index-.*\.js$/),
].filter(Boolean);
const compressedEntryBytes = entryBundles.reduce(
    (total, file) => total + gzipSync(fs.readFileSync(file)).byteLength,
    0,
);
const MAX_COMPRESSED_ENTRY_BYTES = 2_100_000;
if (compressedEntryBytes > MAX_COMPRESSED_ENTRY_BYTES) {
    throw new Error(
        `Compressed Web entry bundles exceed the ${MAX_COMPRESSED_ENTRY_BYTES} byte budget: ${compressedEntryBytes}`,
    );
}

console.log(`Web bundle boundary check passed (${compressedEntryBytes} compressed entry bytes, ${new Set(katexFontUrls).size} KaTeX fonts).`);
