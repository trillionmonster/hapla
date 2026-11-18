#!/usr/bin/env node
// Read the password from stdin so it never appears in the process arguments.
const { readFileSync } = require('node:fs');
const { randomBytes, scryptSync } = require('node:crypto');
const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
if (!password || Buffer.byteLength(password) > 1024) {
    console.error('Provide a password of 1–1024 bytes on stdin.');
    process.exit(1);
}
const salt = randomBytes(16);
process.stdout.write(`scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 32).toString('hex')}\n`);
