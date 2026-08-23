import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { runCompile } from '../../src/runtime/build.js';
import type { RuntimeIO, RuntimeInteraction } from '../../src/runtime/io.js';
import { ROLES } from '../../src/core/plan.js';

/**
 * Which role actually spoke, observed from the wire.
 *
 * `build` picks its clients from the router by role name, and nothing downstream carries that name:
 * `router.for(role)` returns a client identified by its *provider*, so a role swap is invisible to
 * every assertion made inside the process. Giving each role its own provider with its own model
 * string turns the choice into something the request itself reports — which is the only way a test
 * can tell a Planner-voiced clarification from a PM-voiced one.
 */
const MODEL_FOR_ROLE = Object.fromEntries(
  ROLES.map((role) => [role, `model-${role.toLowerCase()}`]),
) as Record<(typeof ROLES)[number], string>;

interface Captured {
  model: string;
  prompt: string;
}

/**
 * The shipped example config with only its providers swapped for the loopback server.
 *
 * Hand-writing a minimal config here would be a second, quietly diverging statement of what a valid
 * config is — the first thing to rot when a schema section is added, and it would rot into a test
 * failure that says nothing about the behaviour under test.
 */
async function writeConfig(root: string, baseUrl: string): Promise<string> {
  const example = YAML.parse(await fs.readFile(path.resolve('config.example.yaml'), 'utf8')) as {
    llm: { providers: Record<string, unknown>; roles: Record<string, string[]> };
  };
  example.llm.providers = Object.fromEntries(ROLES.map((role) => [`p_${role}`, {
    type: 'openai',
    api_key: '',
    base_url: baseUrl,
    model: MODEL_FOR_ROLE[role],
    context_window: '128K',
    connect_timeout_ms: 5_000,
    request_timeout_ms: 15_000,
    stream_first_token_timeout_ms: 10_000,
    stream_idle_timeout_ms: 10_000,
  }]));
  example.llm.roles = Object.fromEntries(ROLES.map((role) => [role, [`p_${role}`]]));
  const configPath = path.join(root, 'config.yaml');
  await fs.writeFile(configPath, YAML.stringify(example));
  return configPath;
}

/** A question set that satisfies every clarify validation rule, whichever flags the input trips. */
const CLARIFY_ANSWER = JSON.stringify([
  { id: 'q1', category: 'functionality', question: 'Which operations must the tool support end to end?', why: 'scope', options: [{ label: 'A', answer: 'read only' }, { label: 'B', answer: 'read and write' }] },
  { id: 'q2', category: 'functionality', question: 'Should this ship as a client library, a runnable application, or a mixed deliverable?', why: 'shape', options: [{ label: 'A', answer: 'library' }, { label: 'B', answer: 'application' }] },
  { id: 'q3', category: 'functionality', question: 'Which programming language should implement it: Python or TypeScript on Node.js?', why: 'stack', options: [{ label: 'A', answer: 'Python' }, { label: 'B', answer: 'TypeScript' }] },
  { id: 'q4', category: 'data', question: 'What shape does the input data arrive in?', why: 'parsing', options: [{ label: 'A', answer: 'JSON' }, { label: 'B', answer: 'CSV' }] },
  { id: 'q5', category: 'acceptance', question: 'What observable result counts as a successful run?', why: 'acceptance', options: [{ label: 'A', answer: 'exit code 0' }, { label: 'B', answer: 'a written report' }] },
  { id: 'q6', category: 'boundary', question: 'Do you have an API key or token for the external endpoint, or should it default to a free public open api with no authentication?', why: 'credentials', options: [{ label: 'A', answer: 'I have a key' }, { label: 'B', answer: 'use open no-key APIs' }] },
  { id: 'q7', category: 'quality', question: 'What level of automated test coverage is expected?', why: 'quality bar', options: [{ label: 'A', answer: 'unit only' }, { label: 'B', answer: 'unit and integration' }] },
  { id: 'q8', category: 'extensibility', question: 'Which parts must stay open for later extension?', why: 'growth', options: [{ label: 'A', answer: 'the data sources' }, { label: 'B', answer: 'the output formats' }] },
]);

describe('build speaks to the user as PM', () => {
  let server: Server;
  let baseUrl = '';
  let root = '';
  let captured: Captured[] = [];

  beforeEach(async () => {
    captured = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        // Anything without a chat body — a capability probe, a models listing — is not a role
        // speaking, and must not be recorded as one.
        const request = body.trim().startsWith('{')
          ? JSON.parse(body) as { model?: string; messages?: Array<{ content: string }> }
          : {};
        if (!request.model || !request.messages) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"data":[]}');
          return;
        }
        captured.push({
          model: request.model,
          prompt: request.messages.map((message) => message.content).join('\n'),
        });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: CLARIFY_ANSWER } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-build-role-'));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  /**
   * Stops at Gate 1 with `cancel`: clarify is the subject, and everything after it would drag the
   * whole decompose pipeline into a test about who asks the questions.
   */
  const cancellingIO = (): RuntimeIO => {
    const interaction: RuntimeInteraction = {
      input: async () => 'A',
      confirm: async () => false,
      editor: async () => '',
      select: async <T extends string>(args: { choices: Array<{ value: T }> }) =>
        (args.choices.find((choice) => choice.value === ('cancel' as T))?.value ?? args.choices[0]!.value),
      readMultiline: async () => '',
    };
    return {
      terminalOutput: false,
      permissionPolicy: 'deny',
      emit: () => undefined,
      progress: () => ({ succeed: () => undefined, fail: () => undefined, stop: () => undefined }),
      interaction,
    };
  };

  const run = async () => {
    const configPath = await writeConfig(root, baseUrl);
    const inputFile = path.join(root, 'requirement.md');
    await fs.writeFile(inputFile, 'Build a small tool that summarizes a local text file into a report.\n');
    return runCompile({
      workspace: path.join(root, 'container'),
      name: 'role-wiring',
      configPath,
      inputFile,
      io: cancellingIO(),
    });
  };

  // The role that asks the user to clarify their own project is PM's, not the planner's. A planner
  // negotiating the scope it is about to plan is the executor deciding its own brief; the finding
  // and the follow-up both belong to PM, so the question must come from PM too.
  it('asks its clarification questions with the ProjectManager role', { timeout: 30_000 }, async () => {
    await run();

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]!.model).toBe(MODEL_FOR_ROLE.ProjectManager);
    // Not merely "some PM call happened somewhere": no executing role may speak before Gate 1.
    expect(captured.map((call) => call.model)).not.toContain(MODEL_FOR_ROLE.Planner);
  });

  // The other half of the boundary: PM owns the conversation, not the planning. Routing the whole
  // build through PM would be the same mistake pointed the other way — the role that judges the
  // delivery would also be the role that wrote the plan being judged.
  it('still plans with the Planner role once there is nothing left to ask', { timeout: 30_000 }, async () => {
    const configPath = await writeConfig(root, baseUrl);
    const topicFile = path.join(root, 'topic.md');
    // A topic input is a clarification that already happened; re-asking would discard it.
    await fs.writeFile(topicFile, '# Topic\n\nA frozen, already-clarified topic.\n');

    // Decompose runs against a server that only knows how to answer clarify, so this ends in a
    // parse failure. What it got as far as asking, and in whose voice, is the subject here.
    await runCompile({
      workspace: path.join(root, 'container'),
      name: 'role-wiring-topic',
      configPath,
      topicFile,
      io: cancellingIO(),
    }).catch(() => undefined);

    // Non-empty is the guard that keeps this from passing when the config fails to load at all.
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]!.model).toBe(MODEL_FOR_ROLE.Planner);
    expect(captured.map((call) => call.model)).not.toContain(MODEL_FOR_ROLE.ProjectManager);
  });
});
