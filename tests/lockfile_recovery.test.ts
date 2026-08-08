import { describe, expect, it } from 'vitest';
import { installRetryArgs, isLockfileOutOfSync } from '../src/sandbox/subprocess.js';

const ci = ['ci', '--ignore-scripts', '--no-audit', '--no-fund'];
const install = ['install', '--ignore-scripts', '--no-audit', '--no-fund'];
const outOfSync = { exitCode: 1, stderr: 'npm error code EUSAGE\nnpm error ...' };

describe('lockfile out of sync', () => {
  it("is recognised by npm's own error code, not only its sentence", () => {
    expect(isLockfileOutOfSync('npm error code EUSAGE')).toBe(true);
    expect(isLockfileOutOfSync(
      '`npm ci` can only install packages when your package.json and package-lock.json are in sync.',
    )).toBe(true);
    expect(isLockfileOutOfSync('npm error code ENOTFOUND registry.npmjs.org')).toBe(false);
    expect(isLockfileOutOfSync('')).toBe(false);
  });

  // HIGH_LEVEL_DESIGN authors package.json by writing the file, and no lockfile comes with it — so
  // `npm ci`, which refuses when the two disagree, is wrong for every sync that follows a manifest
  // write. All three sync paths were failing this way at once in a live run, and each only recorded
  // a note, so no environment was ever updated after the manifest changed and nothing said why.
  it('retries a refused `npm ci` as `npm install`, which is what npm asks for', () => {
    expect(installRetryArgs(ci, outOfSync)).toEqual(install);
  });

  it('does not retry anything else', () => {
    // A successful install has nothing to fix.
    expect(installRetryArgs(ci, { exitCode: 0, stderr: '' })).toBeUndefined();
    // A network failure is not fixed by changing the command.
    expect(installRetryArgs(ci, { exitCode: 1, stderr: 'npm error code ENOTFOUND' })).toBeUndefined();
    // `npm install` already refreshes the lockfile; retrying it would loop.
    expect(installRetryArgs(install, outOfSync)).toBeUndefined();
  });
});
