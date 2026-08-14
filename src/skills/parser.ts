import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import YAML from 'yaml';
import { AgentSkillError, type ActivatedAgentSkill, type AgentSkillMetadata, type SkillSource } from './types.js';

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_COMPATIBILITY_LENGTH = 500;

interface ParsedSkillDocument {
  metadata: AgentSkillMetadata;
  instructionsOffset: number;
}

/** Read and validate only the metadata required for skill discovery. */
export function readSkillMetadata(directory: string, source: SkillSource): AgentSkillMetadata {
  return parseSkillDocument(directory, source).metadata;
}

/** Load the Markdown body only when a Step activates the skill. */
export function activateSkill(metadata: AgentSkillMetadata): ActivatedAgentSkill {
  let content: string;
  try {
    content = readFileSync(metadata.skillPath, 'utf8');
  } catch (error) {
    throw invalid(`Cannot activate Agent Skill at ${metadata.skillPath}: ${message(error)}`, {
      skillPath: metadata.skillPath,
      name: metadata.name,
    });
  }
  const digest = documentDigest(content);
  if (digest !== metadata.documentDigest) {
    throw invalid(`Agent Skill "${metadata.name}" changed after metadata validation`, {
      skillPath: metadata.skillPath,
      expectedDigest: metadata.documentDigest,
      actualDigest: digest,
    });
  }
  const parsed = parseDocument(content, metadata.directory, metadata.source);
  return { ...parsed.metadata, instructions: content.slice(parsed.instructionsOffset).trim() };
}

function parseSkillDocument(directory: string, source: SkillSource): ParsedSkillDocument {
  const absoluteDirectory = path.resolve(directory);
  const skillPath = path.join(absoluteDirectory, 'SKILL.md');
  let content: string;
  try {
    content = readFileSync(skillPath, 'utf8');
  } catch (error) {
    throw invalid(`Cannot read Agent Skill at ${skillPath}: ${message(error)}`, { skillPath });
  }
  return parseDocument(content, absoluteDirectory, source);
}

function parseDocument(content: string, directory: string, source: SkillSource): ParsedSkillDocument {
  const skillPath = path.join(directory, 'SKILL.md');
  const opening = content.match(/^---\r?\n/u);
  if (!opening) {
    throw invalid(`${skillPath} must start with YAML frontmatter`, { skillPath });
  }
  const remainder = content.slice(opening[0].length);
  const closing = remainder.match(/\r?\n---\r?\n/u);
  if (!closing || closing.index === undefined) {
    throw invalid(`${skillPath} has no closing frontmatter delimiter`, { skillPath });
  }
  const frontmatterEnd = opening[0].length + closing.index;
  const instructionsOffset = frontmatterEnd + closing[0].length;
  if (!content.slice(instructionsOffset).trim()) {
    throw invalid(`${skillPath} must contain Markdown instructions`, { skillPath });
  }

  let value: unknown;
  try {
    value = YAML.parse(content.slice(opening[0].length, frontmatterEnd));
  } catch (error) {
    throw invalid(`${skillPath} frontmatter is invalid YAML: ${message(error)}`, { skillPath });
  }
  if (!isRecord(value)) throw invalid(`${skillPath} frontmatter must be a mapping`, { skillPath });

  const name = requiredString(value.name, 'name', skillPath);
  if (name.length > MAX_NAME_LENGTH || !NAME_RE.test(name)) {
    throw invalid(`${skillPath} name must be 1-64 lowercase letters, numbers, or single hyphens`, { name });
  }
  if (path.basename(directory) !== name) {
    throw invalid(`${skillPath} name "${name}" must match parent directory`, { name, directory });
  }
  const description = requiredString(value.description, 'description', skillPath);
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw invalid(`${skillPath} description exceeds 1024 characters`, { name });
  }
  const compatibility = optionalString(value.compatibility, 'compatibility', skillPath);
  if (compatibility && compatibility.length > MAX_COMPATIBILITY_LENGTH) {
    throw invalid(`${skillPath} compatibility exceeds 500 characters`, { name });
  }
  const license = optionalString(value.license, 'license', skillPath);
  const metadata = stringMetadata(value.metadata, skillPath);
  const allowedTools = allowedToolNames(value['allowed-tools'], skillPath);

  return {
    metadata: {
      name,
      description,
      ...(license ? { license } : {}),
      ...(compatibility ? { compatibility } : {}),
      metadata,
      allowedTools,
      directory,
      skillPath,
      documentDigest: documentDigest(content),
      source,
    },
    instructionsOffset,
  };
}

function allowedToolNames(value: unknown, skillPath: string): string[] {
  if (value === undefined) return [];
  if (typeof value !== 'string') {
    throw invalid(`${skillPath} allowed-tools must be a space-separated string`, { skillPath });
  }
  const names = value.trim() ? value.trim().split(/\s+/u) : [];
  for (const name of names) {
    if (!/^[a-z][a-z0-9_]*$/u.test(name)) {
      throw invalid(`${skillPath} contains invalid tool name "${name}"`, { skillPath, name });
    }
  }
  return [...new Set(names)];
}

function stringMetadata(value: unknown, skillPath: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw invalid(`${skillPath} metadata must be a string mapping`, { skillPath });
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw invalid(`${skillPath} metadata.${key} must be a string`, { skillPath, key });
    }
    result[key] = item;
  }
  return result;
}

function requiredString(value: unknown, field: string, skillPath: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid(`${skillPath} requires non-empty ${field}`, { skillPath, field });
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, skillPath: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid(`${skillPath} ${field} must be a non-empty string`, { skillPath, field });
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function invalid(messageText: string, details: Record<string, unknown>): AgentSkillError {
  return new AgentSkillError('skill-invalid', messageText, details);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function documentDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
