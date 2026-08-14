import type { PluginHost } from '../../plugins/host.js';
import { buildDefaultSkills, type SkillRegistry } from '../../skills/index.js';
import { buildDefaultRegistry, type ToolRegistry } from '../../tools/index.js';

export interface RuntimeCapabilities {
  tools: ToolRegistry;
  skills: SkillRegistry;
}

/** Build one validated capability graph for a Runtime invocation. */
export async function buildRuntimeCapabilities(plugins: PluginHost): Promise<RuntimeCapabilities> {
  await plugins.initialize();
  const tools = buildDefaultRegistry();
  const skills = buildDefaultSkills();
  plugins.applyExtensions({ tools, skills });
  skills.validateTools(tools.list());
  return { tools, skills };
}
