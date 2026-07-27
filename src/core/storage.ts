import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PlanSchema, type Plan } from './plan.js';
import { assertPlanValid } from './lint.js';
import { PhasePlanSchema, type PhasePlan } from './phase_plan.js';

function parseLoadedPlan(json: unknown): Plan {
  const plan = PlanSchema.parse(json);
  assertPlanValid(plan);
  return plan;
}

export async function loadPlan(planPath: string): Promise<Plan> {
  const raw = await fs.readFile(planPath, 'utf8');
  return parseLoadedPlan(JSON.parse(raw));
}

export async function savePlan(planPath: string, plan: Plan): Promise<void> {
  PlanSchema.parse(plan); // structural check only; lint runs separately
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
}

export async function loadPhasePlan(phasePlanPath: string): Promise<PhasePlan> {
  const raw = await fs.readFile(phasePlanPath, 'utf8');
  return PhasePlanSchema.parse(JSON.parse(raw));
}

export async function savePhasePlan(phasePlanPath: string, phasePlan: PhasePlan): Promise<void> {
  PhasePlanSchema.parse(phasePlan);
  await fs.mkdir(path.dirname(phasePlanPath), { recursive: true });
  await fs.writeFile(phasePlanPath, JSON.stringify(phasePlan, null, 2) + '\n', 'utf8');
}

export interface LoadedPlanTarget {
  /** The materialized phase plan used by the engine. */
  plan: Plan;
  /** Absolute path to the materialized phase plan file, e.g. plan.P1.json. */
  planPath: string;
  /** Absolute path originally requested by the caller. */
  requestedPath: string;
  /** Top-level phasePlan.json when the caller supplied one. */
  phasePlan?: PhasePlan;
  phasePlanPath?: string;
}

export async function loadPlanTarget(inputPath: string): Promise<LoadedPlanTarget> {
  const requestedPath = path.resolve(inputPath);
  const raw = await fs.readFile(requestedPath, 'utf8');
  const json = JSON.parse(raw);
  const phasePlanResult = PhasePlanSchema.safeParse(json);
  if (phasePlanResult.success) {
    const phasePlan = phasePlanResult.data;
    const phase =
      phasePlan.phases.find((candidate) => candidate.id === phasePlan.currentPhaseId) ??
      phasePlan.phases.find((candidate) => candidate.status === 'current') ??
      phasePlan.phases[0];
    if (!phase?.planPath) {
      throw new Error(`phasePlan ${requestedPath} has no planPath for current phase ${phasePlan.currentPhaseId}`);
    }
    const planPath = path.resolve(path.dirname(requestedPath), phase.planPath);
    const plan = parseLoadedPlan(JSON.parse(await fs.readFile(planPath, 'utf8')));
    return {
      plan,
      planPath,
      requestedPath,
      phasePlan,
      phasePlanPath: requestedPath,
    };
  }

  return { plan: parseLoadedPlan(json), planPath: requestedPath, requestedPath };
}
