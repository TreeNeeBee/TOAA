import type { ExecResult } from '../sandbox/types.js';

export interface NetworkApiFailure {
  message: string;
  evidence: string;
}

const FAILURE_LINE_RE =
  /\b(?:network|api|http|https|request|requests|fetch|connection|dns|ssl|tls|socket|timed out|status code|client error|server error)\b.*\b(?:fail(?:ed|ure)?|error|timed out|timeout(?:\s+(?:exceeded|after|while|connecting|reading))|refused|reset|unreachable|unavailable|forbidden|unauthorized|not found|too many requests|bad gateway|service unavailable)\b|\b(?:fail(?:ed|ure)?|error|timed out|timeout(?:\s+(?:exceeded|after|while|connecting|reading))|refused|reset|unreachable|unavailable)\b.*\b(?:network|api|http|https|request|requests|fetch|connection|dns|ssl|tls|socket)\b|(?:网络|接口|API|HTTP|请求|连接|超时|限流|不可用)[^\n]{0,80}(?:失败|错误|异常|超时|拒绝|不可达|不可用|限流)|(?:失败|错误|异常|超时|拒绝|不可达|不可用|限流)[^\n]{0,80}(?:网络|接口|API|HTTP|请求|连接|服务)/iu;

const EXCEPTION_RE =
  /\b(?:ConnectionError|Timeout|ReadTimeout|ConnectTimeout|HTTPError|SSLError|ProxyError|TooManyRedirects|MaxRetryError|NameResolutionError|gaierror|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)\b/u;

const HTTP_STATUS_RE = /\b(?:HTTP\s*)?(?:status(?:\s*code)?\s*[=:]?\s*)?(?:401|403|404|408|409|425|429|5\d\d)\b[^\n]{0,80}\b(?:api|http|request|fetch|接口|请求)\b|\b(?:api|http|request|fetch|接口|请求)\b[^\n]{0,80}\b(?:401|403|404|408|409|425|429|5\d\d)\b/iu;

export function detectNetworkApiFailure(text: string): NetworkApiFailure | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const hasTestAssertionContext = lines.some((rawLine) => {
    const line = rawLine.trim();
    return isTestRunnerStatusLine(line) ||
      isTestAssertionDiagnosticLine(line) ||
      /^(?:[-+]\s*)?(?:expected|received)[:\s]/iu.test(line);
  });
  let inCapturedTestOutput = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      inCapturedTestOutput = false;
      continue;
    }
    // Vitest labels stdout/stderr emitted by a test with this prefix. Such output
    // often contains the error a test is deliberately exercising, not a runner failure.
    if (/^(?:stdout|stderr)\s*\|\s+/iu.test(line)) {
      inCapturedTestOutput = true;
      continue;
    }
    if (inCapturedTestOutput) continue;
    if (isTestRunnerStatusLine(line)) continue;
    if (isTestAssertionDiagnosticLine(line)) continue;
    if (hasTestAssertionContext && isTestAssertionDiffPayloadLine(line)) continue;
    if (isToolTaggedDiagnosticLine(line)) continue;
    if (isAmbiguousApplicationFetchFailure(line)) continue;
    if (isLoopbackNetworkFailureLine(line)) continue;
    const scannable = withoutDocumentationUrls(line);
    if (FAILURE_LINE_RE.test(scannable) || EXCEPTION_RE.test(scannable) || HTTP_STATUS_RE.test(scannable)) {
      return {
        message:
          'Network API failure detected. Treat this task as failed and preserve the evidence for LLM classification as an implementation Bug or accepted-contract Change Request.',
        evidence: line.slice(0, 500),
      };
    }
  }
  return null;
}

/**
 * A diff marker is presentation, not evidence that the rendered value occurred at runtime.
 * Require assertion context at the call site: standalone `+`/`-` application output must remain
 * observable by the network gate.
 */
function isTestAssertionDiffPayloadLine(line: string): boolean {
  return /^[+-]\s+\S/u.test(line);
}

export function isLoopbackNetworkFailureLine(line: string): boolean {
  const hasLoopbackTarget = /(?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(?::\d+)?\b/iu.test(line);
  if (!hasLoopbackTarget) return false;
  return FAILURE_LINE_RE.test(line) || EXCEPTION_RE.test(line) || HTTP_STATUS_RE.test(line);
}

function isAmbiguousApplicationFetchFailure(line: string): boolean {
  if (!/\b(?:fetch(?:ing)?\s+failed|failed\s+to\s+fetch|fetch\s+failure)\b/iu.test(line)) {
    return false;
  }
  return /\b(?:is not a function|is not iterable|cannot read propert(?:y|ies)|undefined|null)\b/iu.test(line);
}

export function isTestAssertionDiagnosticLine(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (/^\d+\|\s/u.test(text)) return true;
  if (/^(?:[→>-]\s*)?expected\b/iu.test(text)) return true;
  if (/\bAssertionError\b/iu.test(text) && /\bexpected\b/iu.test(text)) return true;
  if (/\bexpect\s*\(/u.test(text) && /\.(?:to|not)\w*\s*\(/u.test(text)) return true;
  return /\bexpected\b[\s\S]{0,240}\b(?:got|received|to\s+(?:be|equal|throw|contain|have|match))\b/iu.test(text);
}

// A test runner tags its own complaints about the workspace -- a hoisted mock
// factory, an unreadable config -- with its bracketed name. These describe what
// the runner refused to do, never a call the product under test made.
function isToolTaggedDiagnosticLine(line: string): boolean {
  return /\[(?:vitest|vite|jest|tsx|esbuild|rollup|webpack|eslint)\]/iu.test(line);
}

// Diagnostics routinely close with a pointer to their own documentation, and
// those addresses carry the very words this gate scans for ("/api/", "https").
// The product never called them, so they must not stand as evidence.
const DOCUMENTATION_URL_RE =
  /(?:\b(?:read\s+more|see(?:\s+also)?|more\s+info(?:rmation)?|docs?|documentation)\b|\u8be6\u89c1|\u53c2\u89c1|\u53c2\u8003)[:\uff1a]?\s*<?https?:\/\/\S+/giu;

function withoutDocumentationUrls(line: string): string {
  return line.replace(DOCUMENTATION_URL_RE, ' ');
}

function isTestRunnerStatusLine(line: string): boolean {
  if (/^[✓✔]\s/u.test(line) || /\bPASSED\b/u.test(line) || /\bPASS\b\s+[\w./:-]+/u.test(line)) {
    return true;
  }
  return /^(?:FAIL|FAILED|×|✕|✖)\s+[\w./:-]+(?:\s*::|\s+>|\s+\(|\s*$)/u.test(line) ||
    /^❯\s+[\w./:-]+(?:\s*::|\s+>|\s+\(|\s*$)/u.test(line);
}

export function detectNetworkApiFailureInExec(result: ExecResult): NetworkApiFailure | null {
  return detectNetworkApiFailure(`${result.stderr ?? ''}\n${result.stdout ?? ''}`);
}
