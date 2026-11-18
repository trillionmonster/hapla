const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { profile, defaults, parseEnv, readConfig, writeConfig, validateConfig, composeArgs,
  isolationProblems, freePort } = require('../lib/selfhost.cjs');
const { parseArgs, configure, workerConfig, waitHealthy } = require('../selfhost.cjs');
const ROOT = path.resolve(__dirname, '../..');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hapla setup '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixture(t) {
  const root = temporary(t);
  for (const file of ['scripts/selfhost.cjs', 'scripts/lib/selfhost.cjs', 'docker-compose.selfhost.yml',
    '.env.selfhost.example', 'deploy/compose.worker.yml', 'deploy/hapla-cloud-files.override.yml', 'deploy/compose.subnet.yml',
    'packages/hapla-cli/src/codex/codexProtocolSnapshot.json']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  const bin = path.join(root, 'fake-bin'); fs.mkdirSync(bin);
  const log = path.join(root, 'docker-calls.jsonl');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HAPLA_TEST_DOCKER_LOG, JSON.stringify(args)+'\\n');
if (args[0] === 'info' || (args[0] === 'compose' && args[1] === 'version')) console.log('28.0.0');
if (args[0] === 'volume' && args[1] === 'ls') {
  if (process.env.HAPLA_TEST_VOLUME_ERROR === '1') process.exit(1);
  if (process.env.HAPLA_TEST_VOLUME_PRESENT === '1') console.log(args[args.indexOf('--filter')+1].replace(/^name=\\^/, '').replace(/\\$$/, ''));
}
if (args[0] === 'ps' && process.env.HAPLA_TEST_CONTAINER) console.log('fixture-container');
if (args[0] === 'inspect' && process.env.HAPLA_TEST_CONTAINER) console.log(process.env.HAPLA_TEST_CONTAINER);
if (args[0] === 'compose' && args.includes('up') && process.env.HAPLA_TEST_START_MARKER) fs.writeFileSync(process.env.HAPLA_TEST_START_MARKER, 'up');
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HAPLA_TEST_DOCKER_LOG: log, COMPOSE_FILE: '' };
  const run = (args, extra = {}) => spawnSync(process.execPath, [path.join(root, 'scripts/selfhost.cjs'), ...args],
    { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' });
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { root, run, calls, env };
}

test('instance names scope configuration, images, Compose projects, and storage', () => {
  const root = '/tmp/checkout with spaces';
  assert.equal(profile(root).envFile, path.join(root, '.env.selfhost'));
  const alpha = profile(root, 'alpha'); const beta = profile(root, 'beta');
  assert.notEqual(alpha.project, beta.project);
  assert.notEqual(alpha.envFile, beta.envFile);
  assert.notEqual(defaults(alpha, {}).HAPLA_SERVER_IMAGE, defaults(beta, {}).HAPLA_SERVER_IMAGE);
  for (const name of ['../escape', '-bad', 'a b', 'a--b', undefined]) assert.throws(() => profile(root, name === undefined ? '../escape' : name));
  assert.deepEqual(composeArgs(alpha, {}), ['compose', '--project-name', 'hapla-alpha', '--env-file', alpha.envFile,
    '-f', path.join(root, 'docker-compose.selfhost.yml')]);
  assert(composeArgs(alpha, { HAPLA_R2_CACHE_URL: 'https://files.example.com' }).includes(path.join(root, 'deploy/hapla-cloud-files.override.yml')));
  assert(composeArgs(alpha, { HAPLA_DOCKER_SUBNET: '10.251.33.0/24' }).includes(path.join(root, 'deploy/compose.subnet.yml')));
});

test('private dotenv values round trip without shell execution or dollar interpolation', (t) => {
  const root = temporary(t); const target = path.join(root, 'private.env');
  const values = { HAPLA_MASTER_SECRET: 'a'.repeat(64), HASH: 'scrypt$abc$def', QUOTE: "it's literal", EMPTY: '', SHELL: '$(touch unsafe)' };
  writeConfig(target, values);
  assert.deepEqual(readConfig(target), values);
  assert.equal(fs.existsSync(path.join(root, 'unsafe')), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(parseEnv('A="hello"\nB=world # comment\n'), { A: 'hello', B: 'world' });
  assert.throws(() => parseEnv('A=${OTHER}'), /变量引用/);
});

test('setup is idempotent and preserves an existing master secret and optional settings', async (t) => {
  const selected = profile(temporary(t), 'demo');
  const first = await configure(selected, { 'non-interactive': true, port: '12901', 'file-service': 'https://files.example.com' });
  const before = fs.readFileSync(selected.envFile, 'utf8');
  const again = await configure(selected, { 'non-interactive': true });
  assert.equal(again.HAPLA_MASTER_SECRET, first.HAPLA_MASTER_SECRET);
  assert.equal(fs.readFileSync(selected.envFile, 'utf8'), before);
  const changed = await configure(selected, { 'non-interactive': true, port: '12902' });
  assert.equal(changed.HAPLA_MASTER_SECRET, first.HAPLA_MASTER_SECRET);
  assert.equal(changed.HAPLA_R2_CACHE_URL, 'https://files.example.com');
  assert.equal(changed.HAPLA_WEBAPP_URL, 'http://localhost:12902');
});

test('weak existing secrets fail without being rotated or replacing the file', async (t) => {
  const selected = profile(temporary(t));
  const config = defaults(selected, { HAPLA_MASTER_SECRET: 'replace-with-at-least-32-random-characters' });
  writeConfig(selected.envFile, config);
  const before = fs.readFileSync(selected.envFile, 'utf8');
  await assert.rejects(configure(selected, { 'non-interactive': true }), /HAPLA_MASTER_SECRET/);
  assert.equal(fs.readFileSync(selected.envFile, 'utf8'), before);
});

test('password files store only a hash and configuration rejects unsafe values', async (t) => {
  const root = temporary(t); const selected = profile(root);
  const passwordFile = path.join(root, 'password.txt'); fs.writeFileSync(passwordFile, 'a private example password\n');
  const config = await configure(selected, { 'non-interactive': true, port: '12903', 'password-file': passwordFile });
  assert.match(config.HAPLA_ACCESS_PASSWORD_HASH, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert(!fs.readFileSync(selected.envFile, 'utf8').includes('a private example password'));
  for (const [key, value] of [['HAPLA_PORT', '9980'], ['HAPLA_PORT', 'not-a-port'], ['HAPLA_WEBAPP_URL', 'https://user:pass@example.com'],
    ['HAPLA_BIND_ADDRESS', 'example.com'], ['HAPLA_ASR_PAGE_URL', 'http://example.com'], ['HAPLA_SERVER_IMAGE', 'other:latest']]) {
    assert.throws(() => validateConfig({ ...config, [key]: value }));
  }
});

test('configuration writes refuse symlinks and leave the linked file untouched', (t) => {
  const root = temporary(t); const target = path.join(root, 'other'); const link = path.join(root, 'config');
  fs.writeFileSync(target, 'preserve'); fs.symlinkSync(target, link);
  assert.throws(() => writeConfig(link, { A: 'value' }), /符号链接/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserve');
});

test('available-port selection skips an occupied listener', async (t) => {
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  t.after(() => listener.close());
  const port = listener.address().port;
  assert.notEqual(await freePort(port, '127.0.0.1'), String(port));
});

test('isolation checks distinguish running foreign owners, rollbacks, own stack, and user workers', () => {
  const selected = profile('/checkout'); const config = { HAPLA_PORT: '12345' };
  const base = { running: true, files: '/checkout/.runtime/container-workers/compose.yml', ports: [] };
  const workers = ['account-a', 'account-b'].map((name) => ({ ...base, name: `hapla-${name}`, project: 'hapla-workers' }));
  const rollback = { ...base, name: 'hapla-web-1-before-upgrade', project: '', running: false, ports: ['12345'] };
  assert.deepEqual(isolationProblems(selected, config, [...workers, rollback]), []);
  assert.equal(isolationProblems(selected, config, [{ ...base, name: 'foreign-web', project: 'foreign', ports: ['12345'] }]).length, 1);
  assert.equal(isolationProblems(selected, config, [{ ...base, name: 'hapla-web-1', project: '' }]).length, 1);
  assert(isolationProblems(selected, config, [{ ...base, name: 'hapla-web-1', project: 'hapla', files: '/another/docker-compose.selfhost.yml' }]).length >= 1);
  assert.match(isolationProblems(selected, config, [{ ...base, name: 'hapla-web-1', project: 'hapla', files: '/checkout/docker-compose.selfhost.yml,/checkout/private-override.yml' }]).join('\n'), /额外的 Compose/);
  assert.deepEqual(isolationProblems(selected, config, [{ ...base, name: 'hapla-web-1', project: 'hapla', ports: ['12345'], files: '/checkout/docker-compose.selfhost.yml' }]), []);
});

test('worker identities get separate project-scoped volumes and never receive the relay secret', (t) => {
  const selected = profile(temporary(t), 'team');
  fs.mkdirSync(path.join(selected.root, 'packages/hapla-cli/src/codex'), { recursive: true });
  fs.writeFileSync(path.join(selected.root, 'packages/hapla-cli/src/codex/codexProtocolSnapshot.json'), '{"cliVersion":"0.159.0"}');
  const config = { HAPLA_WEBAPP_URL: 'https://hapla.example.com', HAPLA_MASTER_SECRET: 'private-relay-secret' };
  const a = workerConfig(selected, 'account-a', config, { create: true });
  const b = workerConfig(selected, 'account-b', config, { create: true });
  assert.notEqual(a.file, b.file); assert.notEqual(a.worker.HAPLA_WORKER_PROJECT, b.worker.HAPLA_WORKER_PROJECT);
  assert.equal(a.worker.HAPLA_RELAY_NETWORK, b.worker.HAPLA_RELAY_NETWORK);
  assert(!fs.readFileSync(a.file, 'utf8').includes('private-relay-secret'));
  a.worker.HAPLA_RELAY_NETWORK = 'another-environment'; writeConfig(a.file, a.worker);
  assert.throws(() => workerConfig(selected, 'account-a', config), /不符合当前实例/);
});

test('container command flags are passed to the worker rather than interpreted as setup flags', () => {
  assert.deepEqual(parseArgs(['--instance', 'team', 'worker-run', 'account-b', 'codex', 'login', '--device-auth']),
    { command: 'worker-run', args: ['account-b', 'codex', 'login', '--device-auth'], options: { instance: 'team' } });
  assert.throws(() => parseArgs(['--unknown']), /未知选项/);
});

test('CLI configure/check/down use the chosen project and preserve volumes and secrets', (t) => {
  const f = fixture(t);
  const setup = f.run(['configure', '--instance', 'test', '--port', '12909', '--non-interactive']);
  assert.equal(setup.status, 0, setup.stderr);
  const selected = profile(f.root, 'test'); const secret = readConfig(selected.envFile).HAPLA_MASTER_SECRET;
  assert(!setup.stdout.includes(secret)); assert(!f.calls().some((args) => args.includes('up') || args.includes('build')));
  const check = f.run(['check', '--instance', 'test']); assert.equal(check.status, 0, check.stderr);
  const otherContainer = JSON.stringify({ name: '/other-app', running: true, labels: { 'router.rule': 'Host(a) || Host(b)' }, ports: {} });
  const withOtherApp = f.run(['check', '--instance', 'test'], { HAPLA_TEST_CONTAINER: otherContainer });
  assert.equal(withOtherApp.status, 0, withOtherApp.stderr);
  const down = f.run(['down', '--instance', 'test']); assert.equal(down.status, 0, down.stderr);
  const actions = f.calls().filter((args) => args[0] === 'compose' && args.includes('--project-name'));
  assert(actions.every((args) => args.includes('hapla-test') && args.includes(selected.envFile)));
  assert(actions.some((args) => args.at(-1) === 'down'));
  assert(actions.every((args) => !args.includes('-v') && !args.includes('--volumes')));
  assert.equal(readConfig(selected.envFile).HAPLA_MASTER_SECRET, secret);
});

test('CLI up refuses existing data without configuration before generating a new key', (t) => {
  const f = fixture(t);
  const result = f.run(['up', '--instance', 'existing', '--non-interactive'], { HAPLA_TEST_VOLUME_PRESENT: '1' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /已有数据库卷/);
  assert(!fs.existsSync(profile(f.root, 'existing').envFile));
  assert(!f.calls().some((args) => args.includes('up')));
});

test('configure cannot bypass the missing-key protection for an existing database', (t) => {
  const f = fixture(t);
  const result = f.run(['configure', '--instance', 'existing', '--non-interactive'], { HAPLA_TEST_VOLUME_PRESENT: '1' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /已有数据库卷/);
  assert(!fs.existsSync(profile(f.root, 'existing').envFile));
  const selected = profile(f.root, 'partial');
  writeConfig(selected.envFile, { HAPLA_PORT: '12910' });
  const partial = f.run(['up', '--instance', 'partial', '--non-interactive'], { HAPLA_TEST_VOLUME_PRESENT: '1' });
  assert.notEqual(partial.status, 0); assert.match(partial.stderr, /已有数据库卷/);
  assert.deepEqual(readConfig(selected.envFile), { HAPLA_PORT: '12910' });
});

test('down refuses a project name that belongs to another checkout', (t) => {
  const f = fixture(t);
  const selected = profile(f.root, 'shared');
  writeConfig(selected.envFile, defaults(selected, {}));
  const foreign = JSON.stringify({ name: '/hapla-shared-web-1', running: true,
    labels: { 'com.docker.compose.project': selected.project,
      'com.docker.compose.project.config_files': '/another/docker-compose.selfhost.yml' }, ports: {} });
  const result = f.run(['down', '--instance', 'shared'], { HAPLA_TEST_CONTAINER: foreign });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /其他部署配置/);
  assert(!f.calls().some((args) => args.includes('down')));
});

test('failure to inspect Docker volumes is not treated as an empty fresh installation', (t) => {
  const f = fixture(t);
  const result = f.run(['configure', '--instance', 'unknown', '--non-interactive'], { HAPLA_TEST_VOLUME_ERROR: '1' });
  assert.notEqual(result.status, 0);
  assert(!fs.existsSync(profile(f.root, 'unknown').envFile));
});

test('CLI refuses a legacy unmanaged container collision without touching its deployment', (t) => {
  const f = fixture(t);
  const row = JSON.stringify({ name: '/hapla-web-1', running: true, labels: {}, ports: {} });
  const result = f.run(['up', '--non-interactive'], { HAPLA_TEST_CONTAINER: row });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /不属于目标 Compose 项目/);
  assert(!fs.existsSync(path.join(f.root, '.env.selfhost')));
  assert(!f.calls().some((args) => args.includes('up') || args.includes('down')));
});

test('CLI up builds the selected stack, follows its health endpoint, and reports readiness', { timeout: 15_000 }, async (t) => {
  const f = fixture(t);
  const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise((resolve) => reserve.close(resolve));
  const marker = path.join(f.root, 'start-marker');
  const server = http.createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end('{"status":"ok"}'); });
  let started = false;
  const timer = setInterval(() => { if (!started && fs.existsSync(marker)) { started = true; server.listen(port, '127.0.0.1'); } }, 10);
  t.after(() => { clearInterval(timer); server.close(); });
  const child = spawn(process.execPath, [path.join(f.root, 'scripts/selfhost.cjs'), 'up', '--instance', 'flow', '--port', String(port), '--non-interactive'],
    { cwd: f.root, env: { ...f.env, HAPLA_TEST_START_MARKER: marker } });
  t.after(() => child.kill());
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, output); assert.match(output, /Hapla 已就绪/);
  assert(f.calls().some((args) => args.includes('up') && args.includes('--build') && args.includes('hapla-flow')));
});

test('health checking rejects an unrelated success page instead of declaring deployment ready', async (t) => {
  const server = http.createServer((_request, response) => response.end('<html>another service</html>'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  await assert.rejects(waitHealthy({ HAPLA_BIND_ADDRESS: '127.0.0.1', HAPLA_PORT: server.address().port }, { timeout: 20 }), /未在/);
});

const composeAvailable = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;
test('real Compose rendering isolates two users and two full environments', { skip: !composeAvailable }, (t) => {
  const root = temporary(t);
  const renders = [];
  for (const instance of ['alpha', 'beta']) {
    const selected = profile(ROOT, instance);
    const config = defaults(selected, {}, instance === 'alpha' ? { subnet: '10.251.33.0/24' } : {});
    const file = path.join(root, `${instance}.env`); writeConfig(file, config);
    const rendered = spawnSync('docker', [...composeArgs({ ...selected, envFile: file }, config), 'config', '--format', 'json'],
      { encoding: 'utf8', env: { ...process.env, ...config, COMPOSE_FILE: '' } });
    assert.equal(rendered.status, 0, rendered.stderr); renders.push(JSON.parse(rendered.stdout));
  }
  assert.notEqual(renders[0].volumes['hapla-data'].name, renders[1].volumes['hapla-data'].name);
  assert.equal(renders[0].networks.default.ipam.config[0].subnet, '10.251.33.0/24');
  assert.equal(renders[1].networks.default.ipam?.config, undefined);
  const homes = [];
  for (const user of ['account-a', 'account-b']) {
    const env = { HAPLA_WORKER_PROJECT: `hapla-alpha-worker-${user}`, HAPLA_WORKER_IMAGE: 'hapla-alpha-worker:local', HAPLA_RELAY_NETWORK: 'hapla-alpha_default',
      HAPLA_WORKER_WEBAPP_URL: 'http://localhost:12900', HAPLA_CODEX_VERSION: '0.159.0', HAPLA_CLAUDE_CODE_VERSION: '' };
    const file = path.join(root, `${user}.env`); writeConfig(file, env);
    const rendered = spawnSync('docker', ['compose', '-p', env.HAPLA_WORKER_PROJECT, '--env-file', file, '-f', path.join(ROOT, 'deploy/compose.worker.yml'), 'config', '--format', 'json'],
      { encoding: 'utf8', env: { ...process.env, ...env, COMPOSE_FILE: '' } });
    assert.equal(rendered.status, 0, rendered.stderr); const config = JSON.parse(rendered.stdout);
    const worker = config.services.worker;
    assert.equal(worker.user, '1000:1000'); assert.equal(worker.ports, undefined);
    assert.equal(worker.environment.HAPLA_WORKSPACE_ROOT, '/workspace'); assert.equal(worker.environment.HAPLA_MASTER_SECRET, undefined);
    assert(worker.volumes.every((volume) => volume.type === 'volume'));
    homes.push(config.volumes['worker-home'].name);
  }
  assert.notEqual(homes[0], homes[1]);
});
