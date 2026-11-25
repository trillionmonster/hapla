const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const root = resolve(__dirname, '../..');
test('coding regression Compose graph keeps ports, networks, data, and credentials in dev-hapla', t => {
    const result = spawnSync('docker', ['compose', '--project-name', 'dev-hapla', '-f', 'scripts/acceptance/compose.coding.yml', 'config', '--format', 'json'], {
        cwd: root, encoding: 'utf8', env: { ...process.env, HAPLA_MASTER_SECRET: 'isolated-rendering-fixture', CODEX_VERSION: '0.159.0', CODING_WEB_PORT: '23345', CODING_SERVER_PORT: '24005' },
    });
    if (result.error?.code === 'ENOENT') { t.skip('Docker Compose unavailable in this runner; repeat test:selfhost on the Docker host.'); return; }
    assert.equal(result.status, 0, result.stderr);
    const graph = JSON.parse(result.stdout); assert.equal(graph.name, 'dev-hapla');
    const ports = [];
    for (const [name, service] of Object.entries(graph.services)) {
        assert.equal(service.image, 'hapla-coding-dev:dev-hapla');
        for (const port of service.ports ?? []) { assert.equal(port.host_ip, '127.0.0.1'); ports.push(port.published); }
        for (const volume of service.volumes) {
            assert(!String(volume.source).includes('docker.sock'));
            if (volume.type === 'bind') assert.equal(resolve(volume.source), root);
            else assert.match(graph.volumes[volume.source].name, /^dev-hapla_coding-/);
        }
        assert(!service.network_mode && !service.privileged, name);
    }
    assert.equal(ports.length, 2); assert.equal(new Set(ports).size, 2);
    assert.equal(graph.services['coding-cli'].environment.HAPLA_SERVER_URL, 'http://server:3005');
    assert.equal(graph.services['coding-cli'].environment.HAPLA_ACCEPTANCE_STACK, 'dev-hapla');
    for (const network of Object.values(graph.networks)) { assert.equal(network.external, undefined); assert.match(network.name, /^dev-hapla_/); }
});
