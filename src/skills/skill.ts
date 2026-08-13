import type { Tool } from '../tools/types.js';
import { t } from '../i18n/index.js';

/**
 * Skill：把一组原子工具组合为面向 LLM 的"高阶能力"。
 *
 * 在 M3 阶段 Skill 是一层"语义包装"——执行器仍然按 step.tools 中的工具名调用具体 Tool，
 * 但 Step 可以声明 `tools: ["skill:patcher"]`，Skill Registry 会展开为底层工具集合，
 * 并把 Skill 的 `prompt` 注入 system prompt，提示 LLM 该如何组合这些工具。
 */
export interface Skill {
  /** 形如 `patcher` / `tester` / `dep_resolver`。 */
  readonly name: string;
  /** 注入到 system prompt 的简短指引（中文一句话）。 */
  readonly prompt: string;
  /** 该 Skill 暴露给 LLM 的底层工具名集合。 */
  readonly tools: string[];
}

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  register(s: Skill): void {
    this.skills.set(s.name, s);
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * 把 `step.tools` 中的 `skill:xxx` 项展开为底层工具名（去重，保持顺序）。
   * 非 skill 项原样保留，便于与裸工具混用。
   * 返回 { resolvedToolNames, hints }。
   */
  resolve(toolRefs: string[]): { resolvedToolNames: string[]; hints: string[] } {
    const out: string[] = [];
    const hints: string[] = [];
    const seen = new Set<string>();
    for (const ref of toolRefs) {
      if (ref.startsWith('skill:')) {
        const sk = this.skills.get(ref.slice('skill:'.length));
        if (!sk) continue;
        hints.push(`[${sk.name}] ${sk.prompt}`);
        for (const t of sk.tools) if (!seen.has(t)) {
          seen.add(t);
          out.push(t);
        }
      } else {
        if (!seen.has(ref)) {
          seen.add(ref);
          out.push(ref);
        }
      }
    }
    return { resolvedToolNames: out, hints };
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }
}

/** Default skill set; see implementation_plan §M3.1. */
export function buildDefaultSkills(): SkillRegistry {
  const reg = new SkillRegistry();
  const SK = t().skills;
  reg.register({
    name: 'patcher',
    prompt: SK.patcher,
    tools: ['read_file', 'code_search', 'apply_patch', 'replace_in_file'],
  });
  reg.register({
    name: 'author',
    prompt: SK.author,
    tools: ['read_file', 'list_dir', 'write_file', 'append_file'],
  });
  reg.register({
    name: 'tester',
    prompt: SK.tester,
    tools: [
      'read_file',
      'list_dir',
      'write_file',
      'append_file',
      'run_tests',
      'run_program',
      'analyze_error',
      'http_fetch',
    ],
  });
  reg.register({
    name: 'dep_resolver',
    prompt: SK.dep_resolver,
    tools: ['analyze_error', 'add_dependency', 'install_deps'],
  });
  reg.register({
    name: 'debugger',
    prompt: SK.debugger,
    tools: [
      'read_file',
      'code_search',
      'run_tests',
      'run_program',
      'analyze_error',
      'apply_patch',
      'replace_in_file',
      'write_file',
      'append_file',
      'add_dependency',
      'http_fetch',
    ],
  });
  reg.register({
    name: 'refactorer',
    prompt: SK.refactorer,
    tools: ['read_file', 'code_search', 'apply_patch', 'replace_in_file', 'write_file', 'append_file', 'run_tests'],
  });
  return reg;
}

/** 便利函数：把 skill / tool refs 解析为可注入 prompt 的提示串。 */
export function renderSkillHints(hints: string[]): string {
  if (hints.length === 0) return '';
  return ['## skill hints', ...hints.map((h) => `- ${h}`)].join('\n');
}

/** 把工具元信息渲染为 prompt 段。 */
export function renderToolDocs(tools: Tool[]): string {
  return tools
    .map((t) => `- ${t.name}: ${t.description} args=${JSON.stringify(t.argsSchema)}`)
    .join('\n');
}
