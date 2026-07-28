import path from 'node:path';
import type { GitService } from '../../workspace/git.js';
import type { Workspace } from '../../workspace/workspace.js';
import type { Step } from '../plan.js';
import type { BugTicket } from '../ticket.js';
import {
  hasSuccessfulRepairMutation,
  hasSuccessfulVerificationEvidence,
  inferRepairMode,
  parsePatchChangedFiles,
} from './attempt_policy.js';
import {
  isRuntimeOnlyChange,
  normalizeGitPath,
} from './v_model_policy.js';

type RepairToolCall = {
  tool: string;
  ok: boolean;
  summary?: string;
  error?: string;
};

export class RepairArtifactService {
  constructor(
    private readonly workspace: Workspace,
    private readonly git: GitService,
    private readonly planPath: string,
  ) {}

  async create(
    ticketId: string,
    step: Step,
    beforeRef: string,
    completedBeforeDebug: boolean,
    toolCalls: RepairToolCall[],
  ): Promise<BugTicket['repair'] | undefined> {
    if (!completedBeforeDebug) return undefined;
    const patchPath = `.xcompiler/tickets/${ticketId}/repair.patch`;
    const summaryPath = `.xcompiler/tickets/${ticketId}/repair.md`;
    const diff = await this.git.raw().diff([beforeRef, '--'])
      .catch((error) => `# git diff failed: ${(error as Error).message}\n`);
    const mode = inferRepairMode(toolCalls);
    const changedFiles = parsePatchChangedFiles(diff);
    await this.workspace.writeFile(
      patchPath,
      diff || '# No textual diff captured.\n',
    );
    await this.workspace.writeFile(
      summaryPath,
      [
        `# Repair ${ticketId}`,
        '',
        `- repairedStep: ${step.id}`,
        `- repairedPhase: ${step.phase}`,
        `- mode: ${mode}`,
        `- completedBeforeDebug: ${completedBeforeDebug}`,
        '',
        '## Tool Calls',
        ...toolCalls.map(
          (call) =>
            `- ${call.tool}: ${call.ok ? 'OK' : 'FAIL'} ${call.summary ?? call.error ?? ''}`,
        ),
        '',
        `Patch: ${patchPath}`,
      ].join('\n') + '\n',
    );
    return {
      repairedStepId: step.id,
      repairedPhase: step.phase,
      completedBeforeDebug,
      mode,
      patchPath,
      summaryPath,
      changedFiles,
    };
  }

  async violation(toolCalls: RepairToolCall[]): Promise<string | undefined> {
    const hasMutation = hasSuccessfulRepairMutation(toolCalls);
    const hasVerification = hasSuccessfulVerificationEvidence(toolCalls);
    if (!hasMutation && !hasVerification) {
      return 'completed phase debug finished without a successful repair mutation or verification tool call';
    }
    if (!hasMutation && hasVerification) return undefined;
    const changedFiles = await this.changedFiles();
    if (changedFiles.length === 0) {
      return hasVerification
        ? undefined
        : 'completed phase debug finished without a non-runtime workspace diff';
    }
    return undefined;
  }

  private async changedFiles(): Promise<string[]> {
    const planPath = normalizeGitPath(
      path.relative(this.workspace.root, path.resolve(this.planPath)),
    );
    const status = await this.git.raw().status();
    return status.files
      .map((file) => normalizeGitPath(file.path))
      .filter((file) => file.length > 0)
      .filter((file) => !isRuntimeOnlyChange(file, planPath));
  }
}
