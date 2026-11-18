import { describe, expect, it } from 'vitest';
import { daemonBuildMatches, fingerprintCliBuild } from './cliBuildFingerprint';

describe('daemon CLI build identity', () => {
  it('changes when the executable changes without a version bump', () => {
    const before = fingerprintCliBuild('same version, old runtime');
    const after = fingerprintCliBuild('same version, manual-only runtime');

    expect(before).not.toBe(after);
    expect(daemonBuildMatches(
      { startedWithCliVersion: '1.1.6', startedWithCliBuild: before },
      { version: '1.1.6', build: after },
    )).toBe(false);
  });

  it('accepts only the exact version and executable fingerprint', () => {
    const build = fingerprintCliBuild('installed runtime');
    const state = { startedWithCliVersion: '1.1.6', startedWithCliBuild: build };

    expect(daemonBuildMatches(state, { version: '1.1.6', build })).toBe(true);
    expect(daemonBuildMatches(state, { version: '1.1.7', build })).toBe(false);
    expect(daemonBuildMatches({ startedWithCliVersion: '1.1.6' }, { version: '1.1.6', build })).toBe(false);
    expect(daemonBuildMatches(state, { version: '1.1.6', build: null })).toBe(false);
  });
});
