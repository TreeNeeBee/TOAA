import path from 'node:path';
import type { XCompilerConfig } from '../config/config.js';
import { RecordReplayController } from '../application/record_replay/controller.js';
import { FileRecordReplayStore } from '../infrastructure/record_replay/file_store.js';
import type { Workspace } from '../workspace/workspace.js';
import type { RecordReplayMode } from '../application/record_replay/types.js';

export interface RuntimeRecordReplayOptions {
  mode?: RecordReplayMode;
  path?: string;
}

export function createRuntimeRecordReplay(
  config: XCompilerConfig,
  workspace: Workspace,
  overrides: RuntimeRecordReplayOptions = {},
): RecordReplayController {
  const root = resolveRuntimeRecordReplayRoot(config, workspace.root, overrides.path);
  return new RecordReplayController({
    mode: overrides.mode ?? config.record_replay.mode,
    store: new FileRecordReplayStore(root),
    enabledChannels: config.record_replay.channels,
    redactedFields: config.record_replay.redacted_fields,
  });
}

export function resolveRuntimeRecordReplayRoot(
  config: XCompilerConfig,
  workspace: string,
  overridePath?: string,
): string {
  const root = path.resolve(workspace, overridePath ?? config.record_replay.path);
  const relative = path.relative(workspace, root);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('record_replay.path must stay inside the current project workspace');
  }
  return root;
}
