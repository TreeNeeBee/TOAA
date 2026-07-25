import { describe, it, expect } from 'vitest';
import {
  calibrateDebugSuggestions,
  renderDebugSuggestions,
} from '../src/agents/calibration.js';

describe('calibrateDebugSuggestions', () => {
  it('emits ModuleNotFoundError hint with list_dir / code_search guidance', () => {
    const sugs = calibrateDebugSuggestions(
      `Traceback (most recent call last):\n` +
        `  File "tests/test_foo.py", line 3, in <module>\n` +
        `    from src.dbc_parser import parse_dbc\n` +
        `ModuleNotFoundError: No module named 'src.dbc_parser'`,
      'pytest exit=2',
    );
    const codes = sugs.map((s) => s.code);
    expect(codes).toContain('ModuleNotFoundError');
    const m = sugs.find((s) => s.code === 'ModuleNotFoundError')!;
    expect(m.hint).toMatch(/list_dir/);
    expect(m.hint).toMatch(/code_search/);
    expect(m.hint).toMatch(/add_dependency/);
    expect(m.hint).toMatch(/伪造 module/);
    expect(m.hint).toMatch(/绝不要/); // 拒绝 no-op replace
  });

  it('detects "python tests/X.py" direct-script ModuleNotFoundError and points to pytest / sys.path', () => {
    const log =
      `Traceback (most recent call last):\n` +
      `  File "/tmp/dbc2excel/tests/test_dbc_parser.py", line 5, in <module>\n` +
      `    from dbc_parser import parse_dbc\n` +
      `ModuleNotFoundError: No module named 'dbc_parser'`;
    const sugs = calibrateDebugSuggestions(log);
    const direct = sugs.find((s) => s.code === 'ModuleNotFoundError-direct-script');
    expect(direct).toBeTruthy();
    expect(direct!.hint).toMatch(/run_tests/);
    expect(direct!.hint).toMatch(/conftest\.py/);
    expect(direct!.hint).toMatch(/sys\.path\.insert/);
    expect(direct!.hint).toMatch(/严禁/); // 不允许改成 from src.X
  });

  it('detects test fixture FileNotFoundError and recommends user/reference fixtures before tmp_path', () => {
    const log =
      `tests/test_table_parser.py:12: in test_parse\n` +
      `    result = parse_table('sample.tbl')\n` +
      `src/table_parser.py:8: in parse_table\n` +
      `    with open(filename, encoding=encoding, errors='replace') as fin:\n` +
      `E           FileNotFoundError: [Errno 2] No such file or directory: 'sample.tbl'`;
    const sugs = calibrateDebugSuggestions(log);
    const fix = sugs.find((s) => s.code === 'FileNotFoundError-test-fixture');
    expect(fix).toBeTruthy();
    expect(fix!.hint).toMatch(/用户|工作区/);
    expect(fix!.hint).toMatch(/http_fetch/);
    expect(fix!.hint).toMatch(/tmp_path/);
    expect(fix!.hint).toMatch(/tests\/fixtures/);
    expect(fix!.hint).toMatch(/sample\.tbl/);
    // 通用 FileNotFoundError 也会命中，但 fixture 规则 severity=1 排在前面
    expect(sugs[0].code).toBe('FileNotFoundError-test-fixture');
  });

  it('detects malformed fixture content and points to user/reference samples', () => {
    const log =
      `tests/test_table_parser.py::test_parse FAILED\n` +
      `tests/test_table_parser.py:14: in test_parse\n` +
      `    db = parse_table('tests/fixtures/sample.tbl')\n` +
      `src/table_parser.py:42: in parse_table\n` +
      `    raise ParseError(f"Invalid syntax at line {n}, column 1: \\\"{line}\\\"")\n` +
      `E   table_parser.ParseError: Invalid syntax at line 5, column 1: "BAD_ROW"`;
    const sugs = calibrateDebugSuggestions(log);
    const fix = sugs.find((s) => s.code === 'fixture-content-malformed');
    expect(fix).toBeTruthy();
    expect(fix!.hint).toMatch(/read_file/);
    expect(fix!.hint).toMatch(/write_file/);
    expect(fix!.hint).toMatch(/整文件重写/);
    expect(fix!.hint).toMatch(/用户|工作区/);
    expect(fix!.hint).toMatch(/http_fetch/);
    expect(fix!.hint).toMatch(/停止编造/);
    expect(fix!.hint).toMatch(/严禁/); // 别去改被测模块
    expect(fix!.hint).toMatch(/line 5/); // line 号回填到提示
    expect(fix!.hint).toMatch(/内联常量/);
    // 排序：fixture-malformed severity=1 必须在第一位（不被通用规则挤到后面）
    expect(sugs[0].code).toBe('fixture-content-malformed');
  });

  it('also detects "failed to parse" / ParseError style errors as fixture-content-malformed', () => {
    const sugs = calibrateDebugSuggestions(
      `E   ValueError: failed to parse JSON at offset 12: unexpected token`,
    );
    expect(sugs.find((s) => s.code === 'fixture-content-malformed')).toBeTruthy();
  });

  it('detects pytest collection failure (exit=2) even without traceback body', () => {
    const sugs = calibrateDebugSuggestions('', 'pytest exit=2');
    expect(sugs.find((s) => s.code === 'pytest-collection')).toBeTruthy();
  });

  it('flags forbidden "from src.X import" pattern', () => {
    const sugs = calibrateDebugSuggestions(
      `from src.data_processor import process_dbc_data`,
    );
    expect(sugs.find((s) => s.code === 'src-prefix-import')).toBeTruthy();
  });

  it('detects pip resolver failure and points to add_dependency mapping', () => {
    const sugs = calibrateDebugSuggestions(
      `ERROR: Could not find a version that satisfies the requirement sklearn`,
    );
    const m = sugs.find((s) => s.code === 'pip-resolver')!;
    expect(m).toBeTruthy();
    expect(m.hint).toMatch(/scikit-learn|opencv-python/);
});

it('catches replace_in_file no-op self-feedback', () => {
  const sugs = calibrateDebugSuggestions(
    `tool calls:\n  - replace_in_file FAIL no-op edit refused: find === replace`,
  );
  expect(sugs.find((s) => s.code === 'replace-no-op')).toBeTruthy();
});

it('catches replace_in_file missing-path self-feedback', () => {
  const sugs = calibrateDebugSuggestions(
    `tool calls:\n  - replace_in_file FAIL invalid replace_in_file args: path must be a non-empty string`,
  );
  const fix = sugs.find((s) => s.code === 'replace-missing-path');
  expect(fix).toBeTruthy();
  expect(fix!.hint).toMatch(/args\.path/);
  expect(fix!.hint).toMatch(/writable allowlist/);
});

it('requires patch and run_program verification for network API failures', () => {
    const sugs = calibrateDebugSuggestions(
      `Network API failure detected. Evidence: 403 Client Error: Forbidden for url: https://timor.tech/api/holiday/`,
    );
    const fix = sugs.find((s) => s.code === 'network-api-failure')!;
    expect(fix).toBeTruthy();
    expect(fix.hint).toMatch(/http_fetch/);
    expect(fix.hint).toMatch(/apply_patch|replace_in_file/);
    expect(fix.hint).toMatch(/run_program/);
    expect(fix.hint).toMatch(/HTTP 403/);
    expect(fix.hint).toMatch(/免 key\/token/);
  });

  it('does not misclassify bare LLM fetch failures as project API failures', () => {
    const sugs = calibrateDebugSuggestions('TypeError: fetch failed');
    expect(sugs.find((s) => s.code === 'network-api-failure')).toBeUndefined();
    const infra = sugs.find((s) => s.code === 'llm-transport-failure')!;
    expect(infra).toBeTruthy();
    expect(infra.hint).toMatch(/OPENAI_BASE_URL|provider/);
    expect(infra.hint).toMatch(/不要.*业务代码/);
  });

  it('does not misclassify OpenRouter rate limits as project API failures', () => {
    const sugs = calibrateDebugSuggestions(
      `OpenAI HTTP 429: {"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"openrouter/free is temporarily rate-limited upstream","retry_after_seconds":8}}}`,
    );
    expect(sugs.find((s) => s.code === 'network-api-failure')).toBeUndefined();
    const infra = sugs.find((s) => s.code === 'llm-transport-failure')!;
    expect(infra).toBeTruthy();
    expect(infra.hint).toMatch(/OPENROUTER_BASE_URL|限流|配额/);
    expect(infra.hint).toMatch(/不要.*业务代码/);
  });

  it('does not misclassify provider response_format capability errors as project API failures', () => {
    const sugs = calibrateDebugSuggestions(
      `OpenAI HTTP 400: {"error":{"message":"Provider returned error","code":400,"metadata":{"raw":"Model 'tencent/hy3' does not support 'json_object' response format. Supported formats: json_schema.","provider_name":"Novita"}}}`,
    );
    expect(sugs.find((s) => s.code === 'network-api-failure')).toBeUndefined();
    const infra = sugs.find((s) => s.code === 'llm-transport-failure')!;
    expect(infra).toBeTruthy();
    expect(infra.hint).toMatch(/结构化输出|provider/);
    expect(infra.hint).toMatch(/不要.*业务代码/);
  });

  it('detects stale hard-coded dates before suggesting API switching', () => {
    const sugs = calibrateDebugSuggestions(
      `mock_response.json.return_value = {"data": [{"date": "2023-10-01", "name": "国庆节"}]}\n` +
        `E   ValueError: No upcoming holidays found in the next 30 days.`,
    );
    const stale = sugs.find((s) => s.code === 'stale-date-test-data')!;
    expect(stale).toBeTruthy();
    expect(stale.hint).toMatch(/datetime\.now|timedelta/);
    expect(stale.hint).toMatch(/不是外部 API 不可用/);
  });

  it('does not route provider context-limit failures as project API failures', () => {
    const sugs = calibrateDebugSuggestions(
      `OpenAI HTTP 400: {"code":"prefill_memory_exceeded","message":"prefill memory guard dynamic ceiling exceeded"}`,
    );
    expect(sugs.find((s) => s.code === 'network-api-failure')).toBeUndefined();
    const infra = sugs.find((s) => s.code === 'llm-context-too-large')!;
    expect(infra).toBeTruthy();
    expect(infra.hint).toMatch(/上下文|prompt|token/);
    expect(infra.hint).toMatch(/不要.*业务代码/);
  });

  it('maps network API status codes to switching guidance', () => {
    const sugs = calibrateDebugSuggestions(
      `Weather API request failed: 429 Too Many Requests for url: https://weather.example/v1/forecast`,
    );
    const fix = sugs.find((s) => s.code === 'network-api-failure')!;
    expect(fix.hint).toMatch(/HTTP 429/);
    expect(fix.hint).toMatch(/限流/);
    expect(fix.hint).toMatch(/切换/);
  });

  it('does not suggest API switching for mocked HTTP status text inside test assertions', () => {
    const sugs = calibrateDebugSuggestions(
      "AssertionError: expected [Function] to throw error matching /Failed to fetch/ but got 'Request failed with status code 404'\n" +
        ' × tests/unit/parser.test.ts > parseHTML extracts title/summary/link correctly\n' +
        '   → expected [] to have a length of 1 but got +0',
    );
    expect(sugs.find((s) => s.code === 'network-api-failure')).toBeUndefined();
  });

  it('does not suggest switching an external API for a loopback test-server failure', () => {
    const sugs = calibrateDebugSuggestions([
      'Network API failure detected. Treat this task as failed.',
      'Error: connect ECONNREFUSED 127.0.0.1:80',
      'FAIL tests/integration/web-server-flow.test.ts > returns 404 for missing briefing',
    ].join('\n'));

    expect(sugs.find((s) => s.code === 'network-api-failure')).toBeUndefined();
  });

  it('detects network API probe loops and stops endpoint enumeration', () => {
    const sugs = calibrateDebugSuggestions(
      `tool calls:\n` +
        `  - http_fetch FAIL fetch failed\n` +
        `  - http_fetch OK http_fetch GET https://example.test → 200 (0B)\n`,
    );
    const fix = sugs.find((s) => s.code === 'network-api-probe-loop')!;
    expect(fix).toBeTruthy();
    expect(fix.hint).toMatch(/停止继续枚举接口/);
    expect(fix.hint).toMatch(/run_program/);
  });

  it('returns empty when log is blank', () => {
    expect(calibrateDebugSuggestions('', '')).toEqual([]);
  });

  it('renderDebugSuggestions produces numbered markdown with evidence', () => {
    const sugs = calibrateDebugSuggestions(
      `ModuleNotFoundError: No module named 'foo'`,
    );
    const md = renderDebugSuggestions(sugs);
    expect(md).toMatch(/^## 修复建议/);
    expect(md).toMatch(/1\. /);
    expect(md).toMatch(/证据:/);
  });

  it('prioritizes latest tool failure over stale historical dependency errors', () => {
    const log = [
      `  - add_dependency 成功 add_dependency requirements.txt +1 (openpyxl)`,
      `  - run_tests 失败 pytest exit=2`,
      `E   ModuleNotFoundError: No module named 'openpyxl'`,
      `  - run_tests 失败 pytest exit=1`,
      `ERROR    parser:parser.py:42 Failed to load input file: module 'archive_parser' has no attribute 'load_file'`,
      `E               AttributeError: Mock object has no attribute 'writerow'`,
      `@patch('src.cli.DBCParser')`,
    ].join('\n');
    const sugs = calibrateDebugSuggestions(log);
    expect(sugs.map((s) => s.code)).toEqual(
      expect.arrayContaining(['AttributeError-module-api', 'mock-patch-target-src-prefix', 'AttributeError']),
    );
    expect(sugs.find((s) => s.code === 'ModuleNotFoundError')).toBeUndefined();
    expect(sugs[0]?.hint).toContain('archive_parser.load_file');
  });

  it('caps result to 6 suggestions', () => {
    const big = [
      `ModuleNotFoundError: No module named 'a'`,
      `ImportError: cannot import name 'X' from 'a'`,
      `ERROR collecting`,
      `from src.b import c`,
      `NameError: name 'd' is not defined`,
      `AttributeError: 'E' object has no attribute 'f'`,
      `TypeError: g() missing 1 required positional argument: 'h'`,
      `SyntaxError: invalid syntax`,
      `FileNotFoundError: [Errno 2] No such file: 'i.txt'`,
      `ERROR: No matching distribution found for j`,
      `UnicodeDecodeError: 'utf-8' codec can't decode byte`,
    ].join('\n');
    expect(calibrateDebugSuggestions(big).length).toBeLessThanOrEqual(6);
  });
});
