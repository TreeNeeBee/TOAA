import { resolveSkillOperationWindow } from '../llm/window.js';
import type { Tool } from './types.js';

export const skillResourceTool: Tool<
  { skill: string; path: string; maxBytes?: number },
  { skill: string; path: string; content: string; totalBytes: number; truncated: boolean }
> = {
  name: 'skill_resource',
  description:
    'Read a references/, scripts/, or assets/ file belonging to an Agent Skill already active for this Step. ' +
    'This tool is read-only and never executes scripts.',
  argsSchema: {
    skill: 'string (active Agent Skill name)',
    path: 'string (relative references/, scripts/, or assets/ path)',
    maxBytes: 'number?',
  },
  async run(args, ctx) {
    if (!ctx.skillResources) return { ok: false, error: 'No Agent Skill resources are active for this Step' };
    if (typeof args.skill !== 'string' || !args.skill.trim() || typeof args.path !== 'string' || !args.path.trim()) {
      return { ok: false, error: 'skill_resource requires non-empty skill and path strings' };
    }
    const dynamicLimit = ctx.readChunkBytes ??
      resolveSkillOperationWindow({ contextWindowTokens: ctx.contextWindowTokens }).readChunkBytes;
    const requested = typeof args.maxBytes === 'number' && Number.isFinite(args.maxBytes) && args.maxBytes > 0
      ? Math.floor(args.maxBytes)
      : dynamicLimit;
    const maxBytes = Math.max(1, Math.min(dynamicLimit, requested));
    try {
      const data = await ctx.skillResources.read(args.skill.trim(), args.path.trim(), maxBytes);
      return {
        ok: true,
        data,
        summary: `skill_resource ${data.skill}/${data.path} (${data.totalBytes}B${data.truncated ? `, truncated to ${maxBytes}B` : ''})`,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
};
