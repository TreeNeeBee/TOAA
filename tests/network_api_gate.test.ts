import { describe, expect, it } from 'vitest';
import { detectNetworkApiFailure } from '../src/core/network_api_gate.js';

describe('detectNetworkApiFailure', () => {
  it('does not treat requests.get timeout parameters as network failures', () => {
    const log = `
      response = requests.get(url, params=params, timeout=10)
      E   ValueError: No upcoming holidays found in the next 30 days.
    `;
    expect(detectNetworkApiFailure(log)).toBeNull();
  });

  it('detects explicit HTTP/API failures', () => {
    const failure = detectNetworkApiFailure(
      'Weather API request failed: 503 Service Unavailable for url: https://weather.example/v1',
    );
    expect(failure?.evidence).toContain('503');
  });

  it('detects DNS and transport exceptions', () => {
    const failure = detectNetworkApiFailure(
      "requests.exceptions.ConnectionError: NameResolutionError: Failed to resolve 'api.example.test'",
    );
    expect(failure?.evidence).toContain('NameResolutionError');
  });

  it('does not treat passing test names about network errors as real API failures', () => {
    const vitest = detectNetworkApiFailure(
      '✓ tests/unit/crawler.test.ts > M001 Crawler > fetchPage 网络错误抛出错误',
    );
    const pytest = detectNetworkApiFailure(
      'PASSED tests/test_api.py::test_fetch_handles_network_error',
    );
    expect(vitest).toBeNull();
    expect(pytest).toBeNull();
  });

  it('does not treat failing test titles about network errors as real API failures', () => {
    const vitest = detectNetworkApiFailure(
      'FAIL  tests/unit/crawler.test.ts > M001 Crawler > fetchPage 网络错误抛出错误',
    );
    const vitestCross = detectNetworkApiFailure(
      '× tests/unit/crawler.test.ts > M001 Crawler > fetchPage network error is handled',
    );
    const pytest = detectNetworkApiFailure(
      'FAILED tests/test_api.py::test_fetch_handles_network_error - AssertionError: expected fallback',
    );
    expect(vitest).toBeNull();
    expect(vitestCross).toBeNull();
    expect(pytest).toBeNull();
  });

  it('does not treat test assertion diagnostics with mocked HTTP status text as real API failures', () => {
    const vitest = detectNetworkApiFailure(
      "AssertionError: expected [Function] to throw error matching /Failed to fetch/ but got 'Request failed with status code 404'",
    );
    const pretty = detectNetworkApiFailure(
      "   → expected 'Request failed with status code 404' to contain 'Failed to fetch'",
    );
    expect(vitest).toBeNull();
    expect(pretty).toBeNull();
  });

  it('does not treat assertion diff payloads as live network output', () => {
    const diff = [
      'FAIL  tests/report.test.ts > renders degraded sources',
      'AssertionError: expected received output to equal the snapshot',
      '- Expected',
      '+ Received',
      '+ - source-alpha: Network error',
    ].join('\n');

    expect(detectNetworkApiFailure(diff)).toBeNull();
  });

  it('still detects marker-prefixed application output without assertion context', () => {
    expect(detectNetworkApiFailure('+ - upstream: Network error')).not.toBeNull();
  });

  it('ignores API errors deliberately emitted inside Vitest captured stderr', () => {
    const log = [
      'stderr | tests/integration/cli.test.ts > missing API key logs error',
      '[ERROR] API key is required. Set NEWS_API_KEY env or use --api-key.',
      '',
      'FAIL  tests/integration/cli.test.ts > normal fetch saves report file',
      'Error: Test timed out in 5000ms.',
    ].join('\n');

    expect(detectNetworkApiFailure(log)).toBeNull();
  });

  it('does not classify an application contract error after fetch as a network failure', () => {
    expect(
      detectNetworkApiFailure('[ERROR] Fetch failed: storage.save is not a function'),
    ).toBeNull();
  });

  it('still detects a native fetch transport failure without extra details', () => {
    expect(detectNetworkApiFailure('TypeError: fetch failed')).not.toBeNull();
  });

  it('does not treat loopback test-server failures as external API failures', () => {
    expect(detectNetworkApiFailure('Error: connect ECONNREFUSED 127.0.0.1:80')).toBeNull();
    expect(detectNetworkApiFailure('Request to http://localhost:3000 failed: connection refused')).toBeNull();
  });

  it('does not treat a test runner complaint about the workspace as a network failure', () => {
    expect(
      detectNetworkApiFailure(
        'Error: [vitest] There was an error when mocking a module. If you are using "vi.mock" factory, make sure there are no top level variables inside, since this call is hoisted to top of the file. Read more: https://vitest.dev/api/vi.html#vi-mock',
      ),
    ).toBeNull();
    expect(detectNetworkApiFailure('Error: [jest] Your test suite must contain at least one test.')).toBeNull();
  });

  it('does not let a documentation link supply the network vocabulary', () => {
    expect(
      detectNetworkApiFailure('Error: transform failed. See https://esbuild.github.io/api/#target'),
    ).toBeNull();
    expect(
      detectNetworkApiFailure('Parsing error: unexpected token. \u8be6\u89c1 https://eslint.org/docs/rules/'),
    ).toBeNull();
  });

  it('still detects a real failure that happens to cite documentation', () => {
    expect(
      detectNetworkApiFailure('Error: API request failed with status 503. See https://docs.example.com/api'),
    ).not.toBeNull();
    expect(
      detectNetworkApiFailure('\u7f51\u7edc\u8fde\u63a5\u8d85\u65f6\uff0c\u53c2\u8003 https://docs.example.com/api'),
    ).not.toBeNull();
  });
});
