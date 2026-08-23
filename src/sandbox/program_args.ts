export interface TypeScriptProgramCommand {
  cmd: string;
  argv: string[];
  display: string;
}

/**
 * Drops an interpreter the caller repeated in front of its own arguments.
 *
 * `run_program` supplies the venv interpreter itself, so `["python", "-m", "py_compile", f]` becomes
 * `python python -m py_compile f` and the runner reports that it cannot open a file named `python`.
 * The TypeScript side already normalises `npm|npx|node|tsx|tsc` prefixes and its tool description
 * advertises them, so a model that learned the shape there applies it here and is punished for the
 * asymmetry rather than for a mistake.
 *
 * The cost is not one wasted round. In a live run the model diagnosed the duplication correctly and
 * then filed it as a *contract change*: CR-CR-001 named five artifacts, the Step it reached owned
 * none of them and filed CR-CR-002, which reached a third role and produced CR-CR-003. A tool-level
 * ambiguity became three Change Requests across three roles.
 */
export function stripPythonInterpreterPrefix(args: readonly string[]): string[] {
  const [first, ...rest] = args;
  if (first === undefined) return [...args];
  // Only a bare interpreter name, and only when something follows it: `python script.py` is the
  // duplication, while a file that happens to be called `python.py` is an argument.
  if (/^python(?:3(?:\.\d+)?)?$/u.test(first) && rest.length > 0) return rest;
  return [...args];
}

export function resolveTypeScriptProgramCommand(args: string[]): TypeScriptProgramCommand {
  const [first, ...rest] = args;
  if (!first) {
    return { cmd: 'npx', argv: ['tsx'], display: 'npx tsx' };
  }

  if (first === 'npm') {
    return { cmd: 'npm', argv: rest, display: formatCommand('npm', rest) };
  }
  if (first === 'node') {
    return { cmd: 'node', argv: rest, display: formatCommand('node', rest) };
  }
  if (first === 'npx') {
    return { cmd: 'npx', argv: rest, display: formatCommand('npx', rest) };
  }
  if (first === 'tsx') {
    return { cmd: 'npx', argv: ['tsx', ...rest], display: formatCommand('npx', ['tsx', ...rest]) };
  }
  if (first === 'tsc') {
    return { cmd: 'npx', argv: ['tsc', ...rest], display: formatCommand('npx', ['tsc', ...rest]) };
  }
  if (isWorkspaceBinary(first)) {
    return { cmd: first, argv: rest, display: formatCommand(first, rest) };
  }

  return { cmd: 'npx', argv: ['tsx', ...args], display: formatCommand('npx', ['tsx', ...args]) };
}

function isWorkspaceBinary(value: string): boolean {
  return /^(?:\.\/)?node_modules[\\/]\.bin[\\/][^\\/]+$/u.test(value);
}

function formatCommand(cmd: string, argv: string[]): string {
  return [cmd, ...argv].filter(Boolean).join(' ');
}
