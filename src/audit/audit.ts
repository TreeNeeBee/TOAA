import { promises as fs, appendFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { t } from '../i18n/index.js';
import { xcEnv } from '../config/env.js';
import { rebuildAuditSummary } from './summary.js';

/**
 * AuditLogger 把开发流水线中的所有交互/执行动作记录到两份产物：
 *
 *  - `<stateRoot>/audit/process_log.md` —— 完整的人类可读过程记录。
 *  - `<stateRoot>/audit/audit.jsonl` —— 机器可读的逐行 JSON，原始审计真源。
 *  - `<stateRoot>/audit/summary.md` —— 可从 JSONL 重建的轻量索引。
 *
 * 设计原则：
 *  - 追加写入，永不删除。
 *  - 失败时不影响主流程（写盘异常仅打印 warning）。
 *  - 每条事件都带 ts / kind / payload。
 */
export type AuditKind =
  | 'session.start'
  | 'session.end'
  | 'user.input'
  | 'user.decision'
  | 'llm.request'
  | 'llm.response'
  | 'llm.error'
  | 'llm.score'
  | 'fs.write'
  | 'plan.persist'
  | 'topic.persist'
  | 'phase.start'
  | 'phase.end'
  | 'tool.call'
  | 'tool.result'
  | 'sandbox.exec'
  | 'executor.turn'
  | 'planner.thought'
  | 'conftest.autogen'
  | 'ticket.bug.created'
  | 'ticket.bug.routed'
  | 'ticket.bug.closed'
  | 'ticket.enhancement.created'
  | 'ticket.enhancement.closed'
  | 'ticket.change-request.created'
  | 'ticket.change-request.revised'
  | 'ticket.change-request.closed'
  | 'quality.gate.passed'
  | 'quality.gate.enhancement'
  | 'quality.gate.bug'
  | 'phase.delivery_gate'
  | 'project.report.generated'
  | 'note';

export interface AuditEvent {
  ts: string;
  kind: AuditKind;
  message: string;
  messageId?: string;
  data?: Record<string, unknown>;
}

export interface AuditLoggerOptions {
  /** Fallback audit root for standalone callers. Runtime supplies stateRoot explicitly. */
  root: string;
  /** 容器状态根（绝对路径）；结构化审计属于项目状态，不进 Git；独立调用默认使用 root。 */
  stateRoot?: string;
  /** 命令名，例如 `xcompiler_build` / `xcompiler_run` */
  command: string;
  /** 详细 markdown 文件相对 stateRoot 的路径，默认 audit/process_log.md。 */
  mdRelPath?: string;
  /** jsonl 相对 stateRoot 的路径，默认 audit/audit.jsonl。 */
  jsonlRelPath?: string;
  /** full=完整内容；redacted=保留内容但遮蔽凭据（默认）。原始审计不支持省略正文。 */
  contentMode?: AuditContentMode;
  /** 摘要相对 stateRoot 的路径，默认 audit/summary.md。 */
  summaryRelPath?: string;
}

export type AuditContentMode = 'full' | 'redacted';

export class AuditLogger {
  private readonly mdAbs: string;
  private readonly jsonlAbs: string;
  private readonly command: string;
  private readonly contentMode: AuditContentMode;
  private readonly summaryAbs: string;
  private startTs = '';
  /** 串行化 markdown 追加，防止并发 appendFile 交错。 */
  private mdQueue: Promise<void> = Promise.resolve();

  constructor(opts: AuditLoggerOptions) {
    this.command = opts.command;
    this.contentMode = resolveContentMode(
      opts.contentMode ?? xcEnv('AUDIT_CONTENT_MODE'),
    );
    const auditRoot = opts.stateRoot ?? opts.root;
    this.mdAbs = path.resolve(auditRoot, opts.mdRelPath ?? 'audit/process_log.md');
    this.jsonlAbs = path.resolve(auditRoot, opts.jsonlRelPath ?? 'audit/audit.jsonl');
    this.summaryAbs = path.resolve(auditRoot, opts.summaryRelPath ?? 'audit/summary.md');
  }

  async start(meta: Record<string, unknown> = {}): Promise<void> {
    this.startTs = new Date().toISOString();
    await this.ensureFiles();
    await this.appendMd(
      [
        '',
        t().audit.sessionStart(this.startTs, this.command),
        '',
        '```yaml',
        ...Object.entries(meta).map(([k, v]) => `${k}: ${stringify(v)}`),
        '```',
        '',
      ].join('\n'),
    );
    await this.event('session.start', t().audit.eventSessionStart(this.command), {
      messageId: 'audit.session_start',
      ...meta,
    });
  }

  async end(summary: Record<string, unknown> = {}): Promise<void> {
    await this.event('session.end', t().audit.eventSessionEnd(this.command), {
      messageId: 'audit.session_end',
      ...summary,
    });
    await this.appendMd(
      [
        '',
        t().audit.sessionEnd(new Date().toISOString()),
        '',
        '```yaml',
        ...Object.entries(summary).map(([k, v]) => `${k}: ${stringify(v)}`),
        '```',
        '',
        '---',
        '',
      ].join('\n'),
    );
    try {
      await rebuildAuditSummary(this.jsonlAbs, this.summaryAbs);
    } catch (error) {
      console.warn(`Failed to rebuild audit summary: ${(error as Error).message}`);
    }
  }

  /** Stable location for detailed runtime evidence outside the generated product tree. */
  artifactPath(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new Error('Audit artifact path must be a non-empty relative path');
    }
    const normalized = path.normalize(relativePath);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      throw new Error('Audit artifact path cannot leave the audit directory');
    }
    return path.resolve(path.dirname(this.jsonlAbs), 'artifacts', normalized);
  }

  /** 通用事件，jsonl + 简短 markdown 一行。 */
  async event(kind: AuditKind, message: string, data?: Record<string, unknown>): Promise<void> {
    await this.ensureFiles();
    const protectedMessage = protectAuditContent(message, this.contentMode);
    const ev: AuditEvent = {
      ts: new Date().toISOString(),
      kind,
      message: typeof protectedMessage === 'string' ? protectedMessage : String(protectedMessage),
    };
    if (data) {
      const { messageId, ...payload } = data;
      if (typeof messageId === 'string') ev.messageId = messageId;
      if (Object.keys(payload).length > 0) {
        ev.data = protectAuditContent(payload, this.contentMode) as Record<string, unknown>;
      }
    }
    await this.appendJsonl(ev);
    await this.appendMd([
      `- \`${ev.ts}\` **${kind}** — ${escapeMd(ev.message)}`,
      ...(ev.data
        ? ['', '<details><summary>Event data</summary>', '', '```json', safeStringify(ev.data), '```', '', '</details>']
        : []),
      '',
    ].join('\n'));
  }

  /** 用户输入 / 决策。会把内容以引用块写入 markdown。 */
  async userInput(label: string, content: string): Promise<void> {
    const storedContent = protectAuditContent(content, this.contentMode);
    await this.appendJsonl({
      ts: new Date().toISOString(),
      kind: 'user.input',
      message: label,
      messageId: 'audit.user_input',
      data: { content: storedContent, contentMode: this.contentMode },
    });
    await this.appendMd(
      [
        '',
        t().audit.userInput(escapeMd(label)),
        '',
        '```text',
        renderAuditContent(storedContent),
        '```',
        '',
      ].join('\n'),
    );
  }

  async userDecision(label: string, value: string): Promise<void> {
    await this.event('user.decision', t().audit.userDecision(label, value), {
      messageId: 'audit.user_decision', label, value,
    });
  }

  /** LLM 请求/响应：完整 prompt 与回包写入 markdown 折叠块。 */
  async llmRequest(role: string, model: string, messages: unknown, options?: unknown): Promise<void> {
    const storedMessages = protectAuditContent(messages, this.contentMode);
    const storedOptions = protectAuditContent(options, this.contentMode);
    await this.appendJsonl({
      ts: new Date().toISOString(),
      kind: 'llm.request',
      message: t().audit.eventLlmRequest(role, model),
      messageId: 'audit.llm_request',
      data: { role, model, messages: storedMessages, options: storedOptions, contentMode: this.contentMode },
    });
    await this.appendMd(
      [
        '',
        `<details><summary>${t().audit.llmRequest(escapeMd(role), escapeMd(model))}</summary>`,
        '',
        '```json',
        safeStringify({ messages: storedMessages, options: storedOptions }),
        '```',
        '',
        '</details>',
        '',
      ].join('\n'),
    );
  }

  async llmResponse(role: string, model: string, content: string, meta?: Record<string, unknown>): Promise<void> {
    const storedContent = protectAuditContent(content, this.contentMode);
    const storedMeta = protectAuditContent(meta, this.contentMode) as Record<string, unknown> | undefined;
    await this.appendJsonl({
      ts: new Date().toISOString(),
      kind: 'llm.response',
      message: t().audit.eventLlmResponse(role, model),
      messageId: 'audit.llm_response',
      data: { ...storedMeta, role, model, content: storedContent, contentMode: this.contentMode },
    });
    await this.appendMd(
      [
        '',
        `<details><summary>${t().audit.llmResponse(escapeMd(role), escapeMd(model))}</summary>`,
        '',
        '```text',
        renderAuditContent(storedContent),
        '```',
        '',
        '</details>',
        '',
      ].join('\n'),
    );
  }

  async llmError(role: string, model: string, err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    await this.event('llm.error', t().audit.eventLlmError(role, model, msg), {
      messageId: 'audit.llm_error', role, model, error: msg,
    });
  }

  /**
   * 记录一轮 Executor 执行摘要：简短 intent、Bug Ticket 处理方案、计划调用的 actions、是否完成。
   * 写入 jsonl + markdown 折叠块，交付时可追溯每轮决策和动作。
   */
  async executorTurn(
    stepId: string,
    role: string,
    round: number,
    payload: {
      thoughts?: string;
      bugResolutionPlan?: string;
      actions?: unknown[];
      done?: boolean;
      raw?: string;
      provider?: string;
    },
  ): Promise<void> {
    const storedPayload = protectAuditContent(payload, this.contentMode) as Record<string, unknown>;
    await this.appendJsonl({
      ts: new Date().toISOString(),
      kind: 'executor.turn',
      message: t().audit.eventExecutorTurn(stepId, round, role, payload.provider ?? ''),
      messageId: 'audit.executor_turn',
      data: { ...storedPayload, role, contentMode: this.contentMode },
    });
    const summary = (payload.thoughts ?? '').trim() || t().audit.noThoughts;
    const actCount = Array.isArray(payload.actions) ? payload.actions.length : 0;
    await this.appendMd(
      [
        '',
        `<details><summary>${t().audit.executorTurn(escapeMd(stepId), round, escapeMd(role), escapeMd(payload.provider ?? ''), actCount, payload.done === true)}</summary>`,
        '',
        t().audit.thoughtsLabel,
        '',
        '> ' + escapeMd(summary).replace(/\n/g, '\n> '),
        '',
        ...(actCount > 0
          ? [t().audit.actionsLabel, '', '```json', safeStringify(protectAuditContent(payload.actions, this.contentMode)), '```', '']
          : []),
        '</details>',
        '',
      ].join('\n'),
    );
  }

  /** 记录 Planner 的思考阶段，比如 clarify / decompose 原始输出。 */
  async plannerThought(
    stage: string,
    content: string,
    meta?: Record<string, unknown> & { provider?: string },
  ): Promise<void> {
    const provider = meta?.provider;
    const storedContent = protectAuditContent(content, this.contentMode);
    const storedMeta = protectAuditContent(meta, this.contentMode) as Record<string, unknown> | undefined;
    await this.appendJsonl({
      ts: new Date().toISOString(),
      kind: 'planner.thought',
      message: t().audit.eventPlannerThought(stage, provider ?? ''),
      messageId: 'audit.planner_thought',
      data: { ...storedMeta, stage, content: storedContent, contentMode: this.contentMode },
    });
    await this.appendMd(
      [
        '',
        `<details><summary>${t().audit.plannerThought(escapeMd(stage), escapeMd(provider ?? ''))}</summary>`,
        '',
        '```text',
        renderAuditContent(storedContent),
        '```',
        '',
        '</details>',
        '',
      ].join('\n'),
    );
  }

  // ---------- 内部 ----------
  private async ensureFiles(): Promise<void> {
    // 同步建目录 + 初始化 md 头：保证 appendFileSync 可用，且不与并发 ensureFiles 竞争。
    const mdDir = path.dirname(this.mdAbs);
    const jlDir = path.dirname(this.jsonlAbs);
    if (!existsSync(mdDir)) mkdirSync(mdDir, { recursive: true });
    if (!existsSync(jlDir)) mkdirSync(jlDir, { recursive: true });
    if (!existsSync(this.mdAbs)) {
      writeFileSync(
        this.mdAbs,
        `${t().audit.processLogTitle}\n\n${t().audit.processLogPreamble}\n`,
        'utf8',
      );
    }
  }

  private async appendMd(text: string): Promise<void> {
    // 通过 promise 队列串行化，避免并发 appendFile 交错；失败仅 warn。
    this.mdQueue = this.mdQueue.then(
      () => fs.appendFile(this.mdAbs, text, 'utf8'),
      () => fs.appendFile(this.mdAbs, text, 'utf8'),
    ).catch((err) => {
      console.warn(t().audit.markdownAppendFailed((err as Error).message));
    });
    return this.mdQueue;
  }

  private async appendJsonl(ev: AuditEvent): Promise<void> {
    // 同步追加：jsonl 是关键审计流，必须保证进程异常/退出时也已落盘。
    // 即使在事件循环被长 LLM 调用占用、或 await 链被 unhandled rejection 截断时，
    // 同步 IO 也能保证字节落到磁盘，杜绝 "S007 整段事件丢失" 类问题。
    try {
      appendFileSync(this.jsonlAbs, JSON.stringify(ev) + '\n', 'utf8');
    } catch (err) {
      console.warn(t().audit.jsonlAppendFailed((err as Error).message));
    }
    // 可选 stderr 镜像（XC_AUDIT_TRACE=1）：如果文件被外部覆盖丢失，
    // 还能从终端输出交叉验证实际发生了哪些事件。
    if (xcEnv('AUDIT_TRACE') === '1') {
      try {
        process.stderr.write(t().audit.traceLine(ev.kind, ev.message) + '\n');
      } catch {
        /* ignore */
      }
    }
  }
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function resolveContentMode(value: string | undefined): AuditContentMode {
  return value === 'full' || value === 'redacted' ? value : 'redacted';
}

function protectAuditContent(value: unknown, mode: AuditContentMode): unknown {
  if (mode === 'full') return value;
  return redactValue(value);
}

function renderAuditContent(value: unknown): string {
  return typeof value === 'string' ? value : safeStringify(value);
}

function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key)
      ? '[REDACTED]'
      : redactValue(item, seen);
  }
  return output;
}

const SENSITIVE_KEYS = new Set([
  'apikey', 'authorization', 'password', 'passwd', 'secret',
  'accesstoken', 'refreshtoken', 'authtoken', 'cookie',
]);

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-_]/gu, '').toLowerCase();
  return SENSITIVE_KEYS.has(normalized);
}

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, 'sk-[REDACTED]')
    .replace(/((?:api[-_]?key|authorization|password|passwd|secret|token)\s*[:=]\s*)[^\s,;]+/giu, '$1[REDACTED]');
}
