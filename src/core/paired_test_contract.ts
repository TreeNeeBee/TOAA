import path from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import {
  V_MODEL_DEVELOPMENT_PHASES,
  type ArchitectureModule,
  type Plan,
  type Step,
} from './plan.js';
import type { StageQualityAssessment } from './quality_gate.js';
import { isExecutableTestPath } from './test_assets.js';

export interface PairedSourceTestInspection {
  ok: boolean;
  testPaths: string[];
  valid: string[];
  invalid: string[];
  references: Record<string, string[]>;
}

export function mergePairedSourceTestQuality(
  assessment: StageQualityAssessment,
  inspection: PairedSourceTestInspection,
): StageQualityAssessment {
  if (inspection.ok) return assessment;
  const remediation =
    'Rewrite the invalid test to import and exercise the declared product modules. Before CODE, ' +
    'imports may target planned source paths that do not exist yet. Do not create src/** stubs or ' +
    'product implementations during requirement/design phases, and do not duplicate product ' +
    'behavior inside tests.';
  return {
    ...assessment,
    evidence: dedup([...assessment.evidence, ...inspection.testPaths]),
    findings: [
      ...(assessment.findings ?? []),
      ...inspection.invalid.map((failure) => ({
        category: 'test-incomplete' as const,
        summary: `Paired baseline test contract is incomplete: ${failure}`,
        evidence: [failure, remediation],
        target: 'current-step' as const,
        affectedArtifacts: [failure.split(':', 1)[0] ?? failure],
        dependencyPackages: [],
      })),
    ],
  };
}

/**
 * Left-side V-model tests must exercise a planned product module. Merely
 * declaring local stand-ins in a test produces a false-positive gate after
 * CODE, so this contract is checked both when tests are authored and consumed.
 */
export async function inspectPairedSourceTests(
  workspace: Workspace,
  plan: Plan,
  sourceStep: Step,
): Promise<PairedSourceTestInspection> {
  if (!V_MODEL_DEVELOPMENT_PHASES.includes(
    sourceStep.phase as (typeof V_MODEL_DEVELOPMENT_PHASES)[number],
  )) {
    return { ok: true, testPaths: [], valid: [], invalid: [], references: {} };
  }

  const testPaths = sourceStep.outputs
    .map(normalizePath)
    .filter((output) => isExecutableTestPath(output, plan.language));
  if (testPaths.length === 0) {
    return { ok: true, testPaths: [], valid: [], invalid: [], references: {} };
  }
  const valid: string[] = [];
  const invalid: string[] = [];
  const references: Record<string, string[]> = {};
  const contractDocuments = await developmentContractDocuments(workspace, sourceStep);
  const requiredContractIdentifiers = sourceStep.phase === 'REQUIREMENT_ANALYSIS'
    ? extractRequiredContractIdentifiers(contractDocuments)
    : [];
  const controlledDataStrategyDeclared = declaresControlledTestData(contractDocuments);

  for (const testPath of testPaths) {
    if (!(await workspace.exists(testPath))) {
      invalid.push(`${testPath}: paired test file is missing`);
      references[testPath] = [];
      continue;
    }
    const content = await workspace.readFile(testPath).catch(() => '');
    const owners = ownersForTest(plan, sourceStep, testPath);
    const ownedSources = owners.flatMap((owner) => owner.sourcePaths);
    const expectedSources = dedup(
      ownedSources.length > 0
        ? ownedSources
        : fallbackSourcePaths(plan, sourceStep),
    );
    if (expectedSources.length === 0) {
      valid.push(testPath);
      references[testPath] = [];
      continue;
    }
    const matched = plan.language === 'typescript'
      ? typescriptProductReferences(testPath, content, expectedSources)
      : pythonProductReferences(content, expectedSources);
    references[testPath] = matched;
    const requiredReferences = sourceStep.phase === 'DETAILED_DESIGN'
      ? Math.min(2, expectedSources.length)
      : 1;
    const behaviorRisks = sourceStep.phase === 'DETAILED_DESIGN'
      ? duplicatedIntegrationBehavior(content, plan.language)
      : [];
    const contractAlignmentRisks = sourceStep.phase === 'REQUIREMENT_ANALYSIS'
      ? requirementTestAlignmentRisks(content, plan.language, requiredContractIdentifiers)
      : [];
    const reproducibilityRisks = controlledDataStrategyDeclared
      ? controlledExternalDataRisks(content, plan.language)
      : [];
    if (
      matched.length >= requiredReferences &&
      behaviorRisks.length === 0 &&
      contractAlignmentRisks.length === 0 &&
      reproducibilityRisks.length === 0
    ) {
      valid.push(testPath);
      continue;
    }

    const ownerLabel = owners.length > 0
      ? owners.map((owner) => owner.id).join(', ')
      : sourceStep.id;
    if (matched.length < requiredReferences) {
      invalid.push(
        `${testPath}: exercises ${matched.length}/${requiredReferences} required declared product sources for ${ownerLabel}` +
        ` (expected one of: ${expectedSources.join(', ')})`,
      );
    }
    invalid.push(...behaviorRisks.map((risk) => `${testPath}: ${risk}`));
    invalid.push(...contractAlignmentRisks.map((risk) => `${testPath}: ${risk}`));
    invalid.push(...reproducibilityRisks.map((risk) => `${testPath}: ${risk}`));
  }

  return {
    ok: invalid.length === 0,
    testPaths,
    valid,
    invalid,
    references,
  };
}

async function developmentContractDocuments(
  workspace: Workspace,
  sourceStep: Step,
): Promise<string> {
  const paths = sourceStep.outputs
    .map(normalizePath)
    .filter((output) => /(?:^|\/)docs\/.+\.md$/iu.test(output));
  const contents = await Promise.all(paths.map(async (documentPath) =>
    await workspace.exists(documentPath)
      ? workspace.readFile(documentPath).catch(() => '')
      : '',
  ));
  return contents.filter(Boolean).join('\n\n');
}

/** Extract machine-readable required fields from ordinary Markdown contract tables. */
function extractRequiredContractIdentifiers(content: string): string[] {
  const identifiers: string[] = [];
  const headings = new Set(['field', 'name', 'property', 'parameter', '字段', '名称', '属性', '参数']);
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim().replace(/^`|`$/gu, ''));
    const identifier = cells[0] ?? '';
    if (!/^[A-Za-z_$][\w$]*$/u.test(identifier) || headings.has(identifier.toLowerCase())) continue;
    if (!cells.slice(1).some((cell) => /^(?:yes|true|required|mandatory|是|必填)$/iu.test(cell))) continue;
    identifiers.push(identifier);
  }
  return dedup(identifiers);
}

function requirementTestAlignmentRisks(
  content: string,
  language: Plan['language'],
  requiredIdentifiers: string[],
): string[] {
  if (requiredIdentifiers.length === 0) return [];
  const missing = requiredIdentifiers.filter((identifier) => !containsIdentifier(content, identifier));
  const duplicatedShape = language === 'typescript'
    ? duplicatedRequiredTypeShape(content, requiredIdentifiers)
    : [];
  if (missing.length === 0 && duplicatedShape.length === 0) return [];
  return [
    [
      missing.length > 0
        ? `does not assert required contract identifier(s): ${missing.join(', ')}`
        : '',
      duplicatedShape.length > 0
        ? `redeclares the product contract locally (${duplicatedShape.join(', ')}) instead of importing its type`
        : '',
    ].filter(Boolean).join('; '),
  ];
}

function duplicatedRequiredTypeShape(content: string, requiredIdentifiers: string[]): string[] {
  const declarations = [
    ...content.matchAll(/\binterface\s+([A-Za-z_$][\w$]*)[^{]*\{([\s\S]*?)\}/gu),
    ...content.matchAll(/\btype\s+([A-Za-z_$][\w$]*)\s*=\s*\{([\s\S]*?)\}/gu),
  ];
  return declarations.flatMap((match) => {
    const body = match[2] ?? '';
    const overlap = requiredIdentifiers.filter((identifier) => containsIdentifier(body, identifier));
    const threshold = Math.max(2, Math.ceil(requiredIdentifiers.length / 2));
    return overlap.length >= threshold ? [match[1] ?? 'anonymous contract'] : [];
  });
}

function declaresControlledTestData(content: string): boolean {
  return /\b(?:mocks?|fixtures?|stubs?|cassettes?|record\s*\/?\s*replay)\b|模拟|夹具|录制\s*\/?\s*回放/iu.test(content);
}

function controlledExternalDataRisks(content: string, language: Plan['language']): string[] {
  if (hasDeterministicExternalDataControl(content, language)) return [];
  const calls = language === 'typescript'
    ? importedNoArgumentAwaitCalls(content)
    : [];
  if (calls.length === 0) return [];
  return [
    `declares controlled Mock/Fixture/Record-Replay data but directly awaits product call(s) ` +
      `${calls.join(', ')} without an executable isolation mechanism`,
  ];
}

function hasDeterministicExternalDataControl(content: string, language: Plan['language']): boolean {
  if (language === 'python') {
    return /\b(?:monkeypatch|requests_mock|responses\.|respx\.|vcr\.use_cassette|unittest\.mock|patch\s*\()/u.test(content);
  }
  return /\bvi\.(?:mock|doMock|fn|spyOn|stubGlobal|hoisted)\s*\(|\b(?:mockImplementation|mockResolvedValue|mockRejectedValue)\s*\(|\b(?:MockAgent|nock|msw|setupServer)\b/u.test(content) ||
    /(?:^|\n)\s*import\s+[^\n]*\s+from\s+["'][^"']*(?:fixtures?|record-replay)[^"']*["']/iu.test(content);
}

function importedNoArgumentAwaitCalls(content: string): string[] {
  const imports = [...content.matchAll(
    /^\s*import\s+(?!type\b)([^'"\n]*?)\s+from\s+["'](?:\.\.\/)+src\/[^"']+["']\s*;?/gmu,
  )];
  const bindings = dedup(imports.flatMap((match) => typescriptImportBindings(match[1] ?? '')));
  const body = stripCommentsAndStrings(content);
  return bindings.filter((binding) => {
    const escaped = binding.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`\\bawait\\s+${escaped}\\s*\\(\\s*\\)`, 'u').test(body);
  });
}

function duplicatedIntegrationBehavior(content: string, language: Plan['language']): string[] {
  const code = stripCommentsAndStrings(content);
  const hasLoop = language === 'typescript'
    ? /\b(?:for\s*(?:await\s*)?\(|while\s*\()/u.test(code)
    : /^\s*(?:async\s+)?(?:for|while)\b/mu.test(code);
  const hasFailurePolicy = language === 'typescript'
    ? /\btry\s*\{|\bcatch\s*(?:\([^)]*\))?\s*\{/u.test(code)
    : /^\s*(?:try|except)\s*(?::|\b)/mu.test(code);
  if (!hasLoop || !hasFailurePolicy) return [];
  return [
    'duplicates orchestration/failure-handling control flow inside the integration test; ' +
      'invoke the real product orchestration or entry boundary and mock only its external collaborators',
  ];
}

function ownersForTest(
  plan: Plan,
  sourceStep: Step,
  testPath: string,
): ArchitectureModule[] {
  if (sourceStep.phase !== 'HIGH_LEVEL_DESIGN') return [];
  return (plan.architectureModules ?? []).filter((module) =>
    module.testPaths.some((candidate) => normalizePath(candidate) === testPath),
  );
}

function fallbackSourcePaths(plan: Plan, sourceStep: Step): string[] {
  const iterationId = sourceStep.iterationId ?? 'P1';
  const architectureSources = (plan.architectureModules ?? [])
    .flatMap((module) => module.sourcePaths);
  if (architectureSources.length > 0) return architectureSources;
  return plan.steps
    .filter((step) =>
      (step.iterationId ?? 'P1') === iterationId &&
      step.phase === 'CODE')
    .flatMap((step) => step.outputs)
    .map(normalizePath)
    .filter((output) => output.startsWith('src/'));
}

function typescriptProductReferences(
  testPath: string,
  content: string,
  expectedSources: string[],
): string[] {
  const imports = [...content.matchAll(
    /^\s*import\s+(?!type\b)([^'"\n]*?)\s+from\s+["']([^"']+)["']\s*;?/gmu,
  )].map((match) => ({
    declaration: match[0],
    bindings: typescriptImportBindings(match[1] ?? ''),
    source: resolveTypeScriptSpecifier(testPath, match[2] ?? ''),
  }));
  const body = stripCommentsAndStrings(
    imports.reduce(
      (current, entry) => current.replace(entry.declaration, ''),
      content,
    ),
  );
  const dynamicImports = [...content.matchAll(
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  )]
    .map((match) => resolveTypeScriptSpecifier(testPath, match[1] ?? ''))
    .filter((candidate): candidate is string => !!candidate);
  const executablePathReferences = hasProcessExecution(content)
    ? expectedSources.filter((source) => containsPathLiteral(content, source))
    : [];

  return dedup(expectedSources.filter((source) =>
    imports.some((entry) =>
      !!entry.source &&
      sameModulePath(entry.source, source) &&
      entry.bindings.some((binding) => containsIdentifier(body, binding))) ||
    dynamicImports.some((candidate) => sameModulePath(candidate, source)) ||
    executablePathReferences.includes(source),
  ));
}

function pythonProductReferences(
  content: string,
  expectedSources: string[],
): string[] {
  const imports = [
    ...[...content.matchAll(
      /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+([^\n#]+)/gmu,
    )].map((match) => ({
      declaration: match[0],
      module: match[1] ?? '',
      bindings: pythonImportedBindings(match[2] ?? ''),
    })),
    ...[...content.matchAll(
      /^\s*import\s+([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_]\w*))?/gmu,
    )].map((match) => ({
      declaration: match[0],
      module: match[1] ?? '',
      bindings: [match[2] ?? (match[1] ?? '').split('.')[0] ?? ''].filter(Boolean),
    })),
  ];
  const body = stripCommentsAndStrings(
    imports.reduce(
      (current, entry) => current.replace(entry.declaration, ''),
      content,
    ),
  );
  const executablePathReferences = hasProcessExecution(content)
    ? expectedSources.filter((source) => containsPathLiteral(content, source))
    : [];

  return dedup(expectedSources.filter((source) => {
    const expectedModules = pythonModuleNames(source);
    return imports.some((entry) =>
      expectedModules.some((expected) =>
        entry.module === expected ||
        entry.module.startsWith(`${expected}.`) ||
        expected.startsWith(`${entry.module}.`),
      ) &&
      entry.bindings.some((binding) => containsIdentifier(body, binding)),
    ) || executablePathReferences.includes(source);
  }));
}

function typescriptImportBindings(clause: string): string[] {
  const bindings: string[] = [];
  const defaultBinding = clause.match(/^\s*([A-Za-z_$][\w$]*)/u)?.[1];
  if (defaultBinding) bindings.push(defaultBinding);
  const namespaceBinding = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/u)?.[1];
  if (namespaceBinding) bindings.push(namespaceBinding);
  const named = clause.match(/\{([^}]*)\}/u)?.[1] ?? '';
  for (const item of named.split(',')) {
    const normalized = item.trim();
    if (normalized.startsWith('type ')) continue;
    const local = normalized.match(
      /^[A-Za-z_$][\w$]*(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u,
    );
    if (!local) continue;
    bindings.push(local[1] ?? normalized);
  }
  return dedup(bindings);
}

function pythonImportedBindings(clause: string): string[] {
  return dedup(clause.split(',').map((item) => {
    const parts = item.trim().split(/\s+as\s+/u);
    return (parts[1] ?? parts[0] ?? '').trim();
  }).filter(Boolean));
}

function containsIdentifier(content: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'u').test(content);
}

function stripCommentsAndStrings(content: string): string {
  let result = '';
  let state: 'code' | 'single' | 'double' | 'template' | 'line' | 'block' = 'code';
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    const next = content[index + 1];
    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
        result += '\n';
      } else {
        result += ' ';
      }
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        result += '  ';
        index += 1;
        state = 'code';
      } else {
        result += char === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (state !== 'code') {
      result += char === '\n' ? '\n' : ' ';
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (
        (state === 'single' && char === "'") ||
        (state === 'double' && char === '"') ||
        (state === 'template' && char === '`')
      ) {
        state = 'code';
      }
      continue;
    }
    if (char === '/' && next === '/') {
      result += '  ';
      index += 1;
      state = 'line';
    } else if (char === '/' && next === '*') {
      result += '  ';
      index += 1;
      state = 'block';
    } else if (char === "'") {
      result += ' ';
      state = 'single';
    } else if (char === '"') {
      result += ' ';
      state = 'double';
    } else if (char === '`') {
      result += ' ';
      state = 'template';
    } else if (char === '#') {
      result += ' ';
      state = 'line';
    } else {
      result += char;
    }
  }
  return result;
}

function resolveTypeScriptSpecifier(testPath: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) {
    return normalizePath(path.posix.join(path.posix.dirname(testPath), specifier));
  }
  return specifier.startsWith('src/') ? normalizePath(specifier) : undefined;
}

function pythonModuleNames(source: string): string[] {
  let module = normalizePath(source)
    .replace(/^src\//u, '')
    .replace(/\.py$/u, '')
    .replace(/\/__init__$/u, '')
    .replaceAll('/', '.');
  if (!module) module = '__init__';
  return dedup([module, `src.${module}`]);
}

function hasProcessExecution(content: string): boolean {
  return /\b(execSync|execFileSync|spawnSync|spawn|fork|subprocess|runpy)\b/u.test(content);
}

function containsPathLiteral(content: string, source: string): boolean {
  const normalized = normalizePath(source);
  return content.includes(normalized) ||
    content.includes(normalized.replace(/\.(?:[cm]?[jt]s|py)$/u, ''));
}

function sameModulePath(left: string, right: string): boolean {
  const stripExtension = (value: string) =>
    normalizePath(value).replace(/\.(?:[cm]?[jt]s|py)$/u, '');
  return stripExtension(left) === stripExtension(right);
}

function normalizePath(value: string): string {
  return path.posix.normalize(value.replaceAll('\\', '/').replace(/^\.\/+/u, ''));
}

function dedup(values: string[]): string[] {
  return [...new Set(values)];
}
