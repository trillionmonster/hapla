#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomBytes, scryptSync } = require('node:crypto');
const { createInterface } = require('node:readline/promises');
const { profile, validName, readConfig, writeConfig, validateConfig, defaults, composeArgs,
  allowedOverrides, ownershipProblems, isolationProblems, portAvailable, freePort, validateUrl } = require('./lib/selfhost.cjs');

const ROOT = path.resolve(__dirname, '..');
const HELP = `Hapla 一键配置与部署（Node.js 22+ / Docker Compose v2）

  ./deploy.sh                           引导配置、构建并启动，等待健康检查
  ./deploy.sh configure                 只生成或更新私有配置
  ./deploy.sh up --non-interactive      使用默认值一键启动
  ./deploy.sh check                     校验配置和资源归属，不启动服务
  ./deploy.sh status | logs | down      查看状态、日志或停止（保留数据卷）
  ./deploy.sh worker-add NAME           生成独立用户执行器配置与登录说明
  ./deploy.sh worker-run NAME COMMAND   在该用户的独立状态卷中执行命令
  ./deploy.sh worker-up NAME            构建并启动该用户执行器
  ./deploy.sh worker-down NAME          停止该用户执行器，保留状态与工作区

选项（放在命令前或后，worker-run 的容器命令参数放在 NAME 后）：
  --instance NAME       独立整套环境；默认 default，额外环境使用 hapla-NAME 项目
  --port NUMBER         Web 端口；新配置默认从 12345 自动寻找空闲端口
  --bind IPV4           默认 127.0.0.1；局域网可设 0.0.0.0
  --subnet CIDR         Docker 默认地址池不足时，指定未使用的私有网段
  --url URL             浏览器访问地址，用于账号配对
  --password-file PATH  从私有文件读取入口密码，只保存哈希
  --asr-url URL         可选 ASR 上游
  --asr-page-url URL    可选 HTTPS 听写页面
  --file-service URL    可选外部 R2 文件服务，自动合并对应覆盖文件
  --non-interactive     不询问，适合自动化
  --help                显示帮助

首次 agent 登录必须由各账号分别完成，不会复制其他用户凭据。`;

function parseArgs(argv) {
  const options = {};
  const positional = [];
  const values = new Set(['instance', 'port', 'bind', 'subnet', 'url', 'password-file', 'asr-url', 'asr-page-url', 'file-service']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--non-interactive') { options['non-interactive'] = true; continue; }
    if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      if (!values.has(key)) throw new Error(`未知选项：--${key}；运行 ./deploy.sh --help 查看用法。`);
      const value = rest.length ? rest.join('=') : argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 缺少值。`);
      options[key] = value;
    } else {
      positional.push(arg);
      if (positional[0] === 'worker-run' && positional.length === 2) {
        positional.push(...argv.slice(i + 1));
        break;
      }
    }
  }
  return { command: positional[0] || 'up', args: positional.slice(1), options };
}

function docker(args, { capture = false, env = {}, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, { cwd: ROOT, env: { ...process.env, ...env },
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (!allowFailure && (result.error || result.status !== 0)) {
    // Do not include rendered environment or credential-bearing output in errors.
    throw new Error(result.error?.code === 'ENOENT' ? '未安装 Docker。请安装 Docker Desktop 或 Docker Engine + Compose v2。'
      : 'Docker 命令失败。请查看上面的错误，或用 ./deploy.sh status / logs 排查。');
  }
  return result;
}

function requireDocker() {
  const version = docker(['compose', 'version'], { capture: true, allowFailure: true });
  if (version.status !== 0) throw new Error('需要 Docker 和 Compose v2。请确认 docker compose version 可用。');
  const info = docker(['info', '--format', '{{.ServerVersion}}'], { capture: true, allowFailure: true });
  if (info.status !== 0) throw new Error('Docker 未启动或当前用户无权访问。请启动 Docker，并确认 docker info 可用。');
  if (process.env.COMPOSE_FILE) throw new Error('请先取消 COMPOSE_FILE；一键入口会显式选择环境和覆盖文件。');
}

function protectExistingData(selected) {
  if (readConfig(selected.envFile).HAPLA_MASTER_SECRET) return;
  const name = `${selected.project}_hapla-data`;
  const volumes = docker(['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}'], { capture: true });
  if (volumes.stdout.trim().split('\n').includes(name)) {
    throw new Error('发现已有数据库卷但主密钥缺失。请恢复原 HAPLA_MASTER_SECRET，或用 --instance 新名称创建独立环境。');
  }
}

function containers() {
  const list = docker(['ps', '-aq'], { capture: true }).stdout.trim().split(/\s+/).filter(Boolean);
  if (!list.length) return [];
  const format = '{"name":{{json .Name}},"running":{{json .State.Running}},"labels":{{json .Config.Labels}},"ports":{{json .NetworkSettings.Ports}}}';
  return docker(['inspect', '--format', format, ...list], { capture: true }).stdout.trim().split('\n').map((line) => {
    const { name, running, labels, ports } = JSON.parse(line);
    return { name: name.replace(/^\//, ''), running, project: labels?.['com.docker.compose.project'] || '',
      files: labels?.['com.docker.compose.project.config_files'] || '',
      ports: Object.values(ports || {}).flatMap((bindings) => (bindings || []).map((binding) => binding.HostPort)) };
  });
}

async function configure(selected, options) {
  const existing = readConfig(selected.envFile);
  let config = defaults(selected, existing, options);
  const fresh = !fs.existsSync(selected.envFile);
  validateConfig(config, { template: true });
  if (fresh && options.port === undefined) config.HAPLA_PORT = await freePort(12345, config.HAPLA_BIND_ADDRESS);
  if (fresh && !options['non-interactive'] && process.stdin.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('\n直接回车即可使用默认设置；密钥自动生成，不会显示。');
      if (options.port === undefined) config.HAPLA_PORT = (await prompt.question(`Web 端口 [${config.HAPLA_PORT}]：`)).trim() || config.HAPLA_PORT;
      if (options.bind === undefined) {
        const lan = (await prompt.question('允许局域网访问？[y/N]：')).trim().toLowerCase();
        if (lan === 'y' || lan === 'yes') config.HAPLA_BIND_ADDRESS = '0.0.0.0';
      }
      if (options.url === undefined) config.HAPLA_WEBAPP_URL = (await prompt.question(`浏览器访问地址 [http://localhost:${config.HAPLA_PORT}]：`)).trim() || `http://localhost:${config.HAPLA_PORT}`;
    } finally { prompt.close(); }
  } else if (fresh && options.url === undefined) config.HAPLA_WEBAPP_URL = `http://localhost:${config.HAPLA_PORT}`;
  if (options['password-file']) {
    const password = fs.readFileSync(path.resolve(options['password-file']), 'utf8').replace(/\r?\n$/, '');
    if (!password || Buffer.byteLength(password) > 1024) throw new Error('密码文件须包含 1–1024 字节的单行密码。');
    if (/[\r\n]/.test(password)) throw new Error('密码文件须为单行。');
    const salt = randomBytes(16);
    config.HAPLA_ACCESS_PASSWORD_HASH = `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 32).toString('hex')}`;
  }
  validateConfig(config);
  writeConfig(selected.envFile, config);
  console.log(`配置已保存：${path.relative(ROOT, selected.envFile)}（权限 0600；已有密钥保持不变）`);
  return config;
}

async function preflight(selected, config, inventory) {
  const problems = isolationProblems(selected, config, inventory);
  if (problems.length) throw new Error(problems.join('\n'));
  const owned = inventory.some((container) => container.running && container.project === selected.project
    && container.ports.includes(String(config.HAPLA_PORT)));
  if (!owned && !await portAvailable(config.HAPLA_PORT, config.HAPLA_BIND_ADDRESS)) {
    throw new Error(`端口 ${config.HAPLA_PORT} 无法监听；请用 --port 其他端口或检查 --bind。`);
  }
}

function compose(selected, config, args, settings = {}) {
  return docker([...composeArgs(selected, config), ...args], { ...settings, env: composeEnv(selected.project, config) });
}

function composeEnv(project, config) {
  const variables = Object.entries(config).filter(([key]) => key === 'PUBLIC_URL' || key.startsWith('HAPLA_'));
  return { ...Object.fromEntries(variables), COMPOSE_PROJECT_NAME: project, COMPOSE_REMOVE_ORPHANS: 'false' };
}

function ensureOwnership(project, primaryFile, allowedFiles = []) {
  const problems = ownershipProblems(project, primaryFile, allowedFiles, containers());
  if (problems.length) throw new Error(problems.join('\n'));
}

async function waitHealthy(config, { timeout = 180_000 } = {}) {
  const host = config.HAPLA_BIND_ADDRESS === '0.0.0.0' ? '127.0.0.1' : config.HAPLA_BIND_ADDRESS;
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try {
      const response = await fetch(`http://${host}:${config.HAPLA_PORT}/health`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
      if (response.ok && (await response.json()).status === 'ok') return;
    } catch { /* startup/migration may still be in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`服务未在 ${Math.ceil(timeout / 1000)} 秒内就绪。配置和数据已保留，请运行同一 --instance 的 status / logs；不会自动删除或重置数据库。`);
}

function workerConfig(selected, name, config, { create = false } = {}) {
  validName(name);
  const file = path.join(selected.directory, 'workers', `${name}.env`);
  if (create && !fs.existsSync(file)) {
    const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/hapla-cli/src/codex/codexProtocolSnapshot.json'), 'utf8'));
    writeConfig(file, { HAPLA_WORKER_PROJECT: `${selected.project}-worker-${name}`,
      HAPLA_WORKER_IMAGE: `${selected.project}-worker:local`, HAPLA_RELAY_NETWORK: `${selected.project}_default`,
      HAPLA_WORKER_WEBAPP_URL: config.HAPLA_WEBAPP_URL, HAPLA_CODEX_VERSION: snapshot.cliVersion,
      HAPLA_CLAUDE_CODE_VERSION: '' });
  }
  if (!fs.existsSync(file)) throw new Error(`执行器未配置，请先运行 worker-add ${name}。`);
  const worker = readConfig(file);
  if (worker.HAPLA_WORKER_PROJECT !== `${selected.project}-worker-${name}`
      || worker.HAPLA_RELAY_NETWORK !== `${selected.project}_default`
      || worker.HAPLA_WORKER_IMAGE !== `${selected.project}-worker:local`) throw new Error('执行器项目、网络或镜像不符合当前实例，请检查私有配置。');
  validateUrl(worker.HAPLA_WORKER_WEBAPP_URL, 'HAPLA_WORKER_WEBAPP_URL', true);
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(worker.HAPLA_CODEX_VERSION)
      || (worker.HAPLA_CLAUDE_CODE_VERSION && !/^\d+\.\d+\.\d+$/.test(worker.HAPLA_CLAUDE_CODE_VERSION))) throw new Error('执行器 agent 版本须为明确的版本号。');
  return { file, worker };
}

async function main(argv = process.argv.slice(2)) {
  const { command, args, options } = parseArgs(argv);
  if (options.help) { console.log(HELP); return; }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('请安装 Node.js 22 或更新版本。');
  const known = ['configure', 'up', 'check', 'preflight', 'config-check', 'status', 'logs', 'down', 'worker-add', 'worker-run', 'worker-up', 'worker-down'];
  if (!known.includes(command)) throw new Error('未知命令；运行 ./deploy.sh --help 查看用法。');
  const selected = profile(ROOT, options.instance);
  if (!['configure', 'up'].includes(command)
      && Object.keys(options).some((key) => !['instance', 'non-interactive'].includes(key))) {
    throw new Error('端口、URL、密码等配置选项仅用于 configure 或 up；读取/停止命令只需 --instance。');
  }
  if (!command.startsWith('worker-') && args.length) throw new Error('命令含多余参数；运行 ./deploy.sh --help 查看用法。');
  if (command === 'configure') { requireDocker(); protectExistingData(selected); await configure(selected, options); return; }
  if (command === 'worker-add') {
    const config = readConfig(selected.envFile);
    if (!config.HAPLA_WEBAPP_URL) throw new Error('请先运行 configure 或 up 配置中继实例。');
    const { file } = workerConfig(selected, args[0], config, { create: true });
    const prefix = `./deploy.sh --instance ${selected.instance}`;
    console.log(`独立执行器配置：${path.relative(ROOT, file)}\n请由 ${args[0]} 自己的账号依次完成：\n`
      + `${prefix} worker-run ${args[0]} hapla auth login\n`
      + `${prefix} worker-run ${args[0]} codex login --device-auth\n`
      + `${prefix} worker-up ${args[0]}`);
    return;
  }
  requireDocker();
  let config = readConfig(selected.envFile);
  if (command === 'up') {
    protectExistingData(selected);
    // Detect a legacy container-name collision before generating any local config.
    const inventory = containers();
    const conflicts = isolationProblems(selected, { HAPLA_PORT: options.port || config.HAPLA_PORT || '' }, inventory);
    if (conflicts.length) throw new Error(conflicts.join('\n'));
    config = await configure(selected, options);
    await preflight(selected, config, inventory);
    compose(selected, config, ['config', '--quiet']);
    console.log(`正在构建并启动 ${selected.project}；首次构建可能需要数分钟。`);
    compose(selected, config, ['up', '-d', '--build']);
    console.log('容器已启动，等待 Web → Server → 数据库健康检查……');
    await waitHealthy(config);
    console.log(`Hapla 已就绪：${config.HAPLA_WEBAPP_URL}\n项目：${selected.project}\n停止但保留数据：./deploy.sh --instance ${selected.instance} down`);
    return;
  }
  if (command.startsWith('worker-')) {
    const { file, worker } = workerConfig(selected, args[0], config);
    const workerCompose = path.join(ROOT, 'deploy/compose.worker.yml');
    const workerArgs = ['compose', '--project-name', worker.HAPLA_WORKER_PROJECT, '--env-file', file,
      '-f', workerCompose];
    if (command === 'worker-run' && args.length < 2) throw new Error('worker-run NAME 后需要命令，例如 hapla auth login。');
    if (command !== 'worker-down' && docker(['network', 'inspect', worker.HAPLA_RELAY_NETWORK], { capture: true, allowFailure: true }).status !== 0) {
      throw new Error('中继网络不存在，请先运行同一 --instance 的 up。');
    }
    const action = command === 'worker-up' ? ['up', '-d', '--build']
      : command === 'worker-down' ? ['down'] : ['run', '--build', '--rm', ...(process.stdin.isTTY ? [] : ['-T']), 'worker', ...args.slice(1)];
    ensureOwnership(worker.HAPLA_WORKER_PROJECT, workerCompose);
    docker([...workerArgs, ...action], { env: composeEnv(worker.HAPLA_WORKER_PROJECT, worker) });
    if (command === 'worker-up') console.log('执行器容器已启动；请在 Web 机器列表确认此账号已在线。容器启动不等于 agent 登录成功。');
    return;
  }
  const template = !fs.existsSync(selected.envFile);
  if (template && ['check', 'preflight', 'config-check'].includes(command)) {
    config = defaults(selected, readConfig(path.join(ROOT, '.env.selfhost.example')));
    selected.envFile = path.join(ROOT, '.env.selfhost.example');
  } else if (template) throw new Error('尚未配置，请先运行 ./deploy.sh configure。');
  validateConfig(config, { template });
  if (['check', 'preflight'].includes(command)) await preflight(selected, config, containers());
  if (['check', 'config-check'].includes(command)) compose(selected, config, ['config', '--quiet']);
  else if (command === 'status') compose(selected, config, ['ps', '-a']);
  else if (command === 'logs') compose(selected, config, ['logs', '--tail', '100']);
  else if (command === 'down') {
    ensureOwnership(selected.project, path.join(ROOT, 'docker-compose.selfhost.yml'),
      allowedOverrides(ROOT));
    compose(selected, config, ['down']);
  }
  if (['check', 'preflight', 'config-check'].includes(command)) console.log(`检查通过：${selected.project}${template ? '（示例配置；尚未部署）' : ''}`);
}

if (require.main === module) main().catch((error) => { console.error(`Hapla: ${error.message}`); process.exitCode = 1; });
module.exports = { main, parseArgs, configure, workerConfig, waitHealthy };
