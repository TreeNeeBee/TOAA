import type { Plan } from './plan.js';
import { getLanguageProfile } from './language.js';
import { t } from '../i18n/index.js';

export function renderPlanMarkdown(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`# Plan (language: ${plan.language})`);
  lines.push('');
  lines.push(`- Intent: ${plan.intent}`);
  lines.push(`- Project type: ${plan.projectType ?? 'application'}`);
  lines.push(`- Created: ${plan.createdAt}`);
  lines.push(`- Steps: ${plan.steps.length}`);
  lines.push('');
  lines.push('## Requirement digest');
  lines.push('');
  lines.push(plan.requirementDigest);
  lines.push('');
  if (plan.globalPrompt && plan.globalPrompt.trim()) {
    lines.push(t().render.sectionGlobalPrompt);
    lines.push('');
    lines.push('```text');
    lines.push(plan.globalPrompt.trim());
    lines.push('```');
    lines.push('');
  }
  if (plan.complexityAssessment) {
    lines.push('## Complexity assessment');
    lines.push('');
    lines.push(`- Level: ${plan.complexityAssessment.level}`);
    lines.push(`- Split recommended: ${plan.complexityAssessment.splitRecommended ? 'yes' : 'no'}`);
    lines.push(`- User forced phase split: ${plan.complexityAssessment.userForcedPhaseSplit ? 'yes' : 'no'}`);
    lines.push(`- Rationale: ${plan.complexityAssessment.rationale}`);
    lines.push('');
  }
  if ((plan.implementationPhases?.length ?? 0) > 0) {
    lines.push('## Implementation phases');
    lines.push('');
    lines.push('| Phase | Status | Objective | Verification gate | Scope | Deliverables | Depends on |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const phase of plan.implementationPhases ?? []) {
      lines.push(
        `| ${phase.id} ${escapePipe(phase.title)} | ${phase.status} | ${escapePipe(phase.objective)} | ` +
        `${escapePipe(phase.verificationGate?.summary ?? '—')} | ` +
        `${phase.scope.join(', ') || '—'} | ${phase.deliverables.join(', ') || '—'} | ${phase.dependsOn.join(', ') || '—'} |`,
      );
    }
    lines.push('');
  }
  if (plan.dependencies && plan.dependencies.length > 0) {
    lines.push(t().render.sectionDependencies(getLanguageProfile(plan.language).manifestFile));
    lines.push('');
    for (const r of plan.dependencies) lines.push(`- ${r}`);
    lines.push('');
  }
  if (plan.baselineSummary && plan.baselineSummary.trim()) {
    lines.push(t().render.sectionBaselineSummary);
    lines.push('');
    lines.push('```text');
    lines.push(plan.baselineSummary.trim());
    lines.push('```');
    lines.push('');
  }
  if ((plan.architectureModules?.length ?? 0) > 0) {
    lines.push('## Architecture contract');
    lines.push('');
    lines.push('| Module | Responsibility | Source paths | Runtime assets | Test paths | Depends on |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const module of plan.architectureModules ?? []) {
      lines.push(
        `| ${module.id} ${escapePipe(module.name)} | ${escapePipe(module.responsibility)} | ` +
        `${module.sourcePaths.join(', ') || '—'} | ${(module.assetPaths ?? []).join(', ') || '—'} | ` +
        `${module.testPaths.join(', ')} | ${module.dependencies.join(', ') || '—'} |`,
      );
    }
    lines.push('');
  }
  lines.push('## V-model macro workflow');
  lines.push('');
  for (const item of renderMacroWorkflow(plan)) lines.push(item);
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  lines.push('| ID | Iteration | Phase | Role | Title | Outputs | Depends |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of plan.steps) {
    lines.push(
      `| ${s.id} | ${s.iterationId ?? 'P1'} | ${s.phase} | ${s.role} | ${escapePipe(s.title)} | ${s.outputs.join(', ')} | ${
        s.dependsOn.join(', ') || '—'
      } |`,
    );
  }
  lines.push('');
  lines.push('## Detail');
  lines.push('');
  for (const s of plan.steps) {
    lines.push(`### ${s.id} — ${s.title} (${s.iterationId ?? 'P1'} / ${s.phase} / ${s.role})`);
    lines.push('');
    lines.push(s.description);
    lines.push('');
    lines.push(`- Inputs: ${s.inputs.join(', ') || '—'}`);
    lines.push(`- Outputs: ${s.outputs.join(', ')}`);
    lines.push(`- Tools: ${s.tools.join(', ') || '—'}`);
    lines.push(`- Acceptance: ${s.acceptance}`);
    if ((s.subTasks?.length ?? 0) > 0) {
      lines.push('- Subtasks:');
      for (const item of renderSubTasks(s.subTasks ?? [], 1)) lines.push(item);
    }
    lines.push('');
    lines.push(t().render.labelSystemPrompt);
    lines.push('');
    lines.push('```text');
    lines.push(s.systemPrompt.trim());
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

function escapePipe(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function renderMacroWorkflow(plan: Plan): string[] {
  const lines: string[] = [];
  for (const step of plan.steps) {
    lines.push(`- ${step.id} ${step.iterationId ?? 'P1'} ${step.phase}: ${step.title} (${step.role})`);
    if (step.subTasks && step.subTasks.length > 0) {
      lines.push(...renderSubTasks(step.subTasks, 1));
    }
  }
  return lines;
}

function renderSubTasks(tasks: NonNullable<Plan['steps'][number]['subTasks']>, depth: number): string[] {
  const lines: string[] = [];
  const indent = '  '.repeat(depth);
  for (const task of tasks) {
    const outputs = task.outputs && task.outputs.length > 0 ? ` [${task.outputs.join(', ')}]` : '';
    lines.push(`${indent}- ${task.id}: ${task.title}${outputs}`);
    lines.push(`${indent}  ${task.description}`);
    if (task.acceptance) lines.push(`${indent}  Acceptance: ${task.acceptance}`);
    if (task.subTasks && task.subTasks.length > 0) {
      lines.push(...renderSubTasks(task.subTasks, depth + 1));
    }
  }
  return lines;
}
