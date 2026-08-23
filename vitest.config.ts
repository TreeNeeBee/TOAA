import { defineConfig } from 'vitest/config';

/**
 * Test suites are separated by the capabilities they require, not by the architectural layer they
 * cover, because capability is what CI actually has to gate on. Nearly every test here is
 * deterministic; only a handful bind a loopback socket or spawn a real process, and those are
 * exactly the ones that fail in restricted sandboxes. Giving them their own suites lets a
 * restricted environment still run the full deterministic gate instead of reporting an environment
 * restriction as a product regression.
 *
 *   npm run test              every suite
 *   npm run test:core         deterministic only; required for every change
 *   npm run test:integration  loopback sockets and real subprocesses
 *   npm run test:e2e          spawns the real CLI/ACP process
 */
export default defineConfig({
  test: {
    reporters: 'default',
    projects: [
      {
        test: {
          name: 'core',
          include: ['tests/*.test.ts'],
          environment: 'node',
          globals: false,
          // The domain engine drives whole V-model runs in memory; the slowest case takes ~3s on a
          // developer machine and roughly three times that on a shared CI runner, which put it past
          // the 5s default. Long enough to absorb a slower host, short enough to still catch a hang.
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globals: false,
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          environment: 'node',
          globals: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
