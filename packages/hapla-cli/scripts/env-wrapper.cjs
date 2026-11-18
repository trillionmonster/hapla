#!/usr/bin/env node
/**
 * Cross-platform environment wrapper for Hapla CLI.
 *
 * Usage: node scripts/env-wrapper.js <variant> <command> [...args]
 *
 * Variants:
 *   - stable: Production-ready version using ~/.hapla/
 *   - dev: Development version using ~/.hapla-dev/
 *
 * Examples:
 *   node scripts/env-wrapper.js stable daemon start
 *   node scripts/env-wrapper.js dev auth login
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const VARIANTS = {
  stable: {
    homeDir: path.join(os.homedir(), '.hapla'),
    color: '\x1b[32m', // Green
    label: '✅ STABLE',
    serverUrl: process.env.HAPLA_SERVER_URL || 'http://127.0.0.1:12345'
  },
  dev: {
    homeDir: path.join(os.homedir(), '.hapla-dev'),
    color: '\x1b[33m', // Yellow
    label: '🔧 DEV',
    serverUrl: process.env.HAPLA_SERVER_URL || 'http://127.0.0.1:12345'
  }
};

const variant = process.argv[2];
const command = process.argv[3];
const args = process.argv.slice(4);

if (!variant || !VARIANTS[variant]) {
  console.error('Usage: node scripts/env-wrapper.js <stable|dev> <command> [...args]');
  console.error('');
  console.error('Variants:');
  console.error('  stable - Production-ready version (data: ~/.hapla/)');
  console.error('  dev    - Development version (data: ~/.hapla-dev/)');
  console.error('');
  console.error('Examples:');
  console.error('  node scripts/env-wrapper.js stable daemon start');
  console.error('  node scripts/env-wrapper.js dev auth login');
  process.exit(1);
}

const config = VARIANTS[variant];

// Create home directory if it doesn't exist
if (!fs.existsSync(config.homeDir)) {
  fs.mkdirSync(config.homeDir, { recursive: true });
}

// Visual feedback
console.log(`${config.color}${config.label}\x1b[0m Hapla CLI (data: ${config.homeDir})`);

// Set environment and execute command
const env = {
  ...process.env,
  HAPLA_HOME_DIR: config.homeDir,
  HAPLA_SERVER_URL: config.serverUrl,
  HAPLA_VARIANT: variant,
};

const binPath = path.join(__dirname, '..', 'dist', 'index.mjs');
const proc = spawn(process.execPath, ['--no-warnings', '--no-deprecation', binPath, command, ...args], {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

proc.on('exit', (code) => process.exit(code || 0));
