export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface LLMProviderWindow {
  contextWindowTokens: number;
  switched: boolean;
}

export interface ChatOptions {
  /** Cancels an in-flight provider request when the owning Runtime task is cancelled. */
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  /**
   * Caps this one request's total budget, below whatever the provider is configured for.
   *
   * Exists for the non-streaming retry after a stream stalled. That path has no idle or first-token
   * watchdog — a non-stream response sends nothing until it is whole — so it runs to the full
   * `request_timeout_ms`. Handing a recovery attempt the same budget as a fresh request doubles the
   * cost of one stall: a live Planner spent fifteen minutes there after its stream went idle at
   * sixty seconds.
   */
  requestTimeoutMs?: number;
  /** Force JSON-only response if provider supports it. */
  responseFormat?: 'text' | 'json';
  /**
   * 流式 token 回调。设置后 provider 会以增量方式推送 token；
   * provider 仍会聚合并返回完整文本作为最终结果。
   */
  onToken?: (chunk: string) => void;
  /**
   * 流式模式下的“可提前结束”判定。用于兼容一些 provider：
   * 输出内容本身已经完整，但既不及时发送 [DONE]，也不主动断开连接。
   * 返回 true 后 provider 应尽快结束本次流读取并返回当前 aggregate。
   */
  streamStopWhen?: (text: string) => boolean;
  /**
   * 可选输出契约验证钩子：provider 返回后调用。抛出的原始异常会立即
   * 返回调用方，由拥有该契约的工作流携带精确反馈重试；不会以未变更的
   * prompt 静默切换 provider。适用于 JSON 结构、计划契约和修复动作校验。
   */
  validate?: (text: string) => void;
  /**
   * Whether a provider response should increase its dynamic score.
   * Step/workflow executors should disable this and score quality through
   * final Enhance/Bug/CR outcomes instead of treating "returned text" as task success.
   */
  scoreSuccess?: boolean;
  /**
   * 调用者可传入回调，与 LLM 输出一同拿到实际产出该响应的 provider 名。
   * 主要用于追溯：在 FallbackClient 中服务于响应的是链中某一个后选 provider，
   * 调用者（如 Executor）需要在审计 / Markdown 记录中为响应打上正确的“via 哪个模型”标签。
   */
  onProvider?: (name: string) => void;
  /**
   * 每次开始尝试候选 provider 时触发。用于 CLI 在等待首个 token 前显示
   * 当前 provider 与模型；fallback 切换时会再次触发。
   */
  onProviderStart?: (name: string, model: string, window: LLMProviderWindow) => void;
  /**
   * Called once when no bytes at all have arrived from the provider for `stallDiagnosisAfterMs`.
   *
   * The transport is the only layer that can see the silence, and it must not be the layer that
   * explains it — diagnosing means probing endpoints and reading config, which belongs to the
   * caller. Whatever this returns is attached to the failure if the request goes on to fail, so a
   * request that recovers reports nothing.
   *
   * Diagnostic only. A healthy verdict must never be read as permission to keep waiting: the probe
   * opens a new connection, and a new connection can succeed while the one this request is blocked
   * on stays black-holed.
   */
  onStall?: (info: { silentForMs: number; provider?: string; model?: string }) => Promise<string | undefined>;
}

export interface LLMClient {
  readonly name: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}
