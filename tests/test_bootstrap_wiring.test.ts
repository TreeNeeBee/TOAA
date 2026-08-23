import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLanguageProfile } from '../src/core/language.js';
import { Workspace } from '../src/workspace/workspace.js';

/**
 * A suite cannot import the product until something puts the product on the path.
 *
 * `LanguageProfile.ensureTestBootstrap` has existed since the language layer was written and had no
 * caller, so `tests/conftest.py` was never created and every Python project's tests failed to import
 * `src/` until some Step happened to invent a fix. Two live runs lost Tickets to
 * `ModuleNotFoundError` that way — and in one of them the Step was refused permission to write the
 * very file Runtime had not written either.
 */
describe('python test bootstrap', () => {
  let root = '';
  const audit = { event: async () => undefined } as never;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-bootstrap-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates conftest.py with the sys.path entries a test needs', async () => {
    await getLanguageProfile('python').ensureTestBootstrap?.(new Workspace(root), audit);
    const written = await fs.readFile(path.join(root, 'tests/conftest.py'), 'utf8');
    // Both roots: `from models import X` and `from src.models import X` must resolve.
    expect(written).toContain('sys.path');
    expect(written).toContain("'src'");
  });

  it('leaves an existing conftest.py alone, so a Step\'s own fixtures survive', async () => {
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    const mine = '# written by the Step\nimport pytest\n';
    await fs.writeFile(path.join(root, 'tests/conftest.py'), mine);
    await getLanguageProfile('python').ensureTestBootstrap?.(new Workspace(root), audit);
    expect(await fs.readFile(path.join(root, 'tests/conftest.py'), 'utf8')).toBe(mine);
  });

  // TypeScript resolves imports through its own config, so it declares no bootstrap and the optional
  // call must stay a no-op rather than inventing a file.
  it('writes nothing for TypeScript', async () => {
    await getLanguageProfile('typescript').ensureTestBootstrap?.(new Workspace(root), audit);
    await expect(fs.access(path.join(root, 'tests/conftest.py'))).rejects.toThrow();
  });
});
