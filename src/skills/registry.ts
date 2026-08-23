import { readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Tool } from '../tools/types.js';
import { activateSkill, readSkillMetadata } from './parser.js';
import { defaultBuiltinSkillsRoot } from './paths.js';
import {
  AgentSkillError,
  type ActivatedAgentSkill,
  type AgentSkillMetadata,
  type ResolvedSkills,
  type SkillSource,
} from './types.js';

export class SkillRegistry {
  private readonly skills = new Map<string, AgentSkillMetadata>();
  private readonly activated = new Map<string, ActivatedAgentSkill>();

  registerDirectory(directory: string, source: SkillSource): AgentSkillMetadata[] {
    let root: string;
    try {
      root = realpathSync(path.resolve(directory));
    } catch (error) {
      throw new AgentSkillError('skill-resource-invalid', `Cannot access Agent Skills directory ${directory}`, {
        directory,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const directories = discoverSkillDirectories(root);
    if (directories.length === 0) {
      throw new AgentSkillError('skill-resource-invalid', `No SKILL.md found under ${root}`, { root });
    }
    return directories.map((skillDirectory) => this.register(readSkillMetadata(skillDirectory, source)));
  }

  register(skill: AgentSkillMetadata): AgentSkillMetadata {
    const existing = this.skills.get(skill.name);
    if (existing) {
      throw new AgentSkillError('skill-duplicate', `Agent Skill "${skill.name}" is already registered`, {
        existing: existing.skillPath,
        duplicate: skill.skillPath,
      });
    }
    this.skills.set(skill.name, skill);
    return skill;
  }

  get(name: string): AgentSkillMetadata | undefined {
    return this.skills.get(name);
  }

  activate(name: string): ActivatedAgentSkill {
    const existing = this.activated.get(name);
    if (existing) return existing;
    const metadata = this.skills.get(name);
    if (!metadata) throw new AgentSkillError('skill-not-found', `Unknown Agent Skill "${name}"`, { name });
    const skill = activateSkill(metadata);
    this.activated.set(name, skill);
    return skill;
  }

  resolve(refs: readonly string[]): ResolvedSkills {
    const tools: string[] = [];
    const activatedSkills: ActivatedAgentSkill[] = [];
    const seenTools = new Set<string>();
    const seenSkills = new Set<string>();
    for (const ref of refs) {
      if (!ref.startsWith('skill:')) {
        if (!seenTools.has(ref)) {
          seenTools.add(ref);
          tools.push(ref);
        }
        continue;
      }
      const name = ref.slice('skill:'.length);
      if (seenSkills.has(name)) continue;
      seenSkills.add(name);
      const skill = this.activate(name);
      activatedSkills.push(skill);
      for (const tool of skill.allowedTools) {
        if (!seenTools.has(tool)) {
          seenTools.add(tool);
          tools.push(tool);
        }
      }
    }
    return {
      resolvedToolNames: tools,
      activatedSkills,
      hints: activatedSkills.map(renderActivatedSkill),
    };
  }

  validateTools(tools: readonly Tool[]): void {
    const known = new Set(tools.map((tool) => tool.name));
    for (const skill of this.skills.values()) {
      for (const tool of skill.allowedTools) {
        if (!known.has(tool)) {
          throw new AgentSkillError('skill-tool-missing', `Agent Skill "${skill.name}" references unknown tool "${tool}"`, {
            skill: skill.name,
            tool,
          });
        }
      }
    }
  }

  /** Validate plan references from metadata without activating Skill instructions. */
  validateRefs(refs: readonly string[]): void {
    for (const ref of refs) {
      if (!ref.startsWith('skill:')) continue;
      const name = ref.slice('skill:'.length);
      if (!name || !this.skills.has(name)) {
        throw new AgentSkillError('skill-not-found', `Unknown Agent Skill "${name || ref}"`, { ref, name });
      }
    }
  }

  list(): AgentSkillMetadata[] {
    return [...this.skills.values()];
  }
}

export function buildDefaultSkills(root = defaultBuiltinSkillsRoot()): SkillRegistry {
  const registry = new SkillRegistry();
  registry.registerDirectory(root, { kind: 'builtin' });
  return registry;
}

export function renderActivatedSkill(skill: ActivatedAgentSkill): string {
  return `## Agent Skill: ${skill.name}\n${skill.instructions}`;
}

/** Level-one progressive disclosure for planning: metadata only, never Skill instructions. */
export function renderSkillCatalog(skills: readonly AgentSkillMetadata[]): string {
  return [
    '## Available Agent Skills',
    'A Step may select a focused capability with `skill:<name>`. Select only Skills needed by that Step; Runtime validates and activates their instructions and tools.',
    ...[...skills]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((skill) => `- skill:${skill.name} - ${skill.description}`),
  ].join('\n');
}

function statSafe(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function discoverSkillDirectories(root: string): string[] {
  if (statSafe(path.join(root, 'SKILL.md'))) return [root];
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = path.join(directory, entry.name);
      if (statSafe(path.join(child, 'SKILL.md'))) {
        found.push(child);
        continue;
      }
      visit(child);
    }
  };
  visit(root);
  return found.sort();
}
