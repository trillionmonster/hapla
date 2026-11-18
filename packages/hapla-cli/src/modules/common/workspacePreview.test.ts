import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createWorkspacePreview, localPreviewUrl } from './workspacePreview';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'hapla-preview-')); directories.push(root); return root; }

describe('workspace webpage previews', () => {
    it('loads relative scripts, module imports, styles and image assets into a portable document', async () => {
        const root = await fixture(); await mkdir(join(root, 'assets'));
        await writeFile(join(root, 'index.html'), '<html><head><link rel="stylesheet" href="assets/site.css"></head><body><button id="action">测试</button><img src="assets/image.png"><script type="module" src="assets/main.js"></script></body></html>');
        await writeFile(join(root, 'assets/site.css'), 'body{background:url("./image.png");color:red}');
        await writeFile(join(root, 'assets/image.png'), Buffer.from([1, 2, 3]));
        await writeFile(join(root, 'assets/main.js'), 'import {text} from "./text.js"; document.getElementById("action").onclick=()=>document.body.dataset.result=text;');
        await writeFile(join(root, 'assets/text.js'), 'export const text="已点击";');
        const result = await createWorkspacePreview(root, 'index.html');
        expect(result.resources).toBe(5);
        expect(result.html).toContain('<style>');
        expect(result.html).toContain('data:image/png;base64,AQID');
        const source = Buffer.from(result.html.match(/src="data:text\/javascript;base64,([^"]+)/)![1], 'base64').toString('utf8');
        expect(source).toContain('onclick'); expect(source).toContain('from "data:text/javascript;base64,');
        expect(result.html.indexOf('Content-Security-Policy')).toBeLessThan(result.html.indexOf('<script'));
    });
    it('rejects filesystem and symlink escapes without reading neighboring projects', async () => {
        const root = await fixture(); const outside = await fixture();
        await writeFile(join(outside, 'secret.js'), 'secret');
        await symlink(join(outside, 'secret.js'), join(root, 'escape.js'));
        await writeFile(join(root, 'index.html'), '<script src="escape.js"></script>');
        await expect(createWorkspacePreview(root, 'index.html')).rejects.toThrow('超出当前工作区');
        await expect(createWorkspacePreview(root, join(outside, 'index.html'))).rejects.toThrow('超出当前工作区');
    });
    it('fetches a loopback development server and refuses non-loopback RPC targets or redirects', async () => {
        const root = await fixture();
        const server = createServer((request, response) => {
            if (request.url === '/redirect') { response.writeHead(302, { location: 'http://192.168.42.10/private' }); response.end(); }
            else if (request.url === '/app.js') response.end('document.body.dataset.ready="true"');
            else response.end('<script src="/app.js"></script><p>本地预览</p>');
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address() as { port: number };
        try {
            expect((await createWorkspacePreview(root, `http://127.0.0.1:${address.port}/`)).html).toContain('本地预览');
            await expect(createWorkspacePreview(root, `http://127.0.0.1:${address.port}/redirect`)).rejects.toThrow('302');
            expect(() => localPreviewUrl('http://192.168.42.10:3005')).toThrow('回环地址');
            expect(() => localPreviewUrl('http://user:pass@localhost:3000')).toThrow('回环地址');
        } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    });
    it('rejects unbounded assets and cyclic module graphs', async () => {
        const root = await fixture();
        await writeFile(join(root, 'index.html'), '<script type="module" src="cycle.js"></script>');
        await writeFile(join(root, 'cycle.js'), 'import "./cycle.js";');
        await expect(createWorkspacePreview(root, 'index.html')).rejects.toThrow('循环模块');
        await writeFile(join(root, 'index.html'), 'a'.repeat(4 * 1024 * 1024 + 1));
        await expect(createWorkspacePreview(root, 'index.html')).rejects.toThrow('预览限制');
    });
});
