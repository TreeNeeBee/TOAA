import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  discoverDebugContextPaths,
  extractWorkspacePaths,
} from '../src/application/execution/debug_context_snippets.js';
import { Workspace } from '../src/workspace/workspace.js';

describe('Debugger context discovery', () => {
  it('loads direct local implementations imported by a failed TypeScript test', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-debug-context-'));
    const workspace = new Workspace(root);
    await workspace.writeFile('tests/integration/pipeline.test.ts', [
      "import { aggregate } from '../../src/aggregator/index.js';",
      "import { generate } from '../../src/reporter';",
      "import { describe } from 'vitest';",
      'void aggregate; void generate; void describe;',
    ].join('\n'));
    await workspace.writeFile('src/aggregator/index.ts', 'export function aggregate() {}\n');
    await workspace.writeFile('src/reporter/index.ts', 'export function generate() {}\n');

    const paths = await discoverDebugContextPaths({
      workspace,
      seedPaths: ['tests/integration/pipeline.test.ts'],
      failureEvidence: 'FAIL tests/integration/pipeline.test.ts:7:2',
      language: 'typescript',
    });

    expect(paths).toEqual([
      'tests/integration/pipeline.test.ts',
      'src/aggregator/index.ts',
      'src/reporter/index.ts',
    ]);
  });

  it('keeps extracted failure paths inside the workspace', () => {
    expect(extractWorkspacePaths([
      'FAIL tests/unit/core.test.ts:12',
      'at src/core/index.ts:9:2',
      'ignore ../../outside/secret.txt',
      'ignore /tmp/external/file.ts',
    ].join('\n'))).toEqual([
      'tests/unit/core.test.ts',
      'src/core/index.ts',
    ]);
  });

  it('extracts only explicit artifact paths, not nearby bare filenames', () => {
    expect(extractWorkspacePaths([
      'pipeline.test.ts is failing',
      'run_tests: npm test exit=1 args=tests/integration/pipeline.test.ts',
      'implementation src/cli.ts does not match',
    ].join('\n'))).toEqual([
      'tests/integration/pipeline.test.ts',
      'src/cli.ts',
    ]);
  });

  it('prioritizes exact failure artifacts when broad Step outputs exceed the context limit', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-debug-context-priority-'));
    const workspace = new Workspace(root);
    const broadOutputs = Array.from({ length: 6 }, (_, index) => `src/generated-${index}.ts`);
    for (const output of broadOutputs) await workspace.writeFile(output, `export const v${output.length} = 1;\n`);
    await workspace.writeFile('tests/functional/cli.test.ts', 'void "failed gate";\n');

    const paths = await discoverDebugContextPaths({
      workspace,
      seedPaths: broadOutputs,
      failureEvidence: 'FAIL tests/functional/cli.test.ts:42',
      language: 'typescript',
      maxPaths: 3,
    });

    expect(paths[0]).toBe('tests/functional/cli.test.ts');
    expect(paths).toHaveLength(3);
  });
});
