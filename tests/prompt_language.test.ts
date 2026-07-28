import { beforeEach, describe, expect, it } from 'vitest';
import { getLanguageProfile } from '../src/core/language.js';
import { setLocale, t } from '../src/i18n/index.js';

describe('language-specific planner/executor prompts', () => {
  beforeEach(() => setLocale('en'));

  it('uses a dedicated TypeScript planner prompt instead of Python-first instructions', () => {
    const prompt = t().prompts.plannerSystem(getLanguageProfile('typescript'));
    expect(prompt).toContain('TypeScript / Node.js only');
    expect(prompt).not.toContain('Output language: Python only');
    expect(prompt).toContain('one HIGH_LEVEL_DESIGN Step output `package.json`');
    expect(prompt).toContain('CODE outputs contain product source/runtime assets');
    expect(prompt).toContain('executable unit tests under tests/');
    expect(prompt).toContain('Right-side test phases must not output tests/ or src/');
    expect(prompt).toContain('Vitest only');
    expect(prompt).toContain('Never request Jest');
    expect(prompt).toContain('allowImportingTsExtensions');
  });

  it('keeps TypeScript StepPlan output ownership explicit in the two-level planner prompt', () => {
    const prompt = t().prompts.plannerPhaseDecomposeSystem(getLanguageProfile('typescript'));
    expect(prompt).toContain('CODE owns unit tests plus product source/runtime assets');
    expect(prompt).toContain('assetPaths is optional and may contain only non-code files under src/');
    expect(prompt).toContain('Do not put test fixtures, sample inputs, temporary outputs, or documentation there.');
    expect(prompt).toContain('HIGH_LEVEL_DESIGN owns module tests and architectureModules.testPaths');
    expect(prompt).toContain('output validation reports/delivery docs only');
    expect(prompt).toContain('HIGH_LEVEL_DESIGN Step must output package.json');
    expect(prompt).toContain('CODE must not output package.json');
    expect(prompt).toContain('"test": "vitest run"');
    expect(prompt).toContain('Do not mention or request Jest');
  });

  it('uses the canonical V-model phases and rollback semantics', () => {
    const py = t().prompts.plannerSystem(getLanguageProfile('python'));
    const ts = t().prompts.plannerSystem(getLanguageProfile('typescript'));
    for (const prompt of [py, ts]) {
      expect(prompt).toContain('REQUIREMENT_ANALYSIS -> HIGH_LEVEL_DESIGN -> DETAILED_DESIGN -> CODE -> UNIT_TEST -> INTEGRATION_TEST -> MODULE_TEST -> FUNCTIONAL_TEST');
      expect(prompt).toContain('Never emit the old phases REQUIREMENT, ARCH, TASK, TEST, REFACTOR, or DELIVERY');
      expect(prompt).toContain('roll back to the paired V-model phase');
    }
  });

  it('describes high-level and detailed design responsibilities', () => {
    const py = t().prompts.plannerSystem(getLanguageProfile('python'));
    const ts = t().prompts.plannerSystem(getLanguageProfile('typescript'));
    expect(py).toContain("current development module's position in the whole system");
    expect(py).toContain('external APIs, third-party library choices, dependency confirmation');
    expect(py).toContain('module-internal functions, data structures, algorithms');
    expect(py).toContain('do not invent parser/export APIs from package names alone');
    expect(ts).toContain('system-level external interfaces and dependencies');
    expect(ts).toContain('module-internal functions, types, data structures');

    setLocale('zh');
    const zh = t().prompts.plannerSystem(getLanguageProfile('python'));
    expect(zh).toContain('当前开发模块在整体系统中的定位');
    expect(zh).toContain('外部 API、第三方库选型、依赖确认');
    expect(zh).toContain('模块内部的具体功能实现和架构');
    expect(zh).toContain('禁止仅凭包名臆造不存在的解析/导出 API');
  });

  it('requires the functional documentation bundle and project type classification', () => {
    const py = t().prompts.plannerSystem(getLanguageProfile('python'));
    const ts = t().prompts.plannerSystem(getLanguageProfile('typescript'));
    for (const prompt of [py, ts]) {
      expect(prompt).toContain('"projectType": "application | library | mixed"');
      expect(prompt).toContain('README.md');
      expect(prompt).toContain('docs/quickstart.md');
      expect(prompt).toContain('docs/08-functional-test.md');
      expect(prompt).toContain('docs/api-guide.md');
      expect(prompt).toContain('There is no CLI project-type override');
    }

    setLocale('zh');
    const zh = t().prompts.plannerSystem(getLanguageProfile('typescript'));
    expect(zh).toContain('"projectType": "application | library | mixed"');
    expect(zh).toContain('README.md');
    expect(zh).toContain('docs/quickstart.md');
    expect(zh).toContain('docs/08-functional-test.md');
    expect(zh).toContain('docs/api-guide.md');
    expect(zh).toContain('不存在命令行 project-type 覆盖');
  });

  it('requires macro Step subtasks and planned executable implementation iterations', () => {
    const py = t().prompts.plannerSystem(getLanguageProfile('python'));
    const ts = t().prompts.plannerSystem(getLanguageProfile('typescript'));
    for (const prompt of [py, ts]) {
      expect(prompt).toContain('subTasks');
      expect(prompt).toContain('complexityAssessment');
      expect(prompt).toContain('implementationPhases');
      expect(prompt).toContain('moderate => at least P1+P2');
      expect(prompt).toContain('complex => at least P1+P2+P3');
      expect(prompt).toContain('verificationGate');
      expect(prompt).toContain('Feed failures to Debugger');
      expect(prompt).toContain('docs/iterations/<iterationId>/');
      expect(prompt).not.toContain('at least 7 Steps');
    }

    setLocale('zh');
    const zh = t().prompts.plannerSystem(getLanguageProfile('python'));
    expect(zh).toContain('subTasks');
    expect(zh).toContain('implementationPhases');
    expect(zh).toContain('moderate => 至少 P1+P2');
    expect(zh).toContain('complex => 至少 P1+P2+P3');
    expect(zh).toContain('verificationGate');
    expect(zh).toContain('把失败日志传给 Debugger');
    expect(zh).toContain('docs/iterations/<iterationId>/');
    expect(zh).not.toContain('至少 7 个 Step');
  });

  it('provides a self-bootstrap override that preserves existing entrypoints and manifests', () => {
    const prompt = t().prompts.plannerSelfMode;
    expect(prompt).toContain('SELF-BOOTSTRAP OVERRIDE');
    expect(prompt).toContain('Do not create src/main.ts');
    expect(prompt).toContain('package.json');
  });

  it('uses a dedicated TypeScript executor prompt instead of Python import rules', () => {
    const prompt = t().prompts.executorSystem(getLanguageProfile('typescript'));
    expect(prompt).toContain('TypeScript / Node.js best practice');
    expect(prompt).toContain('ESM relative imports with explicit ".ts" specifiers');
    expect(prompt).toContain("Node's native TypeScript type stripping");
    expect(prompt).toContain('Never call `new Date()` / `date.today()` while hard-coding a calendar year');
    expect(prompt).not.toContain('sys.path.insert');
  });

  it('keeps executor chunking guidance tied to runtime limits rather than fixed bytes', () => {
    const py = t().prompts.executorSystem(getLanguageProfile('python'));
    const ts = t().prompts.executorSystem(getLanguageProfile('typescript'));
    expect(py).toContain("current Step's runtime chunk limit");
    expect(ts).toContain("current Step's runtime chunk limit");
    expect(py).toContain('separate CODE/UNIT_TEST/INTEGRATION_TEST/MODULE_TEST/FUNCTIONAL_TEST Steps');
    expect(ts).toContain('separate CODE/UNIT_TEST/INTEGRATION_TEST/MODULE_TEST/FUNCTIONAL_TEST Steps');
    expect(py).not.toContain('6000 bytes');
    expect(ts).not.toContain('6000 bytes');
  });

  it('keeps Python-specific executor guidance for Python projects', () => {
    const prompt = t().prompts.executorSystem(getLanguageProfile('python'));
    expect(prompt).toContain('sys.path.insert');
    expect(prompt).toContain('The concatenated result must be valid Python');
  });

  it('requires a function-majority multi-dimensional clarification set', () => {
    const prompt = t().prompts.plannerClarify('Build a platform.', { complex: true });
    expect(prompt).toContain('8-10');
    expect(prompt).toContain('At least 5 function-focused questions');
    expect(prompt).toContain('At least one boundary question');
    expect(prompt).toContain('At least one quality question');
    expect(prompt).toContain('At least one extensibility question');
    expect(prompt).toContain('API library/SDK/package');
    expect(prompt).toContain('2-5 feasible answer options');
    expect(prompt).toContain('option count is not fixed');
    expect(prompt).toContain('A-B, A-C, A-D, or A-E');
    expect(prompt).toContain('custom free-form answer');
    expect(prompt).toContain('external APIs, URLs, or third-party data sources');
    expect(prompt).toContain('no-key/no-token');
  });

  it('adds an explicit project-shape clarification when the topic is ambiguous', () => {
    const prompt = t().prompts.plannerClarify('Build an API for weather data.', {
      complex: true,
      projectShapeAmbiguous: true,
    });
    expect(prompt).toContain('Required for this topic');
    expect(prompt).toContain('API library vs runnable application vs mixed-deliverable');
  });

  it('keeps the same clarification dimensions in the Chinese prompt', () => {
    setLocale('zh');
    const prompt = t().prompts.plannerClarify('构建复杂业务平台', { complex: true });
    expect(prompt).toContain('8-10');
    expect(prompt).toContain('至少 5 个功能性问题');
    expect(prompt).toContain('至少 1 个 boundary');
    expect(prompt).toContain('至少 1 个 quality');
    expect(prompt).toContain('至少 1 个 extensibility');
    expect(prompt).toContain('API library/SDK/软件包');
    expect(prompt).toContain('可运行应用/CLI/服务');
    expect(prompt).toContain('2-5 个可行回答设定');
    expect(prompt).toContain('选项数量不是固定值');
    expect(prompt).toContain('A-B、A-C、A-D 或 A-E');
    expect(prompt).toContain('自定义回答内容');
    expect(prompt).toContain('外部 API/URL/第三方数据源');
    expect(prompt).toContain('免 key/token');
  });
});
