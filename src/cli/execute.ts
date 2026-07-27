import {
  runExecute as runRuntimeExecute,
  type ExecuteOptions as RuntimeExecuteOptions,
  type ExecuteResult,
} from '../runtime/run.js';
import { createCliRuntimeIO } from './runtime_adapter.js';

export interface ExecuteOptions extends RuntimeExecuteOptions {
  /** CLI-only exit-code adapter switch; Runtime never mutates the host process. */
  setProcessExitCode?: boolean;
}

export type { ExecuteResult };

/** CLI adapter for the XCompiler run Runtime entrypoint. */
export async function runExecute(opts: ExecuteOptions): Promise<ExecuteResult> {
  const { setProcessExitCode, ...runtimeOptions } = opts;
  const result = await runRuntimeExecute({
    ...runtimeOptions,
    io: opts.io ?? createCliRuntimeIO(),
  });
  if (setProcessExitCode !== false) {
    const exitCode = exitCodeForExecuteResult(result);
    if (exitCode !== 0) process.exitCode = exitCode;
  }
  return result;
}

function exitCodeForExecuteResult(result: ExecuteResult): number {
  if (typeof result.exitCode === 'number') return result.exitCode;
  if (result.status === 'ok' || result.status === 'dry-run') return 0;
  return result.status === 'failed' ? 4 : 5;
}
