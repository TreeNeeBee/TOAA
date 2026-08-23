import { describe, expect, it } from 'vitest';
import {
  buildDebugBrief,
  buildFailureSignature,
  compactFailureEvidence,
  renderDebugBriefForPrompt,
} from '../src/core/debug_brief.js';
import { evaluateAttemptExtension } from '../src/domain/tickets/retry_policy.js';

describe('debug brief extraction', () => {
  it('keeps the root test failure ahead of noisy retry history', () => {
    const log = [
      'pytest exit=1',
      'FAILED tests/test_parser.py::test_dbc_signal_scale',
      'E AssertionError: expected 42 got 0',
      '## latest Debugger attempt failure',
      'Reason: repeated read-only/probe actions without progress for 3 rounds',
      'read_file src/parser.py',
      'read_file tests/test_parser.py',
    ].join('\n');

    const brief = buildDebugBrief({
      reason: 'UNIT_TEST failed; rolling back to paired CODE phase',
      failureLog: log,
      phase: 'UNIT_TEST',
      targetPhase: 'CODE',
    });

    expect(brief.category).toBe('test_failure');
    expect(brief.failedTests).toContain('tests/test_parser.py::test_dbc_signal_scale');
    expect(brief.summary).toContain('CODE');
    expect(brief.debugDemand).toContain('Fix the root implementation/contract defect');
    expect(renderDebugBriefForPrompt(brief)).toContain('debugDemand');
  });

  it('prioritizes concrete TypeScript compiler errors over a surrounding probe-loop reason', () => {
    const brief = buildDebugBrief({
      reason: 'repeated read-only/probe actions without progress for 3 rounds',
      failureLog: [
        'repeated read-only/probe actions without progress for 3 rounds',
        '- run_program 失败 npx tsc --noEmit exit=2',
        `src/scheduler.ts(1,10): error TS2724: package has no exported member named 'Parser'`,
      ].join('\n'),
      phase: 'CODE',
    });

    expect(brief.category).toBe('exception');
    expect(brief.primaryError).toContain('error TS2724');
    expect(brief.debugDemand).toContain('smallest allowed repair');
  });

  it('turns API failures into explicit debug demands without hiding status codes', () => {
    const brief = buildDebugBrief({
      reason: 'functional probe failed',
      failureLog: [
        'Network API failure detected',
        'http_fetch GET https://example.invalid/weather -> HTTP 403 Forbidden',
        'entrypoint still reports API failed',
      ].join('\n'),
      phase: 'FUNCTIONAL_TEST',
      targetPhase: 'REQUIREMENT_ANALYSIS',
    });

    expect(brief.category).toBe('network_api_failure');
    expect(brief.statusCodes).toContain('403');
    expect(brief.debugDemand).toContain('public no-key API');
    expect(brief.evidence.join('\n')).toContain('403');
  });

  it('does not treat a source URL as a network failure when the root cause is an assertion', () => {
    const brief = buildDebugBrief({
      reason: 'UNIT_TEST tool verification failed; rolling back to paired V-model source phase.',
      failureLog: [
        "const url = 'https://news.example.test/v2/top-headlines';",
        'run_tests failed npm test exit=1',
        'AssertionError: expected 1 to be 2 // Object.is equality',
      ].join('\n'),
      phase: 'UNIT_TEST',
      targetPhase: 'CODE',
    });

    expect(brief.category).toBe('test_failure');
    expect(brief.debugDemand).toContain('Fix the root implementation/contract defect');
  });

  it('keeps an assertion root cause when later provider recovery also fails', () => {
    const brief = buildDebugBrief({
      reason: 'all LLM providers failed for role Debugger',
      failureLog: [
        'AssertionError: expected generated briefing to contain 未知',
        'run_tests failed npm test exit=1',
        'all LLM providers failed for role Debugger: low-quality Debugger response',
        'read-only/probe actions in read-only recovery mode',
      ].join('\n'),
      phase: 'CODE',
    });

    expect(brief.category).toBe('test_failure');
    expect(brief.debugDemand).not.toContain('provider/context infrastructure');
  });

  it('keeps OpenAI-compatible provider DNS failures out of generated-project API debugging', () => {
    const brief = buildDebugBrief({
      reason: 'all LLM providers failed for role Architect',
      failureLog:
        'OpenAI-compatible provider request failed provider=deepseek_paid ' +
        'model=deepseek/deepseek-v4-flash base_url=https://openrouter.ai/api/v1 ' +
        'mode=non-stream: fetch failed; cause=getaddrinfo ENOTFOUND openrouter.ai',
      phase: 'DETAILED_DESIGN',
    });

    expect(brief.category).toBe('llm_provider');
    expect(brief.debugDemand).toContain('not a project code bug');
    expect(brief.debugDemand).toContain('retry the current Step');
    expect(brief.debugDemand).not.toContain('patch the real API integration');
  });

  it('classifies generic test gates as test failures', () => {
    const brief = buildDebugBrief({
      reason: 'Test gate: tests exit=1',
      failureLog: [
        'Reason: Test gate: tests exit=1',
        'stderr tail:',
        'unit regression failed: expected fixed implementation',
      ].join('\n'),
      phase: 'UNIT_TEST',
      targetPhase: 'CODE',
    });

    expect(brief.category).toBe('test_failure');
    expect(brief.debugDemand).toContain('Fix the root implementation/contract defect');
  });

  it('keeps loopback test-server failures out of the external API category', () => {
    const brief = buildDebugBrief({
      reason: 'INTEGRATION_TEST tool verification failed',
      failureLog: [
        'run_tests failed npm test exit=1',
        'FAIL tests/integration/web-server-flow.test.ts > serves the index',
        'Error: connect ECONNREFUSED 127.0.0.1:80',
        'returns 404 for missing briefing',
      ].join('\n'),
      phase: 'INTEGRATION_TEST',
    });

    expect(brief.category).toBe('test_failure');
    expect(brief.statusCodes).not.toContain('404');
    expect(brief.debugDemand).not.toContain('API');
  });

  it('uses current Vitest failures instead of a stale network marker', () => {
    const brief = buildDebugBrief({
      reason: 'INTEGRATION_TEST tool verification failed',
      failureLog: [
        'Network API failure detected. Treat this task as failed.',
        'run_tests failed npm test exit=1 args=tests/integration',
        'FAIL  tests/integration/web-server-flow.test.ts > returns rendered briefing content',
        "AssertionError: expected '<h1>Test Briefing</h1>' to contain '# Test Briefing'",
      ].join('\n'),
      phase: 'INTEGRATION_TEST',
    });

    expect(brief.category).toBe('test_failure');
    expect(brief.failedTests[0]).toContain('web-server-flow.test.ts');
    expect(brief.primaryError).not.toContain('Network API failure');
  });

  it('compacts long evidence while preserving the actionable failure', () => {
    const noise = Array.from({ length: 200 }, (_, i) => `old retry noise ${i}`).join('\n');
    const log = `${noise}\nSyntaxError: unterminated string literal in src/main.py\n${noise}`;

    const compact = compactFailureEvidence({
      reason: 'run_tests failed',
      failureLog: log,
      maxChars: 900,
      maxLines: 20,
    });

    expect(compact).toContain('SyntaxError: unterminated string literal');
    expect(compact.length).toBeLessThanOrEqual(980);
    expect(compact).not.toContain('old retry noise 0\nold retry noise 1\nold retry noise 2\nold retry noise 3');
  });

  it('suppresses retry process noise when actionable root evidence exists', () => {
    const compact = compactFailureEvidence({
      reason: 'script exhausted',
      failureLog: [
        'pytest exit=1',
        'FAILED tests/test_unit.py::test_parse_dbc_malformed_raises',
        'DID NOT RAISE <DBCParseError>',
      ].join('\n'),
      maxChars: 900,
      maxLines: 20,
    });

    expect(compact).toContain('test_parse_dbc_malformed_raises');
    expect(compact).not.toContain('script exhausted');
  });

  it('prefers Chinese failed tool calls over successful tool lines', () => {
    const brief = buildDebugBrief({
      reason: 'max rounds exceeded without satisfying outputs',
      failureLog: [
        '- write_file 成功 wrote docs/03-detailed-design.md (2975B)',
        '- append_file 失败 append_file 单次内容 16345B 超过本 Step chunk limit 11000B',
        '- append_file 成功 appended 5105B to docs/03-detailed-design.md (now 8080B)',
        '- append_file 失败 invalid append_file args: content must be a string',
        '- write_file 成功 wrote docs/tests/integration-test-plan.md (4914B)',
      ].join('\n'),
      phase: 'DETAILED_DESIGN',
    });

    expect(brief.toolFailures[0]).toContain('append_file 失败');
    expect(brief.primaryError).toContain('append_file 失败');
    expect(brief.primaryError).not.toContain('write_file 成功');
  });

  it('keeps an exact missing-output stall as the root defect over incidental tool denial', () => {
    const brief = buildDebugBrief({
      reason:
        'write/progress actions did not reduce missing outputs for 3 rounds; ' +
        'missing outputs: docs/tests/unit-test-plan.md.',
      failureLog: [
        'read_file denied: path is outside the project directory',
        'write/progress actions did not reduce missing outputs for 3 rounds',
        'missing outputs: docs/tests/unit-test-plan.md',
      ].join('\n'),
      phase: 'CODE',
    });

    expect(brief.category).toBe('missing_output');
    expect(brief.primaryError).toContain('missing outputs');
    expect(brief.primaryError).toContain('docs/tests/unit-test-plan.md');
    expect(brief.debugDemand).toContain('Create or repair the declared output files');
  });
});

/**
 * A runner that cannot find the test file is reporting unwritten work, not a failing test.
 *
 * Both runners say so in their own words, and both used to fall through to the generic
 * `pytest exit=[1-9]` catch, which answers `test_failure` — whose demand is "fix the root
 * implementation/contract defect… do not rewrite fixtures". That is the one repair that cannot
 * apply here: the implementation was fine and the files did not exist. A live dbc3 CODE Step spent
 * all ten of its rounds on that advice while owing five declared outputs.
 */
describe('runner cannot find the test file', () => {
  const categoryOf = async (failureLog: string) => {
    const { buildDebugBrief } = await import('../src/core/debug_brief.js');
    return buildDebugBrief({ failureLog, phase: 'CODE' }).category;
  };

  it('reads a pytest usage error as unwritten outputs', async () => {
    expect(await categoryOf(
      'pytest exit=4 args=tests/test_dbc_parser.py\nERROR: file or directory not found: tests/test_dbc_parser.py',
    )).toBe('missing_output');
  });

  it('reads vitest finding nothing the same way', async () => {
    expect(await categoryOf('npm test exit=1\nNo test files found, exiting with code 1'))
      .toBe('missing_output');
  });

  it('gives that failure the demand that names the action', async () => {
    const { buildDebugBrief } = await import('../src/core/debug_brief.js');
    const brief = buildDebugBrief({
      failureLog: 'pytest exit=4\nERROR: file or directory not found: tests/test_main.py',
      phase: 'CODE',
    });
    expect(brief.debugDemand).toMatch(/Create or repair the declared output files/u);
    // The advice that used to arrive and could not apply.
    expect(brief.debugDemand).not.toMatch(/do not rewrite fixtures/iu);
  });

  // A suite that ran and failed is still a test failure; this must not swallow the ordinary case.
  it('leaves a genuinely failing suite classified as a test failure', async () => {
    expect(await categoryOf('pytest exit=1\n1 failed, 3 passed\nE   assert 2 == 3'))
      .toBe('test_failure');
  });
});

// The explanatory line is often trimmed out of a truncated log, so the exit code must count alone.
// Across three live runs, 39 failures carried `pytest exit=4` without the sentence that explains it.
it('reads a bare pytest exit=4 as unwritten outputs even without the explanation', async () => {
  const { buildDebugBrief } = await import('../src/core/debug_brief.js');
  expect(buildDebugBrief({
    failureLog: 'run_tests failed: pytest exit=4 args=tests/test_main.py',
  }).category).toBe('missing_output');
});

/**
 * Our provider's outage and the generated project's API failure look alike and need opposite
 * answers. `network_api_failure` tells the project to switch APIs and verify the integration —
 * a rewrite of working code when the request that failed was ours, not the project's.
 */
describe('provider outage is not a project API failure', () => {
  const categoryOf = async (failureLog: string) => {
    const { buildDebugBrief } = await import('../src/core/debug_brief.js');
    return buildDebugBrief({ failureLog }).category;
  };

  it('reads an availability probe failure as ours', async () => {
    expect(await categoryOf(
      'Architect availability check failed for openai:deepseek/deepseek-v4-flash: fetch failed',
    )).toBe('llm_provider');
  });

  it('reads a reasoning-only stream as ours', async () => {
    expect(await categoryOf(
      'OpenAI stream sent 4293 reasoning chars but no content within 900000ms; aborting',
    )).toBe('llm_provider');
  });

  // The project's own failing request must still become a project defect.
  it('leaves the project\'s own API failure classified as a network failure', async () => {
    expect(await categoryOf(
      'http_fetch https://api.example.com/v1/items failed: HTTP 503',
    )).toBe('network_api_failure');
  });
});

/**
 * File extraction must not depend on knowing the project's data format.
 *
 * The extension list had accumulated `dbc` and `xlsx` from one past project. Any project whose
 * format was absent lost file extraction entirely — and `files` feeds both the brief the Debugger
 * reads and the fingerprints the wiki ranks on, so the loss is silent and compounding.
 */
describe('file extraction is format-agnostic', () => {
  const filesIn = async (failureLog: string) => {
    const { buildDebugBrief } = await import('../src/core/debug_brief.js');
    return buildDebugBrief({ failureLog }).files;
  };

  it('finds paths whose extension nobody enumerated', async () => {
    const files = await filesIn([
      'error while reading src/schema/user.proto',
      'migration failed: src/db/0007_add_index.sql',
      'config rejected: src/deploy/values.yaml',
      'asset missing: tests/fixtures/frame.parquet',
    ].join('\n'));
    expect(files).toContain('src/schema/user.proto');
    expect(files).toContain('src/db/0007_add_index.sql');
    expect(files).toContain('src/deploy/values.yaml');
    expect(files).toContain('tests/fixtures/frame.parquet');
  });

  it('still finds the ordinary source and test paths', async () => {
    const files = await filesIn('File "tests/test_main.py", line 3\nsrc/parser.py:12: error');
    expect(files).toContain('tests/test_main.py');
    expect(files).toContain('src/parser.py');
  });

  // The precision comes from the layout prefix, not from the extension.
  it('does not treat every dotted token as a file', async () => {
    const files = await filesIn('installed cantools 42.0.3 and openpyxl 3.1.5 from pypi.org');
    expect(files).toEqual([]);
  });
});

describe('primary error', () => {
  // `primaryError` is structured and survives the context budget; the compact-evidence block does
  // not. A live Debugger was handed `failed test: ...::test_writes_signal_data` for 26 attempts
  // while `assert None == ''` sat only in the evidence block, which was trimmed every time — it
  // knew which test failed and never learned why.
  it('carries the reason the runner printed beside the case', () => {
    const brief = buildDebugBrief({
      reason: 'attempt failed',
      failureLog: [
        'run_tests: pytest exit=1 args=tests/modules/test_excel_writer_module.py',
        "FAILED tests/modules/test_excel_writer_module.py::TestExcelWriterBehavior::test_writes_signal_data - assert None == ''",
        '1 failed, 36 passed',
      ].join('\n'),
      phase: 'HIGH_LEVEL_DESIGN',
      targetPhase: 'HIGH_LEVEL_DESIGN',
    });
    expect(brief.primaryError).toContain('test_writes_signal_data');
    expect(brief.primaryError).toContain("assert None == ''");
  });

  it('still names the case when the runner printed no reason', () => {
    const brief = buildDebugBrief({
      reason: 'attempt failed',
      failureLog: [
        'run_tests: pytest exit=1 args=tests/modules/test_excel_writer_module.py',
        'FAILED tests/modules/test_excel_writer_module.py::TestExcelWriterBehavior::test_writes_signal_data',
        '1 failed, 36 passed',
      ].join('\n'),
      phase: 'HIGH_LEVEL_DESIGN',
      targetPhase: 'HIGH_LEVEL_DESIGN',
    });
    expect(brief.primaryError).toBe(
      'failed test: tests/modules/test_excel_writer_module.py::TestExcelWriterBehavior::test_writes_signal_data',
    );
  });
});

describe('failure signature stability', () => {
  const FAILED_CASES = [
    'FAILED tests/modules/test_dbc_parser_module.py::TestDBCParserContract::test_signal_attributes_extraction - ValueError: Failed to parse DBC',
    "FAILED tests/modules/test_excel_writer_module.py::TestExcelWriterBehavior::test_writes_signal_data - assert None == ''",
  ];

  const attemptLog = (invocations: string[]): string => [
    'verification command repeated without a successful mutation: run_tests',
    ...invocations,
    ...FAILED_CASES,
    '2 failed, 35 passed',
  ].join('\n');

  const signatureFor = (invocations: string[]): string =>
    buildFailureSignature(
      buildDebugBrief({
        reason: 'attempt failed',
        failureLog: attemptLog(invocations),
        phase: 'HIGH_LEVEL_DESIGN',
        targetPhase: 'HIGH_LEVEL_DESIGN',
      }),
      'test_command_failed',
    );

  // A live Ticket reached twelve attempts on ten consecutive identical pytest results because the
  // signature hashed the whole `run_tests: ... args=... -v` line: the agent varied its flags and
  // its call count, so nine failures produced seven distinct signatures and the recurrence guard
  // that exists to stop exactly this never saw a repeat.
  it('ignores the pytest flags an attempt happened to use', () => {
    expect(signatureFor([
      'run_tests: pytest exit=1 args=tests/modules/test_dbc_parser_module.py tests/modules/test_excel_writer_module.py -v',
    ])).toBe(signatureFor([
      'run_tests: pytest exit=1 args=tests/modules/test_dbc_parser_module.py tests/modules/test_excel_writer_module.py --tb=short',
    ]));
  });

  it('ignores how many times the attempt reran the same failing command', () => {
    expect(signatureFor([
      'run_tests: pytest exit=1 args=tests/modules/test_dbc_parser_module.py -v',
    ])).toBe(signatureFor([
      'run_tests: pytest exit=1 args=tests/modules/test_dbc_parser_module.py -v',
      'run_tests: pytest exit=1 args=tests/modules/test_dbc_parser_module.py --tb=short',
      'run_tests: pytest exit=1 args=tests/modules/test_excel_writer_module.py -q',
    ]));
  });

  it('stops extending a Ticket whose failure keeps coming back under a varying command', () => {
    const evidence = [
      ['run_tests: pytest exit=1 args=tests/modules/test_dbc_parser_module.py -v'],
      ['run_tests: pytest exit=1 args=tests/modules/test_dbc_parser_module.py --tb=short'],
      ['run_tests: pytest exit=1 args=tests/modules/test_excel_writer_module.py -q'],
    ].map((invocations) => ({
      signature: signatureFor(invocations),
      category: 'test_failure',
      toolchainBuildId: 'build-under-test',
    }));
    expect(evaluateAttemptExtension(evidence, 'build-under-test')).toMatchObject({ extend: false });
  });

  it('still separates a genuinely different failure', () => {
    const parserOnly = buildFailureSignature(
      buildDebugBrief({
        reason: 'attempt failed',
        failureLog: [
          'run_tests: pytest exit=1 args=tests/modules/test_dbc_parser_module.py -v',
          FAILED_CASES[0]!,
          '1 failed, 36 passed',
        ].join('\n'),
        phase: 'HIGH_LEVEL_DESIGN',
        targetPhase: 'HIGH_LEVEL_DESIGN',
      }),
      'test_command_failed',
    );
    expect(parserOnly).not.toBe(signatureFor([
      'run_tests: pytest exit=1 args=tests/modules/test_dbc_parser_module.py -v',
    ]));
  });

  // `pytest -v` prints the case id and then the case's own stdout on the same line, so the outcome
  // word is not on the line at all. A live Ticket harvested five passing cases this way; excluding
  // lines that say PASSED does not stop it, because program output is arbitrary.
  it('does not count passing cases named by a verbose run', () => {
    const verbose = [
      'run_tests: pytest exit=1 args=tests/modules/test_excel_writer_module.py -v',
      'tests/modules/test_main_module.py::TestParseArgs::test_parse_args_minimal PASSED',
      'tests/modules/test_main_module.py::TestMainFunction::test_main_success_flow Successfully wrote 1 signals to /tmp/out.xlsx',
      'tests/modules/test_main_module.py::TestParseArgs::test_parse_args_help usage: dbc2excel [-h] --ecus ECUS [ECUS ...]',
      "FAILED tests/modules/test_excel_writer_module.py::TestExcelWriterBehavior::test_writes_signal_data - assert None == ''",
      '1 failed, 36 passed',
    ].join('\n');
    const quiet = [
      'run_tests: pytest exit=1 args=tests/modules/test_excel_writer_module.py --tb=short',
      "FAILED tests/modules/test_excel_writer_module.py::TestExcelWriterBehavior::test_writes_signal_data - assert None == ''",
      '1 failed, 36 passed',
    ].join('\n');
    const brief = (log: string) => buildDebugBrief({
      reason: 'attempt failed',
      failureLog: log,
      phase: 'HIGH_LEVEL_DESIGN',
      targetPhase: 'HIGH_LEVEL_DESIGN',
    });
    expect(brief(verbose).failedTests).toEqual([
      'tests/modules/test_excel_writer_module.py::TestExcelWriterBehavior::test_writes_signal_data',
    ]);
    expect(buildFailureSignature(brief(verbose), 'test_command_failed'))
      .toBe(buildFailureSignature(brief(quiet), 'test_command_failed'));
  });

  // `pytest -v` writes the outcome at the end of a line and the next case's id at the start of the
  // following one, so a `FAILED\s+<id>` pattern binds across the newline and reports the case that
  // passed. The two cases here are adjacent in exactly that order.
  it('does not let a line-ending FAILED claim the following test', () => {
    const brief = buildDebugBrief({
      reason: 'attempt failed',
      failureLog: [
        'run_tests: pytest exit=1 args=tests/modules/test_excel_writer_module.py -v',
        'tests/modules/test_excel_writer_module.py::TestExcelWriterBehavior::test_writes_signal_data FAILED',
        'tests/modules/test_excel_writer_module.py::TestExcelWriterBehavior::test_handles_empty_signals_list PASSED',
        '1 failed, 36 passed',
      ].join('\n'),
      phase: 'HIGH_LEVEL_DESIGN',
      targetPhase: 'HIGH_LEVEL_DESIGN',
    });
    expect(brief.failedTests).toEqual([
      'tests/modules/test_excel_writer_module.py::TestExcelWriterBehavior::test_writes_signal_data',
    ]);
  });

  it('still reads a failing test id that a summary lists on its own line', () => {
    const brief = buildDebugBrief({
      reason: 'attempt failed',
      failureLog: [
        'run_tests: pytest exit=1 args=tests/modules/test_excel_writer_module.py',
        'short test summary info',
        'tests/modules/test_excel_writer_module.py::TestExcelWriterBehavior::test_writes_signal_data',
      ].join('\n'),
      phase: 'HIGH_LEVEL_DESIGN',
      targetPhase: 'HIGH_LEVEL_DESIGN',
    });
    expect(brief.failedTests).toEqual([
      'tests/modules/test_excel_writer_module.py::TestExcelWriterBehavior::test_writes_signal_data',
    ]);
  });

  // pytest re-numbers its temporary directory every run, and a filesystem error quotes the path.
  // A live Ticket produced five distinct signatures from six identical results because of that
  // counter alone — the reason text was right, and the number inside it was not part of the failure.
  it('ignores the temporary directory a rerun happens to get', () => {
    const run = (n: number) => buildFailureSignature(
      buildDebugBrief({
        reason: 'attempt failed',
        failureLog: [
          'run_tests: pytest exit=1 args=tests/verification/p1/functional-test/S8/test_risk_supplement.py',
          `FAILED tests/verification/p1/functional-test/S8/test_risk_supplement.py::TestErrorCSV::test_error_csv_content_rows - FileNotFoundError: [Errno 2] No such file or directory: '/tmp/pytest-of-ddk/pytest-${n}/test_error_csv_content_rows0/out.errors.csv'`,
          '1 failed, 24 passed',
        ].join('\n'),
        phase: 'FUNCTIONAL_TEST',
        targetPhase: 'FUNCTIONAL_TEST',
      }),
      'test_command_failed',
    );
    expect(run(0)).toBe(run(1));
    expect(run(1)).toBe(run(47));
  });

  it('still separates two different files failing the same way', () => {
    const forFile = (file: string) => buildFailureSignature(
      buildDebugBrief({
        reason: 'attempt failed',
        failureLog: [
          'run_tests: pytest exit=1 args=tests/verification/p1/functional-test/S8/test_risk_supplement.py',
          `FAILED tests/verification/p1/functional-test/S8/test_risk_supplement.py::TestErrorCSV::test_error_csv_content_rows - FileNotFoundError: [Errno 2] No such file or directory: '/tmp/pytest-of-ddk/pytest-0/case0/${file}'`,
          '1 failed, 24 passed',
        ].join('\n'),
        phase: 'FUNCTIONAL_TEST',
        targetPhase: 'FUNCTIONAL_TEST',
      }),
      'test_command_failed',
    );
    expect(forFile('out.errors.csv')).not.toBe(forFile('out.xlsx'));
  });

  it('separates a different tool failing the same way', () => {
    expect(signatureFor([
      'run_tests: pytest exit=1 args=tests/modules/test_dbc_parser_module.py -v',
    ])).not.toBe(signatureFor([
      'write_file: denied tests/modules/test_dbc_parser_module.py',
    ]));
  });
});
