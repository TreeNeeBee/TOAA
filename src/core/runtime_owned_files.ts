import type { Language } from './plan.js';

/**
 * The files Runtime writes, and what a Step should do instead of writing them.
 *
 * A refusal that only says "not in your allowlist" leaves a Step nothing to try: the path it was
 * refused is one the tooling itself created, and no amount of guessing reveals that. Three separate
 * live runs lost a Ticket's whole attempt budget to exactly that — the dependency manifest, the
 * pytest bootstrap, and a fabricated assessment field — so the remedy travels with the ownership
 * rather than being remembered at each call site.
 *
 * Declared once because it was previously stated in four places that had already drifted apart:
 * `fs.ts` refused the manifest twice with two different messages, `lint.ts` had a third wording, and
 * `tests/conftest.py` — equally Runtime-owned — had none at all and so fell through to the generic
 * message that says nothing.
 */
export type RuntimeOwnedAccess =
  /** Runtime alone writes it. */
  | 'none'
  /** Runtime seeds it and a Step may add to the end, never rewrite it. */
  | 'append';

export interface RuntimeOwnedFile {
  path: string;
  access: RuntimeOwnedAccess;
  /** Who writes it, and the action that replaces writing it. Both halves, always. */
  remedy: string;
}

/**
 * Whether Runtime owns this path, and on what terms.
 *
 * Language-aware because ownership is: Python's `requirements.txt` is rendered from
 * `plan.dependencies`, while TypeScript's `package.json` is authored by HIGH_LEVEL_DESIGN and is not
 * Runtime's to own. Asking here rather than testing filenames at each call site is what keeps those
 * two facts from being restated differently.
 */
export function runtimeOwnedFile(rel: string, language?: Language): RuntimeOwnedFile | undefined {
  const path = rel.replace(/^\.\//, '');
  if (language !== 'typescript' && isNamed(path, 'requirements.txt')) {
    return {
      path,
      access: 'none',
      remedy:
        'requirements.txt is Runtime-owned: it is seeded from plan.dependencies at run start and ' +
        'maintained by the add_dependency tool. Use add_dependency to add a package.',
    };
  }
  if (language !== 'typescript' && isNamed(path, 'conftest.py')) {
    return {
      path,
      access: 'append',
      remedy:
        'tests/conftest.py is Runtime-owned at the top, where it puts the sys.path bootstrap that ' +
        'lets tests import src/. Use append_file to add shared fixtures below it; do not rewrite ' +
        'the file, which would remove the bootstrap and break every import.',
    };
  }
  return undefined;
}

/**
 * Whether this action is permitted on a Runtime-owned file.
 *
 * `exists` matters because the reason for refusing a rewrite is the content Runtime already put
 * there. An `append`-owned file that is not on disk has no such content, so refusing to create it
 * protects nothing and blocks the only repair available — and the refusal says Runtime "puts the
 * bootstrap at the top", which is false when Runtime has written nothing.
 *
 * A live run spent eight attempts there: `tests/conftest.py` did not exist, its tests could not
 * import `src/`, the Step correctly decided to create it, and was refused each time on the strength
 * of a file that was not there. It read the refusal, checked the directory, found nothing, and tried
 * again — the reasoning was sound and the rule was wrong.
 */
export function runtimeOwnedAllows(
  owned: RuntimeOwnedFile,
  action: 'write' | 'append',
  exists = true,
): boolean {
  if (owned.access !== 'append') return false;
  if (action === 'append') return true;
  return !exists;
}

function isNamed(path: string, name: string): boolean {
  return path === name || path.endsWith(`/${name}`);
}
