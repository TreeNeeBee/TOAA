export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  SessionNotFound: -32001,
  TaskNotFound: -32002,
  PendingRequestNotFound: -32003,
  RuntimeError: -32010,
  CancellationUnsupported: -32020,
} as const;

export const AcpMethod = {
  Initialize: 'initialize',
  Shutdown: 'shutdown',
  SessionNew: 'session/new',
  SessionPrompt: 'session/prompt',
  SessionCancel: 'session/cancel',
  SessionClose: 'session/close',
  SessionSetMode: 'session/set_mode',
  SessionUpdate: 'session/update',
  SessionRequestPermission: 'session/request_permission',
} as const;

export function request(id: JsonRpcId, method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

export function failure(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

export function notification(method: string, params?: unknown): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params };
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  const msg = value as Partial<JsonRpcRequest>;
  return msg?.jsonrpc === '2.0' && typeof msg.method === 'string' && 'id' in msg;
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  const msg = value as Partial<JsonRpcNotification>;
  return msg?.jsonrpc === '2.0' && typeof msg.method === 'string' && !('id' in msg);
}

export function isJsonRpcSuccess(value: unknown): value is JsonRpcSuccess {
  const msg = value as Partial<JsonRpcSuccess>;
  return msg?.jsonrpc === '2.0' && 'id' in msg && 'result' in msg && !('method' in msg);
}

export function isJsonRpcFailure(value: unknown): value is JsonRpcFailure {
  const msg = value as Partial<JsonRpcFailure>;
  return msg?.jsonrpc === '2.0' && 'id' in msg && !!msg.error && !('method' in msg);
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcSuccess | JsonRpcFailure {
  return isJsonRpcSuccess(value) || isJsonRpcFailure(value);
}
