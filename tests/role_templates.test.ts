import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROLE_TEMPLATE_REL_PATH,
  loadRoleTemplates,
} from '../src/infrastructure/roles/role_template_store.js';
import { seedRoleDefinition } from '../src/domain/workflow/role_definition.js';
import { capabilitiesForRole } from '../src/domain/workflow/role_profile.js';

async function templateDir(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-roletpl-'));
  const directory = path.join(root, ROLE_TEMPLATE_REL_PATH);
  await fs.mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(directory, name), content);
  }
  return directory;
}

describe('installation role templates', () => {
  it('treats a missing template directory as no overrides', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-roletpl-'));
    expect(await loadRoleTemplates(path.join(root, ROLE_TEMPLATE_REL_PATH))).toEqual({});
  });

  it('substitutes identity text without touching the routing vocabulary', async () => {
    const directory = await templateDir({
      'developer.json': JSON.stringify({
        rolePrompt: 'You implement against the accepted design, in this house style.',
        prohibitions: ['Do not add a dependency without a recorded decision.'],
        allowedTools: ['write_file'],
      }),
    });
    const overlay = await loadRoleTemplates(directory);
    const seeded = seedRoleDefinition('developer', overlay);

    expect(seeded.rolePrompt).toBe('You implement against the accepted design, in this house style.');
    expect(seeded.prohibitions).toEqual(['Do not add a dependency without a recorded decision.']);
    expect(seeded.allowedTools).toEqual(['write_file']);
    // Untouched fields fall back to the built-in definition.
    expect(seeded.capabilityPrompt).toBe(seedRoleDefinition('developer').capabilityPrompt);
    // Capabilities are not overridable: routing narrows Tickets against this same vocabulary, so an
    // installation that could shrink it would make its own Tickets unroutable.
    expect(seeded.capabilities).toEqual(capabilitiesForRole('developer'));
    expect(seedRoleDefinition('tester', overlay)).toEqual(seedRoleDefinition('tester'));
  });

  it('rejects a template that tries to redefine capabilities', async () => {
    const directory = await templateDir({
      'developer.json': JSON.stringify({ capabilities: ['code'] }),
    });
    await expect(loadRoleTemplates(directory)).rejects.toThrow(/is invalid/u);
  });

  it('refuses to silently ignore a malformed or misnamed template', async () => {
    await expect(loadRoleTemplates(await templateDir({ 'developer.json': '{ not json' })))
      .rejects.toThrow(/is not valid JSON/u);
    await expect(loadRoleTemplates(await templateDir({ 'archivist.json': '{}' })))
      .rejects.toThrow(/does not name a role/u);
  });
});
