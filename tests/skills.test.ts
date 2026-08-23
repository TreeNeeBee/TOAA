import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderExecutionPromptPolicy } from '../src/agents/prompt_policy.js';
import {
  AgentSkillError,
  SkillRegistry,
  buildDefaultSkills,
  renderSkillCatalog,
} from '../src/skills/index.js';
import { ActivatedSkillResources } from '../src/skills/resources.js';
import { buildDefaultRegistry } from '../src/tools/index.js';
import { skillResourceTool } from '../src/tools/skill_resource.js';
import { Workspace } from '../src/workspace/workspace.js';

async function writeSkill(
  root: string,
  name: string,
  body = '# Example\n\nFollow the verified procedure.',
  frontmatter: string[] = [],
): Promise<string> {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: Use ${name} when its focused workflow is required.`,
    ...frontmatter,
    '---',
    '',
    body,
  ].join('\n'));
  return directory;
}

describe('Agent Skills Specification integration', () => {
  it('discovers built-in metadata and expands only activated Skill tools and instructions', () => {
    const registry = buildDefaultSkills();
    const metadata = registry.get('focused-file-editing');
    expect(metadata).toMatchObject({
      name: 'focused-file-editing',
      source: { kind: 'builtin' },
      allowedTools: expect.arrayContaining(['apply_patch', 'replace_in_file']),
    });

    const resolved = registry.resolve(['skill:focused-file-editing', 'run_tests']);
    expect(resolved.resolvedToolNames).toEqual(expect.arrayContaining([
      'read_file',
      'apply_patch',
      'replace_in_file',
      'run_tests',
    ]));
    expect(resolved.hints.join('\n')).toContain('Agent Skill: focused-file-editing');
    expect(resolved.hints.join('\n')).toContain('workspace-relative');
  });

  it('renders planning metadata without disclosing inactive Skill instructions', () => {
    const registry = buildDefaultSkills();
    const catalog = renderSkillCatalog(registry.list());
    expect(catalog).toContain('skill:systematic-debugging');
    expect(catalog).toContain(registry.get('systematic-debugging')?.description);
    expect(catalog).not.toContain('Establish Evidence');
    expect(catalog).not.toContain('bugResolutionPlan containing');
  });

  it('validates every built-in allowed-tools reference against the Tool registry', () => {
    expect(() => buildDefaultSkills().validateTools(buildDefaultRegistry().list())).not.toThrow();
  });

  it('fails closed for an unknown Skill instead of silently dropping its contract', () => {
    const registry = new SkillRegistry();
    expect(() => registry.resolve(['skill:missing', 'read_file']))
      .toThrowError(expect.objectContaining<Partial<AgentSkillError>>({ code: 'skill-not-found' }));
  });

  it('discovers categorized directories and supports CRLF frontmatter', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-skills-'));
    const category = path.join(root, 'software-development');
    const directory = await writeSkill(category, 'categorized-skill');
    const skillPath = path.join(directory, 'SKILL.md');
    await fs.writeFile(skillPath, (await fs.readFile(skillPath, 'utf8')).replace(/\n/gu, '\r\n'));

    const registry = new SkillRegistry();
    expect(registry.registerDirectory(root, { kind: 'project', projectId: 'test' }))
      .toHaveLength(1);
    expect(registry.activate('categorized-skill').instructions).toContain('verified procedure');
  });

  it('treats the 500-line guidance as progressive-disclosure advice, not a runtime cap', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-long-skill-'));
    await writeSkill(root, 'long-skill', `# Long Skill\n${'One concise line.\n'.repeat(520)}`);
    const registry = new SkillRegistry();
    registry.registerDirectory(root, { kind: 'project', projectId: 'test' });
    expect(registry.activate('long-skill').instructions.split('\n').length).toBeGreaterThan(500);
  });

  it('loads the body on activation and reports activation-time file loss', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-lazy-skill-'));
    const directory = await writeSkill(root, 'lazy-skill');
    const registry = new SkillRegistry();
    registry.registerDirectory(root, { kind: 'project', projectId: 'test' });
    await fs.unlink(path.join(directory, 'SKILL.md'));
    expect(() => registry.activate('lazy-skill'))
      .toThrowError(expect.objectContaining<Partial<AgentSkillError>>({ code: 'skill-invalid' }));
  });

  it('rejects a Skill document changed after metadata preflight', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-mutated-skill-'));
    const directory = await writeSkill(root, 'mutated-skill');
    const registry = new SkillRegistry();
    registry.registerDirectory(root, { kind: 'project', projectId: 'test' });
    await fs.appendFile(path.join(directory, 'SKILL.md'), '\nUnvalidated replacement instruction.\n');
    expect(() => registry.activate('mutated-skill')).toThrow(/changed after metadata validation/u);
  });

  it('enforces names, directory identity, and known Tool references', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-invalid-skill-'));
    await writeSkill(root, 'actual-name', '# Invalid', ['allowed-tools: unknown_tool']);
    const skillPath = path.join(root, 'actual-name', 'SKILL.md');
    await fs.writeFile(skillPath, (await fs.readFile(skillPath, 'utf8')).replace('name: actual-name', 'name: other-name'));
    expect(() => new SkillRegistry().registerDirectory(root, { kind: 'project' })).toThrow(/match parent directory/u);

    await fs.writeFile(skillPath, (await fs.readFile(skillPath, 'utf8')).replace('name: other-name', 'name: actual-name'));
    const registry = new SkillRegistry();
    registry.registerDirectory(root, { kind: 'project' });
    expect(() => registry.validateTools(buildDefaultRegistry().list())).toThrow(/unknown tool/u);
  });

  it('reads resources only for active Skills and blocks traversal and symlink escape', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-skill-resource-'));
    const directory = await writeSkill(root, 'resource-skill');
    await fs.mkdir(path.join(directory, 'references'));
    await fs.writeFile(path.join(directory, 'references', 'guide.md'), 'trusted reference');
    const outside = path.join(root, 'outside.txt');
    await fs.writeFile(outside, 'must not leak');
    await fs.symlink(outside, path.join(directory, 'references', 'leak.txt'));

    const registry = new SkillRegistry();
    registry.registerDirectory(root, { kind: 'project' });
    const inactive = new ActivatedSkillResources(registry, []);
    await expect(inactive.read('resource-skill', 'references/guide.md', 100)).rejects.toThrow(/not active/u);

    const resources = new ActivatedSkillResources(registry, ['resource-skill']);
    await expect(resources.read('resource-skill', '../outside.txt', 100)).rejects.toThrow(/relative paths/u);
    await expect(resources.read('resource-skill', 'references/leak.txt', 100)).rejects.toThrow(/escapes/u);
    await expect(resources.read('resource-skill', 'references/guide.md', 7)).resolves.toMatchObject({
      content: 'trusted',
      totalBytes: 17,
      truncated: true,
    });
  });

  it('exposes active resources through the read-only Tool and honours the operation window', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-skill-tool-'));
    const directory = await writeSkill(root, 'tool-resource-skill');
    await fs.mkdir(path.join(directory, 'references'));
    await fs.writeFile(path.join(directory, 'references', 'guide.md'), '0123456789');
    const registry = new SkillRegistry();
    registry.registerDirectory(root, { kind: 'project' });
    const baseContext = {
      ws: new Workspace(root),
      sandbox: undefined as never,
      allowedWrites: [],
      stepId: 'S001',
      readChunkBytes: 4,
    };

    await expect(skillResourceTool.run(
      { skill: 'tool-resource-skill', path: 'references/guide.md' },
      baseContext,
    )).resolves.toMatchObject({ ok: false });
    await expect(skillResourceTool.run(
      { skill: 'tool-resource-skill', path: 'references/guide.md' },
      {
        ...baseContext,
        skillResources: new ActivatedSkillResources(registry, ['tool-resource-skill']),
      },
    )).resolves.toMatchObject({
      ok: true,
      data: { content: '0123', totalBytes: 10, truncated: true },
    });
  });

  it('keeps the Runtime path policy authoritative over Skill guidance', () => {
    expect(renderExecutionPromptPolicy({ debug: true })).toMatch(/workspace-relative|workspace 相对/u);
  });
});
