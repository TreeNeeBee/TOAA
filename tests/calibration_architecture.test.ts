import { describe, expect, it } from 'vitest';
import {
  calibrateArchitectureModulePaths,
  calibrateArchitectureStepMappings,
} from '../src/agents/calibration.js';
import { validateArchitectureContract, type ArchitectureDemand } from '../src/core/architecture.js';
import type { ArchitectureModule, Step } from '../src/core/plan.js';

function step(overrides: Partial<Step> & Pick<Step, 'id' | 'phase'>): Step {
  return {
    id: overrides.id,
    iterationId: overrides.iterationId ?? 'P1',
    phase: overrides.phase,
    title: overrides.title ?? 'Step ' + overrides.id,
    description: overrides.description ?? 'Execute one bounded task.',
    systemPrompt: overrides.systemPrompt ?? 'Only produce the declared outputs and keep changes scoped.',
    role: overrides.role ?? 'Coder',
    tools: overrides.tools ?? ['write_file'],
    inputs: overrides.inputs ?? [],
    outputs: overrides.outputs ?? [],
    dependsOn: overrides.dependsOn ?? [],
    acceptance: overrides.acceptance ?? 'Declared outputs exist.',
    maxAttempts: 3,
  };
}

describe('calibrateArchitectureStepMappings', () => {
  it('tracks product runtime assets separately from target-language source files', () => {
    const rawModules: ArchitectureModule[] = [
      {
        id: 'M001',
        name: 'Brief template',
        responsibility: 'Provide the runtime template used to render a report.',
        sourcePaths: ['src/templates/brief.md.hbs'],
        testPaths: ['tests/brief-template.test.ts'],
        dependencies: [],
      },
    ];
    const modules = calibrateArchitectureModulePaths(rawModules, 'typescript');
    expect(modules[0]?.sourcePaths).toEqual([]);
    expect(modules[0]?.assetPaths).toEqual(['src/templates/brief.md.hbs']);

    const steps = calibrateArchitectureStepMappings([
      step({
        id: 'S001',
        phase: 'HIGH_LEVEL_DESIGN',
        role: 'Architect',
        outputs: ['docs/02-high-level-design.md'],
      }),
      step({
        id: 'S002',
        phase: 'CODE',
        outputs: ['src/templates/brief.md.hbs'],
        dependsOn: ['S001'],
      }),
      step({
        id: 'S003',
        phase: 'MODULE_TEST',
        role: 'Tester',
        outputs: ['docs/07-module-test.md'],
        dependsOn: ['S002'],
      }),
    ], modules);

    expect(steps[0]?.outputs).toContain('tests/brief-template.test.ts');
    expect(steps[1]?.subTasks?.[0]?.outputs).toEqual(['src/templates/brief.md.hbs']);
    expect(steps[2]?.inputs).toContain('tests/brief-template.test.ts');
    expect(validateArchitectureContract(modules, steps, 'typescript', {
      nonTrivial: true,
      surfaces: ['io'],
      baselineModules: 0,
      minModules: 1,
      reasonLabel: 'runtime-asset-test',
    })).toEqual([]);
  });

  it('keeps CODE and MODULE_TEST macro steps while adding module subtasks', () => {
    const modules: ArchitectureModule[] = [
      {
        id: 'M001',
        name: 'Holiday',
        responsibility: 'Fetch and calculate holiday data.',
        sourcePaths: ['src/holiday_service.py'],
        testPaths: ['tests/test_holiday_service.py'],
        dependencies: [],
      },
      {
        id: 'M002',
        name: 'Models',
        responsibility: 'Define shared data models.',
        sourcePaths: ['src/models.py'],
        testPaths: ['tests/test_models.py'],
        dependencies: [],
      },
      {
        id: 'M003',
        name: 'CLI',
        responsibility: 'Compose services and print output.',
        sourcePaths: ['src/main.py'],
        testPaths: ['tests/test_cli.py'],
        dependencies: ['M001', 'M002'],
      },
    ];
    const rawSteps = [
      step({ id: 'S001', phase: 'REQUIREMENT_ANALYSIS', role: 'Planner', outputs: ['docs/01-requirement-analysis.md'] }),
      step({ id: 'S002', phase: 'HIGH_LEVEL_DESIGN', role: 'Architect', outputs: ['docs/02-high-level-design.md'], dependsOn: ['S001'] }),
      step({ id: 'S003', phase: 'DETAILED_DESIGN', role: 'Architect', outputs: ['docs/03-detailed-design.md'], dependsOn: ['S002'] }),
      step({
        id: 'S004',
        phase: 'CODE',
        outputs: ['src/holiday_service.py', 'src/models.py'],
        dependsOn: ['S003'],
      }),
      step({ id: 'S005', phase: 'CODE', outputs: ['src/main.py'], dependsOn: ['S004'] }),
      step({
        id: 'S006',
        phase: 'MODULE_TEST',
        role: 'Tester',
        outputs: ['tests/test_holiday_service.py', 'tests/test_models.py'],
        dependsOn: ['S004'],
      }),
      step({ id: 'S007', phase: 'MODULE_TEST', role: 'Tester', outputs: ['tests/test_cli.py'], dependsOn: ['S005'] }),
    ];
    const calibrated = calibrateArchitectureStepMappings(rawSteps, modules);
    const codeSteps = calibrated.filter((item) => item.phase === 'CODE');
    expect(codeSteps.map((item) => item.outputs)).toEqual([
      ['src/holiday_service.py', 'src/models.py'],
      ['src/main.py'],
    ]);
    expect(codeSteps[0]?.subTasks?.map((task) => task.id)).toEqual(['M001', 'M002']);

    const cliStep = codeSteps.find((item) => item.outputs.includes('src/main.py'));
    expect(cliStep?.dependsOn).toEqual(expect.arrayContaining(['S004']));

    const testSteps = calibrated.filter((item) => item.phase === 'MODULE_TEST');
    expect(testSteps.map((item) => item.outputs)).toEqual([
      [],
      [],
    ]);
    expect(calibrated.find((item) => item.phase === 'HIGH_LEVEL_DESIGN')?.outputs).toEqual(
      expect.arrayContaining([
        'tests/test_holiday_service.py',
        'tests/test_models.py',
        'tests/test_cli.py',
      ]),
    );
    expect(testSteps.map((item) => item.inputs)).toEqual([
      ['tests/test_holiday_service.py', 'tests/test_models.py'],
      ['tests/test_cli.py', 'tests/test_holiday_service.py', 'tests/test_models.py'],
    ]);
    expect(testSteps[0]?.subTasks?.map((task) => task.id)).toEqual(['M001', 'M002']);

    const sharedTest = testSteps.find((item) => item.inputs.includes('tests/test_models.py'));
    expect(sharedTest?.dependsOn).toEqual(expect.arrayContaining(['S004']));

    const cliTest = testSteps.find((item) => item.inputs.includes('tests/test_cli.py'));
    expect(cliTest?.dependsOn).toEqual(expect.arrayContaining(['S005']));

    const demand: ArchitectureDemand = {
      nonTrivial: true,
      surfaces: ['cli', 'integration'],
      baselineModules: 0,
      minModules: 3,
      reasonLabel: 'test',
    };
    expect(validateArchitectureContract(modules, calibrated, 'python', demand)).toEqual([]);
  });

  it('infers MODULE_TEST coverage through transitive V-model dependencies', () => {
    const modules: ArchitectureModule[] = [
      {
        id: 'M001',
        name: 'Weather',
        responsibility: 'Fetch and normalize weather forecast data.',
        sourcePaths: ['src/weather_client.py'],
        testPaths: ['tests/test_weather_client.py'],
        dependencies: [],
      },
    ];
    const rawSteps = [
      step({ id: 'S001', phase: 'HIGH_LEVEL_DESIGN', role: 'Architect', outputs: ['docs/02-high-level-design.md'] }),
      step({ id: 'S002', phase: 'CODE', outputs: ['src/weather_client.py'], dependsOn: ['S001'] }),
      step({ id: 'S003', phase: 'UNIT_TEST', role: 'Tester', outputs: ['tests/test_unit_weather.py'], dependsOn: ['S002'] }),
      step({ id: 'S004', phase: 'INTEGRATION_TEST', role: 'Tester', outputs: ['docs/06-integration-test.md'], dependsOn: ['S003'] }),
      step({ id: 'S005', phase: 'MODULE_TEST', role: 'Tester', outputs: ['docs/07-module-test.md'], dependsOn: ['S004'] }),
    ];

    const calibrated = calibrateArchitectureStepMappings(rawSteps, modules);
    const moduleTest = calibrated.find((item) => item.id === 'S005')!;

    expect(calibrated[0]?.outputs).toContain('tests/test_weather_client.py');
    expect(moduleTest.inputs).toContain('tests/test_weather_client.py');
    expect(moduleTest.dependsOn).toContain('S002');
    expect(moduleTest.subTasks?.map((task) => task.id)).toEqual(['M001']);
    expect(validateArchitectureContract(modules, calibrated, 'python', {
      nonTrivial: true,
      surfaces: ['cli', 'integration'],
      baselineModules: 0,
      minModules: 1,
      reasonLabel: 'test',
    })).toEqual([]);
  });

  it('keeps architecture module testPaths owned by HIGH_LEVEL_DESIGN instead of UNIT_TEST', () => {
    const modules: ArchitectureModule[] = [
      {
        id: 'M001',
        name: 'Weather',
        responsibility: 'Fetch and normalize weather forecast data.',
        sourcePaths: ['src/weather_client.py'],
        testPaths: ['tests/test_weather_client.py'],
        dependencies: [],
      },
    ];
    const rawSteps = [
      step({ id: 'S001', phase: 'HIGH_LEVEL_DESIGN', role: 'Architect', outputs: ['docs/02-high-level-design.md'] }),
      step({ id: 'S002', phase: 'CODE', outputs: ['src/weather_client.py'], dependsOn: ['S001'] }),
      step({ id: 'S003', phase: 'UNIT_TEST', role: 'Tester', outputs: ['tests/test_weather_client.py'], dependsOn: ['S002'] }),
      step({ id: 'S004', phase: 'MODULE_TEST', role: 'Tester', outputs: ['docs/07-module-test.md'], dependsOn: ['S003'] }),
    ];

    const calibrated = calibrateArchitectureStepMappings(rawSteps, modules);
    const highLevelDesign = calibrated.find((item) => item.id === 'S001')!;
    const unitTest = calibrated.find((item) => item.id === 'S003')!;
    const moduleTest = calibrated.find((item) => item.id === 'S004')!;

    expect(highLevelDesign.outputs).toContain('tests/test_weather_client.py');
    expect(unitTest.outputs).not.toContain('tests/test_weather_client.py');
    expect(moduleTest.inputs).toContain('tests/test_weather_client.py');
    expect(validateArchitectureContract(modules, calibrated, 'python', {
      nonTrivial: true,
      surfaces: ['cli', 'integration'],
      baselineModules: 0,
      minModules: 1,
      reasonLabel: 'test',
    })).toEqual([]);
  });

  it('moves architecture module testPaths away from INTEGRATION_TEST outputs', () => {
    const modules: ArchitectureModule[] = [
      {
        id: 'M001',
        name: 'IntegrationBoundary',
        responsibility: 'Coordinate external API integration.',
        sourcePaths: ['src/integration.py'],
        testPaths: ['tests/test_integration.py'],
        dependencies: [],
      },
    ];
    const rawSteps = [
      step({ id: 'S001', phase: 'HIGH_LEVEL_DESIGN', role: 'Architect', outputs: ['docs/02-high-level-design.md'] }),
      step({ id: 'S002', phase: 'CODE', outputs: ['src/integration.py'], dependsOn: ['S001'] }),
      step({ id: 'S003', phase: 'UNIT_TEST', role: 'Tester', outputs: ['tests/test_unit_integration.py'], dependsOn: ['S002'] }),
      step({ id: 'S004', phase: 'INTEGRATION_TEST', role: 'Tester', outputs: ['tests/test_integration.py'], dependsOn: ['S003'] }),
      step({ id: 'S005', phase: 'MODULE_TEST', role: 'Tester', outputs: ['docs/07-module-test.md'], dependsOn: ['S004'] }),
    ];

    const calibrated = calibrateArchitectureStepMappings(rawSteps, modules);
    const highLevelDesign = calibrated.find((item) => item.id === 'S001')!;
    const integrationTest = calibrated.find((item) => item.id === 'S004')!;
    const moduleTest = calibrated.find((item) => item.id === 'S005')!;

    expect(highLevelDesign.outputs).toContain('tests/test_integration.py');
    expect(integrationTest.outputs).not.toContain('tests/test_integration.py');
    expect(moduleTest.inputs).toContain('tests/test_integration.py');
    expect(validateArchitectureContract(modules, calibrated, 'python', {
      nonTrivial: true,
      surfaces: ['integration'],
      baselineModules: 0,
      minModules: 1,
      reasonLabel: 'test',
    })).toEqual([]);
  });
});
