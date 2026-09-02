import type { Plan } from './plan.js';

/**
 * How a project that reaches an external network must be verified at each V-model level.
 *
 * A live run produced a scraper whose parser matched nothing on the real page, and every level
 * below acceptance passed: the unit test fed `parseHTML` a fragment written to match the parser's
 * own regular expression, and the integration and module levels replaced the scraper with a stub, so
 * the parser never ran. Acceptance was the first place real data met real code — and the corrective
 * loop then stubbed acceptance too, after which the suite was green and carried no information about
 * whether the product worked.
 *
 * The rule that closes it is about *where the data comes from*, not about mocking as such:
 *
 * - **S001–S004** own the paired baseline suites. Mocks are allowed, and Record/Replay can capture
 *   representative real responses without making the baseline depend on a live service.
 * - **S005-S008** independently inspect the baseline and may add risk-driven tests only under their
 *   verification-owned namespace. The frozen combined suite uses Record/Replay for external data.
 * - The **Phase delivery gate**, outside the eight Step gates, executes declared real-user scenarios
 *   against live dependencies with Replay disabled.
 */

/** Test-owning phases that may capture external responses while authoring their cases. */
export const RECORDED_TEST_AUTHORING_PHASES = [
  'REQUIREMENT_ANALYSIS',
  'HIGH_LEVEL_DESIGN',
  'DETAILED_DESIGN',
  'CODE',
  'UNIT_TEST',
  'INTEGRATION_TEST',
  'MODULE_TEST',
  'FUNCTIONAL_TEST',
] as const;

/** Live dependency access is owned by the Phase delivery gate, not by one V-model Step. */
export const LIVE_BOUNDARY = 'PHASE_DELIVERY_GATE';

const TYPESCRIPT_OUTBOUND = /\bfetch\s*\(|\baxios\b|\bnode-fetch\b|\bgot\b\s*\(|\bhttps?\.(?:get|request)\s*\(|\bundici\b|\bXMLHttpRequest\b/u;
const PYTHON_OUTBOUND = /\brequests\.(?:get|post|put|delete|request)\s*\(|\bhttpx\.\w+\s*\(|\burllib\.request\b|\baiohttp\b/u;

/** Whether this file reaches outside the process for data. */
export function usesOutboundNetwork(content: string, language: Plan['language']): boolean {
  return language === 'typescript'
    ? TYPESCRIPT_OUTBOUND.test(content)
    : PYTHON_OUTBOUND.test(content);
}

const TYPESCRIPT_BOUNDARY_STUB =
  /\bvi\.stubGlobal\s*\(\s*['"`]fetch['"`]|\bvi\.mock\s*\(|\bjest\.mock\s*\(|\bnock\s*\(|\bmsw\b|\bfetch-mock\b|\bglobalThis\.fetch\s*=|\bglobal\.fetch\s*=/u;
const PYTHON_BOUNDARY_STUB =
  /\b(?:monkeypatch|mocker)\.setattr\s*\(|\bunittest\.mock\b|\bresponses\.(?:activate|add)\b|\brequests_mock\b|@patch\b/u;

/** Whether this test replaces the outbound boundary with something the test itself supplies. */
export function stubsOutboundNetwork(content: string, language: Plan['language']): boolean {
  return language === 'typescript'
    ? TYPESCRIPT_BOUNDARY_STUB.test(content)
    : PYTHON_BOUNDARY_STUB.test(content);
}

/**
 * Whether this test reads its responses from a captured fixture rather than a literal in the file.
 *
 * Reading from disk is the discriminator: a response captured from the dependency has to be stored
 * somewhere, and a fixture written by hand inside the test file is exactly the case that made three
 * verification levels agree with a parser that could not parse anything real.
 */
export function replaysRecordedResponses(content: string): boolean {
  // A captured response has to be stored somewhere and then loaded, so the test must name a fixture
  // path. Both loading styles count: reading the file at run time, and importing it as a module
  // asset — rejecting the second would refuse a Step that did exactly the right thing.
  return /['"`][^'"`]*fixtures?\/[^'"`]*['"`]/iu.test(content) &&
    /\breadFileSync\s*\(|\breadFile\s*\(|\bfs\.promises\.readFile\b|\bopen\s*\(|\bPath\s*\(|\bimport\b|\brequire\s*\(/u.test(content);
}

/**
 * Where a Step's tests keep the inputs they read.
 *
 * The same path the Step is instructed to use, stated once so the instruction and the permission
 * cannot disagree. They did: the prompts tell a Step to write `tests/fixtures/<name>` while only the
 * recorded-response subdirectory was writable, so a Step that followed the instruction was refused —
 * and the refusal names a path it was told to use, which leaves it nothing to try. A parser's
 * module tests spent an entire Ticket budget rewriting the same four fixtures into a denial.
 */
export const TEST_FIXTURE_DIR = 'tests/fixtures';

/**
 * Where the captured responses live, so a Step is told the path rather than left to invent one.
 *
 * Derived rather than spelled out: it is one place inside the fixture directory, and two independent
 * spellings of that relationship are how the permission drifted away from the instruction before.
 */
export const RECORDED_FIXTURE_DIR = `${TEST_FIXTURE_DIR}/network`;
