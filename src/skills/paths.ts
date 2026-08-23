import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentSkillError } from './types.js';

export function defaultBuiltinSkillsRoot(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, '../../skills'),
    path.resolve(moduleDirectory, '../skills'),
    path.resolve(path.dirname(process.execPath), 'skills'),
    path.resolve(process.cwd(), 'skills'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new AgentSkillError('skill-resource-invalid', 'Bundled Agent Skills directory was not found', { candidates });
}
