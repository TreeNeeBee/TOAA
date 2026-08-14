export interface TypeScriptProgramCommand {
  cmd: string;
  argv: string[];
  display: string;
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
