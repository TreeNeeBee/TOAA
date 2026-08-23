import { describe, expect, it } from 'vitest';
import { buildDebugBrief } from '../src/core/debug_brief.js';
import { DebugWiki, bundledDebugWikiPath } from '../src/core/debug_wiki.js';

/**
 * These cases used to guard a static rule table in `calibration.ts` that turned a failure log into
 * repair instructions. The table was removed: nothing in production ever called it, so every bundle
 * tree-shook it away and no model ever saw a single rule. Its knowledge now lives in the Debug Wiki,
 * and the distinctions it encoded belong to the classifier that actually runs.
 *
 * The intent is unchanged and is what these assertions keep: a failure produced by *our* provider
 * must never be answered with advice aimed at the *generated project's* API integration. That advice
 * — switch to a public no-key API and verify the integration — rewrites working code to repair
 * something that was never broken.
 */
describe('provider failures never become project API defects', () => {
  const categoryOf = (failureLog: string) => buildDebugBrief({ failureLog }).category;

  it('reads a bare fetch failure as ours', () => {
    expect(categoryOf('TypeError: fetch failed')).toBe('llm_provider');
  });

  it('reads a provider stream that died mid-response as ours', () => {
    expect(categoryOf(
      'all LLM providers failed for role Debugger: deepseek_paid/openai:deepseek/deepseek-v4-flash: ' +
      'OpenAI-compatible provider request failed provider=deepseek_paid model=deepseek/deepseek-v4-flash ' +
      'base_url=https://openrouter.ai/api/v1 mode=stream: OpenAI error: Network connection lost.',
    )).toBe('llm_provider');
  });

  it('reads a provider rate limit as ours, whatever status code it wraps', () => {
    expect(categoryOf(
      'OpenAI HTTP 429: {"error":{"message":"Provider returned error","code":429,' +
      '"metadata":{"raw":"openrouter/free is temporarily rate-limited upstream"}}}',
    )).toBe('llm_provider');
  });

  it('reads a provider capability rejection as ours', () => {
    expect(categoryOf(
      'OpenAI HTTP 400: {"error":{"message":"Provider returned error","code":400,"metadata":' +
      `{"raw":"Model 'tencent/hy3' does not support 'json_object' response format."}}}`,
    )).toBe('llm_provider');
  });

  it('reads a context-window overflow as ours', () => {
    expect(categoryOf('prefill_memory_exceeded: prompt too long for context window')).toBe('llm_provider');
  });

  // The other direction has to keep working, or a real integration defect stops becoming a Bug.
  it('still reads the project\'s own failing request as a network failure', () => {
    expect(categoryOf('http_fetch https://api.weather.example/v1/now failed: HTTP 503'))
      .toBe('network_api_failure');
  });

  it('does not treat an HTTP status asserted inside a test as a live API failure', () => {
    expect(categoryOf('pytest exit=1\nE   assert response.status_code == 503\nE    +  where 503 = mocked'))
      .not.toBe('network_api_failure');
  });

  it('does not treat a loopback test server as an external API', () => {
    expect(categoryOf('http_fetch http://127.0.0.1:8000/health failed: ECONNREFUSED'))
      .not.toBe('network_api_failure');
  });
});

/**
 * The rules whose knowledge was migrated rather than dropped. Asserted through retrieval, because an
 * entry nobody retrieves is worth exactly as much as the table nobody called.
 */
describe('migrated repair knowledge is retrievable', () => {
  const retrieve = async (failureLog: string) => {
    const wiki = new DebugWiki(bundledDebugWikiPath());
    const matches = await wiki.search(buildDebugBrief({ failureLog, phase: 'CODE' }), { limit: 3 });
    return matches.map((match) => match.entry.id);
  };

  it('finds the unwritten-test-file entry for both runners', async () => {
    expect(await retrieve('pytest exit=4\nERROR: file or directory not found: tests/test_x.py'))
      .toContain('agent.calibration.unwritten-test-file');
    expect(await retrieve('npm test exit=1\nNo test files found, exiting with code 1'))
      .toContain('agent.calibration.unwritten-test-file');
  });

  it('finds the fixture entry for a malformed sample', async () => {
    expect(await retrieve('pytest exit=1\nParseError: Invalid syntax at line 3, column 5'))
      .toContain('agent.calibration.fixtures');
  });

  it('finds the import entry for a missing module', async () => {
    expect(await retrieve("pytest exit=2\nE   ModuleNotFoundError: No module named 'parser'"))
      .toContain('agent.calibration.python-imports');
  });

  it('finds the provider entry when our own endpoint is the one that failed', async () => {
    expect(await retrieve('Architect availability check failed for openai:deepseek/deepseek-v4-flash: fetch failed'))
      .toContain('agent.calibration.provider-vs-project-network');
  });
});
