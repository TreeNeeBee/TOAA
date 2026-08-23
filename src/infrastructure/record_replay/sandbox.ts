import type { RecordReplayController } from '../../application/record_replay/controller.js';
import type {
  ExecExtra,
  ExecResult,
  Sandbox,
  SandboxBuildOptions,
} from '../../sandbox/types.js';

export class RecordReplaySandbox implements Sandbox {
  readonly kind: Sandbox['kind'];

  constructor(
    private readonly delegate: Sandbox,
    _controller: RecordReplayController,
  ) {
    this.kind = delegate.kind;
  }

  build(manifestFile?: string, options?: SandboxBuildOptions): Promise<{ rebuilt: boolean; reason: string }> {
    // Environment preparation has local side effects. Replaying only its return value leaves a
    // fresh worktree without node_modules/venv while claiming that the sandbox is ready.
    return this.delegate.build(manifestFile, options);
  }

  exec(cmd: string, argv: string[], extra?: ExecExtra): Promise<ExecResult> {
    return this.delegate.exec(cmd, argv, extra);
  }

  runProgram(args: string[], extra?: ExecExtra): Promise<ExecResult> {
    // Product checks must execute against the current tree. A recorded exit code is evidence about
    // an older tree, not verification of the candidate being delivered.
    return this.delegate.runProgram(args, extra);
  }

  runTests(args?: string[], extra?: ExecExtra): Promise<ExecResult> {
    return this.delegate.runTests(args, extra);
  }

  installDeps(packages: string[]): Promise<ExecResult> {
    return this.delegate.installDeps(packages);
  }
}

export function withRecordReplaySandbox(
  sandbox: Sandbox,
  controller: RecordReplayController,
): Sandbox {
  return controller.enabled('subprocess')
    ? new RecordReplaySandbox(sandbox, controller)
    : sandbox;
}
