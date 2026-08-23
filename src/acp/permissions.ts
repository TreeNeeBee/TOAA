import type { ToolPermissionRequest } from '../runtime.js';

export interface AcpPermissionChoice {
  approved: boolean;
  reason?: string;
  value?: unknown;
}

export function toAcpPermissionRequestParams(
  sessionId: string,
  requestId: string,
  taskId: string,
  request: ToolPermissionRequest,
): Record<string, unknown> {
  return {
    sessionId,
    toolCall: {
      toolCallId: request.id ?? requestId,
      title: `${request.operationType}: ${request.target}`,
      kind: permissionKind(request.operationType),
      status: 'pending',
      rawInput: {
        operationType: request.operationType,
        target: request.target,
        reason: request.reason,
        risk: request.risk,
        scope: request.scope,
        skippable: request.skippable,
        denyBehavior: request.denyBehavior,
        stepId: request.stepId,
        tool: request.tool,
        metadata: request.metadata,
      },
      content: [{
        type: 'content',
        content: {
          type: 'text',
          text: [
            `Operation: ${request.operationType}`,
            `Target: ${request.target}`,
            `Reason: ${request.reason}`,
            `Risk: ${request.risk}`,
            `Scope: ${request.scope}`,
            `Deny behavior: ${request.denyBehavior}`,
          ].join('\n'),
        },
      }],
      _meta: {
        xcompiler: {
          eventType: 'permission_required',
          taskId,
          requestId,
          operationType: request.operationType,
          target: request.target,
        },
      },
    },
    options: [
      {
        optionId: 'allow_once',
        name: 'Allow once',
        kind: 'allow_once',
      },
      {
        optionId: 'reject_once',
        name: request.skippable ? 'Skip' : 'Reject',
        kind: 'reject_once',
      },
    ],
  };
}

export function toAcpInteractionPermissionParams(input: {
  sessionId: string;
  requestId: string;
  taskId: string;
  kind: string;
  message: string;
  choices?: Array<{ name: string; value: string }>;
  defaultValue?: unknown;
}): Record<string, unknown> {
  const choices = input.choices?.length
    ? input.choices.map((choice) => ({
      optionId: choice.value,
      name: choice.name,
      kind: 'allow_once',
    }))
    : [
      { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ];
  return {
    sessionId: input.sessionId,
    toolCall: {
      toolCallId: input.requestId,
      title: input.message,
      kind: 'think',
      status: 'pending',
      rawInput: {
        interactionKind: input.kind,
        message: input.message,
        choices: input.choices,
        default: input.defaultValue,
      },
      content: [{
        type: 'content',
        content: { type: 'text', text: input.message },
      }],
      _meta: {
        xcompiler: {
          eventType: 'build_confirmation_required',
          taskId: input.taskId,
          requestId: input.requestId,
          interactionKind: input.kind,
        },
      },
    },
    options: choices,
  };
}

export function parsePermissionChoice(result: unknown): AcpPermissionChoice {
  const record = asRecord(result);
  const outcome = asRecord(record.outcome ?? record);
  const optionId = typeof outcome.optionId === 'string'
    ? outcome.optionId
    : typeof record.optionId === 'string'
      ? record.optionId
      : undefined;
  const cancelled = outcome.outcome === 'cancelled' || record.cancelled === true;
  if (cancelled) return { approved: false, reason: 'cancelled' };
  if (!optionId) return { approved: false, reason: 'permission response did not include optionId' };
  return {
    approved: optionId.startsWith('allow') || optionId === 'approve' || optionId === 'approved',
    value: optionId,
  };
}

function permissionKind(operationType: ToolPermissionRequest['operationType']): string {
  if (operationType.includes('file') || operationType.includes('write') || operationType.includes('delete')) return 'edit';
  if (operationType.includes('shell') || operationType.includes('command') || operationType.includes('test')) return 'execute';
  return 'other';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
