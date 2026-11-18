#!/usr/bin/env node
// Hapla's original geometric mark. All raster/app/favicon variants share these
// two opposing facets, so a permission notification cannot revive an old logo.
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const root = join(__dirname, '..');
const sharp = createRequire(join(root, 'packages/hapla-server/package.json'))('sharp');
const images = join(root, 'packages/hapla-web/sources/assets/images');
const vectors = join(root, 'packages/hapla-web/sources/assets/brand');
const publicRoot = join(root, 'packages/hapla-web/public');
const brand = join(publicRoot, 'brand');
for (const dir of [images, vectors, brand]) mkdirSync(dir, { recursive: true });

const graphite = '#101820';
const silver = '#E5F3FF';
const cyan = '#63DDF2';
// Opposing open facets create one continuous hexagonal silhouette with two
// diagonal cuts. Wide fills remain legible at 16 px; there are no thin circuits.
const facets = (first, second) => `<path fill="${first}" d="M32 8 49.32 18 39.32 23.77 32 19.54 20 26.46 20 40.32 10 46.09 10 20.69Z"/><path fill="${second}" d="M54 17.91V43.31L32 56 14.68 46 24.68 40.23 32 44.46 44 37.54V23.68Z"/>`;
function svg({ tile = true, light = false, active = false, monochrome = false } = {}) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><title>Hapla</title>${tile ? `<rect width="64" height="64" rx="15" fill="${graphite}"/><rect x=".5" y=".5" width="63" height="63" rx="14.5" fill="none" stroke="#2A3C4A"/>` : ''}${facets(monochrome ? '#FFFFFF' : light ? graphite : silver, monochrome ? '#FFFFFF' : light ? '#007F99' : cyan)}${active ? `<circle cx="53" cy="11" r="9" fill="#FFBD59" stroke="${graphite}" stroke-width="3"/>` : ''}</svg>\n`;
}
const normal = svg();
const active = svg({ active: true });
const write = (file, data) => writeFileSync(file, data);
const png = (source, size) => sharp(Buffer.from(source), { density: 384 }).resize(size, size).png().toBuffer();

async function ico(source) {
    const sizes = [16, 32, 48, 64, 128, 256];
    const payloads = await Promise.all(sizes.map(size => png(source, size)));
    const header = Buffer.alloc(6 + 16 * sizes.length);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(sizes.length, 4);
    let offset = header.length;
    payloads.forEach((data, index) => {
        const at = 6 + index * 16;
        header[at] = sizes[index] === 256 ? 0 : sizes[index];
        header[at + 1] = header[at];
        header.writeUInt16LE(1, at + 4);
        header.writeUInt16LE(32, at + 6);
        header.writeUInt32LE(data.length, at + 8);
        header.writeUInt32LE(offset, at + 12);
        offset += data.length;
    });
    return Buffer.concat([header, ...payloads]);
}

async function main() {
    write(join(vectors, 'hapla-mark.svg'), normal);
    write(join(vectors, 'hapla-mark-light.svg'), svg({ tile: false, light: true }));
    write(join(vectors, 'hapla-mark-dark.svg'), svg({ tile: false }));
    write(join(brand, 'hapla-favicon-v1.svg'), normal);
    write(join(brand, 'hapla-favicon-active-v1.svg'), active);
    for (const size of [180, 192, 512]) write(join(brand, `hapla-icon-${size}-v1.png`), await png(normal, size));
    write(join(images, 'favicon.png'), await png(normal, 256));
    write(join(images, 'favicon-active.png'), await png(active, 256));
    write(join(publicRoot, 'favicon-active.ico'), await ico(active));
    write(join(images, 'icon.png'), await png(normal, 1024));
    write(join(images, 'icon-adaptive.png'), await png(normal, 1024));
    write(join(images, 'icon-monochrome.png'), await png(svg({ tile: false, monochrome: true }), 1024));
    write(join(images, 'logo-black.png'), await png(svg({ tile: false, light: true }), 256));
    write(join(images, 'logo-white.png'), await png(svg({ tile: false }), 256));
    write(join(brand, 'hapla-v1.webmanifest'), JSON.stringify({
        id: '/', name: 'Hapla', short_name: 'Hapla', start_url: '/', scope: '/', display: 'standalone',
        background_color: graphite, theme_color: graphite,
        icons: [192, 512].map(size => ({ src: `/brand/hapla-icon-${size}-v1.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' })),
    }, null, 2) + '\n');
    console.log('Generated Hapla mark, app icons, favicons and manifest.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
