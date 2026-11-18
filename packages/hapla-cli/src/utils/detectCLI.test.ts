import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executableOverrideExists } from './detectCLI';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('configured CLI executable', () => {
  it('accepts only an existing executable path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hapla-cli-detect-'));
    directories.push(directory);
    const executable = join(directory, 'codex');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    expect(executableOverrideExists(executable)).toBe(true);
    expect(executableOverrideExists(join(directory, 'missing'))).toBe(false);
    expect(executableOverrideExists('  ')).toBe(false);
  });
});
