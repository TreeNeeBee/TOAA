import { describe, expect, it } from 'vitest';
import {
  buildDebugBrief,
  compactFailureEvidence,
  renderDebugBriefForPrompt,
} from '../src/core/debug_brief.js';

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

  it('keeps an exact missing-output stall as the root issue over incidental tool denial', () => {
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
