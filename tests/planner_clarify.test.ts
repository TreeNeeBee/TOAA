import { describe, expect, it } from 'vitest';
import { Planner } from '../src/agents/planner.js';
import type { ChatMessage, ChatOptions, LLMClient } from '../src/llm/types.js';

function fakeLLM(reply: string): LLMClient {
  return {
    name: 'fake',
    async chat(_messages: ChatMessage[], options?: ChatOptions): Promise<string> {
      // 模拟 router：质量校验失败时 provider 会被切换。
      if (options?.validate) options.validate(reply);
      return reply;
    },
  };
}

const options = [
  { label: 'A', answer: 'Use the recommended default setting for the first release.' },
  { label: 'B', answer: 'Use a stricter setting that requires explicit user confirmation.' },
];

const withOptions = <T extends object>(question: T): T & { options: typeof options } => ({
  ...question,
  options,
});

const standardQuestions = [
  { id: 'Q1', category: 'functionality', question: 'Who is the primary user of this capability?', why: 'Determines actors and permissions.' },
  { id: 'Q2', category: 'data', question: 'What input fields are mandatory for one request?', why: 'Defines the input contract.' },
  { id: 'Q3', category: 'acceptance', question: 'Which concrete example must pass acceptance?', why: 'Defines observable completion.' },
  { id: 'Q4', category: 'boundary', question: 'Which adjacent workflow is explicitly out of scope?', why: 'Prevents scope expansion.' },
  { id: 'Q5', category: 'quality', question: 'What response latency is required at peak load?', why: 'Sets a measurable quality gate.' },
  { id: 'Q6', category: 'extensibility', question: 'Which future business variant is most likely next?', why: 'Keeps the correct extension seam.' },
  { id: 'Q7', category: 'functionality', question: 'What failure behaviour should the primary user observe?', why: 'Defines the functional error path.' },
].map(withOptions);

describe('Planner.clarify — multi-dimensional quality gate', () => {
  it('accepts a function-first seven-question set', async () => {
    const p = new Planner(fakeLLM(JSON.stringify(standardQuestions)));
    const questions = await p.clarify('Create a small customer lookup CLI application.');
    expect(questions).toHaveLength(7);
    expect(questions[0]).toMatchObject({ id: 'Q1', category: 'functionality' });
    expect(questions[0]?.options.map((option) => option.label)).toEqual(['A', 'B']);
    expect(questions[5]?.why).toContain('extension seam');
  });

  it('accepts the {questions:[...]} wrapper and normalizes category aliases', async () => {
    const aliased = standardQuestions.map((question) => ({ ...question }));
    aliased[3]!.category = 'scope';
    aliased[4]!.category = 'performance';
    const p = new Planner(fakeLLM(JSON.stringify({ questions: aliased })));
    const questions = await p.clarify('Create a small customer lookup CLI application.');
    expect(questions[3]?.category).toBe('boundary');
    expect(questions[4]?.category).toBe('quality');
  });

  it('recognizes project-shape clarification from prioritized option answers', async () => {
    const questionsWithProjectShapeOptions = standardQuestions.map((question) => ({ ...question }));
    questionsWithProjectShapeOptions[3] = {
      id: 'Q4',
      category: 'boundary',
      question: '你希望这个程序最终以什么形态交付给使用者？',
      why: '这会决定项目结构和交付边界。',
      options: [
        { label: 'A', answer: '作为可直接运行的 CLI 应用交付。' },
        { label: 'B', answer: '作为可复用的 API library 软件包交付。' },
        { label: 'C', answer: '采用应用与公共 API 并存的混合形态。' },
      ],
    };

    const p = new Planner(fakeLLM(JSON.stringify(questionsWithProjectShapeOptions)));
    await expect(p.clarify('Build a customer lookup capability.')).resolves.toHaveLength(7);
  });

  it('rejects empty or underspecified question sets so fallback can regenerate them', async () => {
    await expect(new Planner(fakeLLM('[]')).clarify('x')).rejects.toThrow(/no questions/);
    await expect(
      new Planner(fakeLLM(JSON.stringify(standardQuestions.slice(0, 3)))).clarify('x'),
    ).rejects.toThrow(/expected 7-10 unique questions/);
  });

  it('rejects legacy questions without category and rationale', async () => {
    const legacy = standardQuestions.map(({ id, question }) => ({ id, question }));
    await expect(
      new Planner(fakeLLM(JSON.stringify(legacy))).clarify('Create a command.'),
    ).rejects.toThrow(/valid category/);
  });

  it('rejects clarification questions without prioritized answer options', async () => {
    const withoutOptions = standardQuestions.map(({ options: _options, ...question }) => question);
    await expect(
      new Planner(fakeLLM(JSON.stringify(withoutOptions))).clarify('Create a command.'),
    ).rejects.toThrow(/2-5 prioritized answer options/);
  });

  it('rejects duplicate questions after normalization', async () => {
    const duplicated = [...standardQuestions, { ...standardQuestions[0]!, id: 'Q7', question: 'Who is the primary user of this capability？' }];
    await expect(
      new Planner(fakeLLM(JSON.stringify(duplicated))).clarify('Create a command.'),
    ).rejects.toThrow(/duplicate or empty questions/);
  });

  it('requires one additional function-focused question for a complex topic', async () => {
    const topic = 'Build a complex API platform with CLI, database persistence, import/export and a dashboard.';
    await expect(
      new Planner(fakeLLM(JSON.stringify(standardQuestions))).clarify(topic),
    ).rejects.toThrow(/expected 8-10 unique questions/);

    const deepQuestions = [
      ...standardQuestions,
      withOptions({ id: 'Q8', category: 'functionality', question: 'What state transition completes the main workflow?', why: 'Defines the core lifecycle.' }),
    ];
    await expect(
      new Planner(fakeLLM(JSON.stringify(deepQuestions))).clarify(topic),
    ).resolves.toHaveLength(8);
  });
});
