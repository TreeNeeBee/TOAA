import path from 'node:path';
import { FixtureService, type FixtureInspectionReport } from '../application/record_replay/fixture_service.js';
import { loadConfigWithPath } from '../config/config.js';
import { FileRecordReplayStore } from '../infrastructure/record_replay/file_store.js';
import type { RuntimeIO } from './io.js';
import { runRunCommand, type RuntimeRunCommandOptions } from './commands.js';
import { resolveRuntimeRecordReplayRoot } from './record_replay.js';

export type FixtureAction = 'prepare' | 'inspect' | 'verify' | 'refresh';

export interface RuntimeFixtureOptions {
  action: FixtureAction;
  workspace: string;
  configPath?: string;
  path?: string;
  planArg?: string;
  force?: boolean;
  io?: RuntimeIO;
}

export interface RuntimeFixtureResult {
  action: FixtureAction;
  fixturePath: string;
  inspection?: FixtureInspectionReport;
  execution?: Awaited<ReturnType<typeof runRunCommand>>;
}

export async function runFixtureCommand(options: RuntimeFixtureOptions): Promise<RuntimeFixtureResult> {
  const workspace = path.resolve(options.workspace);
  const { config } = await loadConfigWithPath(options.configPath);
  const fixturePath = resolveRuntimeRecordReplayRoot(config, workspace, options.path);
  if (options.action === 'prepare' || options.action === 'refresh') {
    const executionOptions: RuntimeRunCommandOptions = {
      workspace,
      planArg: options.planArg,
      configPath: options.configPath,
      force: options.force,
      recordReplayMode: options.action === 'prepare' ? 'record' : 'refresh',
      recordReplayPath: options.path,
      io: options.io,
    };
    return {
      action: options.action,
      fixturePath,
      execution: await runRunCommand(executionOptions),
    };
  }
  const fixtures = new FixtureService(new FileRecordReplayStore(fixturePath));
  const inspection = options.action === 'verify'
    ? await fixtures.verify()
    : await fixtures.inspect();
  return { action: options.action, fixturePath, inspection };
}
