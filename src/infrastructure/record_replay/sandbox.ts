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
    private readonly controller: RecordReplayController,
  ) {
    this.kind = delegate.kind;
  }

  build(manifestFile?: string, options?: SandboxBuildOptions): Promise<{ rebuilt: boolean; reason: string }> {
    return this.controller.execute({
      channel: 'subprocess',
      operation: 'sandbox.build',
      request: { sandbox: this.kind, manifestFile, options },
    }, () => this.delegate.build(manifestFile, options));
  }

  exec(cmd: string, argv: string[], extra?: ExecExtra): Promise<ExecResult> {
    return this.controller.execute({
      channel: 'subprocess',
      operation: 'sandbox.exec',
      request: { sandbox: this.kind, cmd, argv, extra: safeExtra(extra) },
    }, () => this.delegate.exec(cmd, argv, extra));
  }

  runProgram(args: string[], extra?: ExecExtra): Promise<ExecResult> {
    return this.controller.execute({
      channel: 'subprocess',
      operation: 'sandbox.run_program',
      request: { sandbox: this.kind, args, extra: safeExtra(extra) },
    }, () => this.delegate.runProgram(args, extra));
  }

  runTests(args?: string[], extra?: ExecExtra): Promise<ExecResult> {
    return this.controller.execute({
      channel: 'subprocess',
      operation: 'sandbox.run_tests',
      request: { sandbox: this.kind, args: args ?? [], extra: safeExtra(extra) },
    }, () => this.delegate.runTests(args, extra));
  }

  installDeps(packages: string[]): Promise<ExecResult> {
    return this.controller.execute({
      channel: 'subprocess',
      operation: 'sandbox.install_dependencies',
      request: { sandbox: this.kind, packages },
    }, () => this.delegate.installDeps(packages));
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

function safeExtra(extra: ExecExtra | undefined): Omit<ExecExtra, 'env'> & { envKeys?: string[] } | undefined {
  if (!extra) return undefined;
  const { env, ...rest } = extra;
  return {
    ...rest,
    envKeys: env ? Object.keys(env).sort() : undefined,
  };
}
