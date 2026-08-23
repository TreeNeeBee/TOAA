import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DOMAIN_ROLES, type DomainRole } from '../../domain/workflow/role.js';
import type { RoleTemplateOverlay } from '../../domain/workflow/role_definition.js';

export const ROLE_TEMPLATE_REL_PATH = path.join('.xcompiler', 'roles');

/**
 * What an installation may override about a role.
 *
 * Identity text and permitted tools only. Capabilities and supported Step and Ticket types are not
 * overridable: routing narrows a Ticket's required capabilities against the same vocabulary, so an
 * installation that shrank a role's capabilities would make its own Tickets unroutable rather than
 * customizing anything.
 */
const RoleTemplateSchema = z.object({
  rolePrompt: z.string().min(1).optional(),
  capabilityPrompt: z.string().min(1).optional(),
  prohibitions: z.array(z.string().min(1)).optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
}).strict();

export type RoleTemplate = z.infer<typeof RoleTemplateSchema>;

/**
 * Where role templates live, resolved the same way the Debug Wiki resolves its installation tier so
 * the two cannot point at different installations.
 */
export function defaultRoleTemplatePath(fallbackRoot?: string): string {
  const configured = process.env.XC_PATH?.trim();
  const candidate = configured
    ? path.resolve(configured)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const base = path.parse(candidate).root === candidate && fallbackRoot
    ? path.resolve(fallbackRoot)
    : candidate;
  return path.join(base, ROLE_TEMPLATE_REL_PATH);
}

/**
 * Reads `<installation>/.xcompiler/roles/<role>.json`.
 *
 * A missing directory means "no overrides" and is not an error — templates are opt-in. A malformed
 * or unknown file is an error: silently ignoring it would let an installation believe it had
 * customized a role when every project still ran the built-in text.
 */
export async function loadRoleTemplates(directory: string): Promise<RoleTemplateOverlay> {
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const overlay: RoleTemplateOverlay = {};
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue;
    const role = entry.slice(0, -'.json'.length) as DomainRole;
    if (!DOMAIN_ROLES.includes(role)) {
      throw new Error(
        `Role template ${path.join(directory, entry)} does not name a role: expected one of ${DOMAIN_ROLES.join(', ')}`,
      );
    }
    const raw = await fs.readFile(path.join(directory, entry), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Role template ${path.join(directory, entry)} is not valid JSON`,
        { cause: error },
      );
    }
    const result = RoleTemplateSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Role template ${path.join(directory, entry)} is invalid: ${result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
      );
    }
    overlay[role] = result.data;
  }
  return overlay;
}
