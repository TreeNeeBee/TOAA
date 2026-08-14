export type SkillSource =
  | { kind: 'builtin' }
  | { kind: 'plugin'; pluginId: string }
  | { kind: 'project'; projectId?: string };

/** Agent Skills Specification metadata kept in memory before instructions are activated. */
export interface AgentSkillMetadata {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata: Record<string, string>;
  allowedTools: string[];
  directory: string;
  skillPath: string;
  /** SHA-256 of the validated SKILL.md; activation fails if the document changed after discovery. */
  documentDigest: string;
  source: SkillSource;
}

/** A standard skill after its Markdown instructions have been activated. */
export interface ActivatedAgentSkill extends AgentSkillMetadata {
  instructions: string;
}

export interface ResolvedSkills {
  resolvedToolNames: string[];
  activatedSkills: ActivatedAgentSkill[];
  hints: string[];
}

export class AgentSkillError extends Error {
  constructor(
    public readonly code:
      | 'skill-invalid'
      | 'skill-not-found'
      | 'skill-duplicate'
      | 'skill-tool-missing'
      | 'skill-resource-invalid',
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AgentSkillError';
  }
}
