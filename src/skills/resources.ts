import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SkillResourceReader, SkillResourceResult } from '../tools/types.js';
import { AgentSkillError } from './types.js';
import type { SkillRegistry } from './registry.js';

const RESOURCE_ROOTS = new Set(['references', 'scripts', 'assets']);

export class ActivatedSkillResources implements SkillResourceReader {
  private readonly active: ReadonlySet<string>;

  constructor(
    private readonly registry: SkillRegistry,
    activeSkillNames: readonly string[],
  ) {
    this.active = new Set(activeSkillNames);
  }

  async read(skillName: string, resourcePath: string, maxBytes: number): Promise<SkillResourceResult> {
    if (!this.active.has(skillName)) {
      throw new AgentSkillError('skill-resource-invalid', `Agent Skill "${skillName}" is not active for this Step`, {
        skill: skillName,
      });
    }
    const skill = this.registry.get(skillName);
    if (!skill) throw new AgentSkillError('skill-not-found', `Unknown Agent Skill "${skillName}"`, { skill: skillName });
    const normalized = resourcePath.replace(/\\/gu, '/').replace(/^\.\//u, '');
    const segments = normalized.split('/');
    const first = segments[0] ?? '';
    if (!normalized || path.posix.isAbsolute(normalized) || segments.includes('..') || !RESOURCE_ROOTS.has(first)) {
      throw new AgentSkillError(
        'skill-resource-invalid',
        'Skill resources must be relative paths under references/, scripts/, or assets/',
        { skill: skillName, resourcePath },
      );
    }
    const target = path.resolve(skill.directory, normalized);
    const root = await fs.realpath(skill.directory);
    let realTarget: string;
    try {
      realTarget = await fs.realpath(target);
    } catch (error) {
      throw new AgentSkillError('skill-resource-invalid', `Cannot read Skill resource ${normalized}`, {
        skill: skillName,
        resourcePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!realTarget.startsWith(`${root}${path.sep}`)) {
      throw new AgentSkillError('skill-resource-invalid', 'Skill resource escapes its Skill directory', {
        skill: skillName,
        resourcePath,
      });
    }
    const limit = Math.max(1, Math.floor(maxBytes));
    const handle = await fs.open(realTarget, 'r');
    let totalBytes: number;
    let content: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new AgentSkillError('skill-resource-invalid', 'Skill resource must be a regular file', {
          skill: skillName,
          resourcePath,
        });
      }
      totalBytes = stat.size;
      const buffer = Buffer.alloc(Math.min(totalBytes, limit));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      content = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
    return {
      skill: skillName,
      path: normalized,
      content,
      totalBytes,
      truncated: totalBytes > limit,
    };
  }
}
