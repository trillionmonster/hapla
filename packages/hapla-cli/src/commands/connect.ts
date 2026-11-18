import chalk from 'chalk';
import { readCredentials } from '@/persistence';
import { ApiClient } from '@/api/api';
import { authenticateCodex } from './connect/authenticateCodex';
import { authenticateClaude } from './connect/authenticateClaude';
import { decodeJwtPayload } from './connect/utils';

type ConnectVendor = 'codex' | 'claude';
type ApiVendor = 'openai' | 'anthropic';

export async function handleConnectCommand(args: string[]): Promise<void> {
    const subcommand = args[0]?.toLowerCase();
    if (!subcommand || ['help', '--help', '-h'].includes(subcommand)) {
        showConnectHelp();
        return;
    }
    if (subcommand === 'status') {
        await handleConnectStatus();
        return;
    }
    if (subcommand === 'codex' || subcommand === 'claude') {
        await handleConnectVendor(subcommand);
        return;
    }
    throw new Error(`Unknown connect target: ${subcommand}`);
}

function showConnectHelp(): void {
    console.log(`
${chalk.bold('hapla connect')} - Connect Claude Code or Codex credentials

${chalk.bold('Usage:')}
  hapla connect codex
  hapla connect claude
  hapla connect status
`);
}

async function handleConnectVendor(vendor: ConnectVendor): Promise<void> {
    const credentials = await readCredentials();
    if (!credentials) {
        throw new Error('Not authenticated. Run "hapla auth login" first.');
    }
    const api = await ApiClient.create(credentials);
    if (vendor === 'codex') {
        await api.registerVendorToken('openai', { oauth: await authenticateCodex() });
    } else {
        await api.registerVendorToken('anthropic', { oauth: await authenticateClaude() });
    }
    console.log(chalk.green(`Connected ${vendor === 'codex' ? 'Codex' : 'Claude Code'}.`));
}

async function handleConnectStatus(): Promise<void> {
    const credentials = await readCredentials();
    if (!credentials) {
        throw new Error('Not authenticated. Run "hapla auth login" first.');
    }
    const api = await ApiClient.create(credentials);
    const vendors: Array<{ key: ApiVendor; display: string }> = [
        { key: 'openai', display: 'Codex' },
        { key: 'anthropic', display: 'Claude Code' },
    ];

    for (const vendor of vendors) {
        const token = await api.getVendorToken(vendor.key).catch(() => null);
        const payload = token?.oauth?.id_token ? decodeJwtPayload(token.oauth.id_token) : null;
        const identity = payload?.email ? chalk.gray(` (${payload.email})`) : '';
        console.log(token?.oauth
            ? `  ${chalk.green('✓')} ${vendor.display}${identity}`
            : `  ${chalk.gray('○')} ${vendor.display}`);
    }
}
