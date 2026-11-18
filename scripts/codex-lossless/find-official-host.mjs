import { createRequire } from 'node:module';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

try {
    const cli = realpathSync(process.argv[2]);
    const require = createRequire(cli);
    const name = `@openai/codex-${process.platform}-${process.arch}`;
    const packagePath = require.resolve(`${name}/package.json`);
    const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
    const version = process.argv[3] || '0.153.4';
    if (metadata.version !== `${version}-${process.platform}-${process.arch}`) process.exit(1);
    const target = process.platform === 'linux'
        ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`
        : process.platform === 'darwin' ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin` : null;
    if (!target) process.exit(1);
    const host = join(dirname(packagePath), 'vendor', target, 'bin', 'codex-code-mode-host');
    if (!existsSync(host)) process.exit(1);
    process.stdout.write(host);
} catch {
    process.exitCode = 1;
}
