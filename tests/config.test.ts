import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { getXCompilerPath, loadConfigWithPath } from '../src/config/config.js';
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from '../src/llm/window.js';

function allRoles(provider: string): Record<string, string[]> {
  return {
    Planner: [provider],
    Architect: [provider],
    Coder: [provider],
    Tester: [provider],
    Debugger: [provider],
    ProjectManager: [provider],
  };
}

function baseConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    llm: {
      providers: {
        ollama_code: { type: 'ollama', base_url: 'http://localhost:11434', model: 'qwen' },
      },
      roles: allRoles('ollama_code'),
      fallbacks: [],
      role_fallbacks: {},
    },
    agent: {
      sandboxes: {
        python: { mode: 'subprocess' },
        typescript: { mode: 'subprocess' },
      },
    },
    ...extra,
  };
}

async function writeConfig(obj: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-config-'));
  const cfgPath = path.join(dir, 'config.yaml');
  await fs.writeFile(cfgPath, YAML.stringify(obj), 'utf8');
  return cfgPath;
}

async function writeRawConfig(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-config-'));
  const cfgPath = path.join(dir, 'config.yaml');
  await fs.writeFile(cfgPath, content, 'utf8');
  return cfgPath;
}

describe('config locale', () => {
  it('uses top-level locale', async () => {
    const cfgPath = await writeConfig(baseConfig({ locale: 'zh' }));
    const { config } = await loadConfigWithPath(cfgPath);
    expect(config.locale).toBe('zh');
  });

  it('rejects the removed ui_language alias', async () => {
    const cfgPath = await writeConfig(baseConfig({ ui_language: 'zh' }));
    await expect(loadConfigWithPath(cfgPath)).rejects.toThrow(/ui_language/);
  });

  it('explains removed 0.2 keys instead of dumping the schema error', async () => {
    // 0.3 does not migrate old config, so the failure has to say what to do about it.
    const cfgPath = await writeConfig(
      baseConfig({ agent: { max_steps: 50, max_debug_retries: 3 } }),
    );
    const failure = await loadConfigWithPath(cfgPath).catch((error: Error) => error.message);
    expect(failure).toContain('agent.max_steps');
    expect(failure).toContain('agent.max_debug_retries');
    expect(failure).toContain('config.example.yaml');
    expect(failure).not.toContain('unrecognized_keys');
  });

  it('rejects sandbox modes that have no runtime implementation', async () => {
    const config = baseConfig();
    const agent = config.agent as Record<string, unknown>;
    agent.sandboxes = {
      python: { mode: 'firejail' },
      typescript: { mode: 'subprocess' },
    };
    await expect(loadConfigWithPath(await writeConfig(config))).rejects.toThrow(
      /agent\.sandboxes\.python\.mode.*subprocess.*docker/su,
    );
  });

  it('parses the optional Ollama think flag', async () => {
    const cfg = baseConfig();
    const llm = cfg.llm as Record<string, unknown>;
    const providers = llm.providers as Record<string, Record<string, unknown>>;
    providers.ollama_code!.think = false;
    const cfgPath = await writeConfig(cfg);
    const { config } = await loadConfigWithPath(cfgPath);
    expect(config.llm.providers.ollama_code!.think).toBe(false);
  });

  it('defaults missing or empty provider context_window to 128K tokens', async () => {
    const missing = await loadConfigWithPath(await writeConfig(baseConfig()));
    expect(missing.config.llm.providers.ollama_code!.context_window).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);

    const cfg = baseConfig();
    const providers = (cfg.llm as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    providers.ollama_code!.context_window = '';
    const empty = await loadConfigWithPath(await writeConfig(cfg));
    expect(empty.config.llm.providers.ollama_code!.context_window).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  it('accepts K/M shorthand for provider context_window', async () => {
    const cfg = baseConfig();
    const providers = (cfg.llm as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    providers.ollama_code!.context_window = '64K';
    const { config } = await loadConfigWithPath(await writeConfig(cfg));
    expect(config.llm.providers.ollama_code!.context_window).toBe(64 * 1024);
  });

  it('defaults edit guard line budget to auto', async () => {
    const cfgPath = await writeConfig(baseConfig());
    const { config } = await loadConfigWithPath(cfgPath);
    expect(config.agent.max_edit_lines_per_step).toBe('auto');
  });

  it('defaults Record/Replay to external data channels, not process exit codes', async () => {
    const { config } = await loadConfigWithPath(await writeConfig(baseConfig()));
    expect(config.record_replay.channels).toEqual(['http', 'llm']);
  });

  it('derives write chunk bytes from context_window instead of accepting a fixed config field', async () => {
    const cfgPath = await writeConfig(baseConfig());
    const { config } = await loadConfigWithPath(cfgPath);
    expect('max_write_chunk_bytes' in config.agent).toBe(false);
  });

  it('keeps numeric-looking provider env vars as strings', async () => {
    const oldKey = process.env.XC_TEST_NUMERIC_API_KEY;
    const oldBaseUrl = process.env.XC_TEST_OPENAI_BASE_URL;
    try {
      process.env.XC_TEST_NUMERIC_API_KEY = '1111';
      process.env.XC_TEST_OPENAI_BASE_URL = 'http://127.0.0.1:11435/v1';
      const cfgPath = await writeRawConfig(`
llm:
  providers:
    openai:
      type: openai
      api_key: \${XC_TEST_NUMERIC_API_KEY}
      base_url: \${XC_TEST_OPENAI_BASE_URL}
      model: gpt-4o-mini
  roles:
    Planner:   [openai]
    Architect: [openai]
    Coder:     [openai]
    Tester:    [openai]
    Debugger:  [openai]
    ProjectManager:  [openai]
  fallbacks: []
  role_fallbacks: {}
agent:
  sandboxes: {}
`);
      const { config } = await loadConfigWithPath(cfgPath);
      expect(config.llm.providers.openai!.api_key).toBe('1111');
      expect(config.llm.providers.openai!.base_url).toBe('http://127.0.0.1:11435/v1');
    } finally {
      if (oldKey === undefined) delete process.env.XC_TEST_NUMERIC_API_KEY;
      else process.env.XC_TEST_NUMERIC_API_KEY = oldKey;
      if (oldBaseUrl === undefined) delete process.env.XC_TEST_OPENAI_BASE_URL;
      else process.env.XC_TEST_OPENAI_BASE_URL = oldBaseUrl;
    }
  });

  it('reports missing environment placeholders as structured load metadata', async () => {
    const name = 'XC_TEST_INTENTIONALLY_MISSING_KEY';
    const previous = process.env[name];
    delete process.env[name];
    try {
      const cfg = baseConfig();
      const provider = ((cfg.llm as Record<string, unknown>).providers as Record<string, Record<string, unknown>>)
        .ollama_code!;
      provider.api_key = `\${${name}}`;
      const loaded = await loadConfigWithPath(await writeConfig(cfg));
      expect(loaded.missingEnv).toEqual([name]);
      expect(loaded.config.llm.providers.ollama_code?.api_key).toBe('');
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  it('parses OpenAI-compatible json_schema response format capability', async () => {
    const cfg = baseConfig({
      llm: {
        providers: {
          openrouter_hy3: {
            type: 'openai',
            api_key: 'dummy',
            base_url: 'https://openrouter.ai/api/v1',
            model: 'tencent/hy3:free',
            json_response_format: 'json_schema',
          },
        },
        roles: allRoles('openrouter_hy3'),
        fallbacks: [],
        role_fallbacks: {},
      },
    });
    const cfgPath = await writeConfig(cfg);
    const { config } = await loadConfigWithPath(cfgPath);
    expect(config.llm.providers.openrouter_hy3!.json_response_format).toBe('json_schema');
  });

  it('parses an OpenAI-compatible connection timeout separately from stream timeouts', async () => {
    const cfg = baseConfig({
      llm: {
        providers: {
          openrouter: {
            type: 'openai',
            api_key: 'dummy',
            base_url: 'https://openrouter.ai/api/v1',
            model: 'openrouter/free',
            connect_timeout_ms: 45000,
            stream_first_token_timeout_ms: 300000,
            stream_idle_timeout_ms: 60000,
          },
        },
        roles: allRoles('openrouter'),
        fallbacks: [],
        role_fallbacks: {},
      },
    });
    const { config } = await loadConfigWithPath(await writeConfig(cfg));
    expect(config.llm.providers.openrouter!.connect_timeout_ms).toBe(45000);
    expect(config.llm.providers.openrouter!.stream_first_token_timeout_ms).toBe(300000);
    expect(config.llm.providers.openrouter!.stream_idle_timeout_ms).toBe(60000);
  });

  it('parses cluster provider tags and score bounds', async () => {
    const cfg = baseConfig({
      llm: {
        providers: {
          openrouter_free: {
            type: 'openai',
            api_key: 'dummy',
            base_url: 'https://openrouter.ai/api/v1',
            model: 'openrouter/free',
            tags: ['Cluster'],
          },
        },
        roles: allRoles('openrouter_free'),
        fallbacks: [],
        role_fallbacks: {},
        cluster_score_min: 0.2,
        cluster_score_max: 0.5,
      },
    });
    const cfgPath = await writeConfig(cfg);
    const { config } = await loadConfigWithPath(cfgPath);
    expect(config.llm.providers.openrouter_free!.tags).toEqual(['cluster']);
    expect(config.llm.cluster_score_min).toBe(0.2);
    expect(config.llm.cluster_score_max).toBe(0.5);
  });

  it('parses language-specific sandbox profiles without requiring agent.language', async () => {
    const cfgPath = await writeRawConfig(`
llm:
  providers:
    openrouter_free:
      type: openai
      api_key: dummy
      base_url: https://openrouter.ai/api/v1
      model: openrouter/free
  roles:
    Planner:   [openrouter_free]
    Architect: [openrouter_free]
    Coder:     [openrouter_free]
    Tester:    [openrouter_free]
    Debugger:  [openrouter_free]
    ProjectManager:  [openrouter_free]
  fallbacks: []
  role_fallbacks: {}
agent:
  sandboxes:
    python:
      mode: subprocess
      local:
        sandbox_dir: .sandbox/python
        limits:
          cpu: 1
          memory_mb: 256
          wall_seconds: 30
          network: off
      docker:
        image: python:3.11-slim
        workdir: /workspace
        pull: false
        docker_bin: docker
        extra_run_args: []
        limits:
          cpu: 1
          memory_mb: 256
          wall_seconds: 30
          network: off
    typescript:
      mode: docker
      local:
        sandbox_dir: .sandbox/typescript
        limits:
          cpu: 1
          memory_mb: 256
          wall_seconds: 30
          network: off
      docker:
        image: node:24-slim
        workdir: /workspace
        pull: false
        docker_bin: docker
        extra_run_args: []
        limits:
          cpu: 2
          memory_mb: 512
          wall_seconds: 45
          network: download-only
`);
    const { config } = await loadConfigWithPath(cfgPath);
    expect(config.agent.sandboxes.python.mode).toBe('subprocess');
    expect(config.agent.sandboxes.python.local.sandbox_dir).toBe('.sandbox/python');
    expect(config.agent.sandboxes.python.local.inherit_env).toBe(false);
    expect(config.agent.sandboxes.typescript.mode).toBe('docker');
    expect(config.agent.sandboxes.typescript.docker.image).toBe('node:24-slim');
    expect(config.agent.sandboxes.typescript.docker.limits.cpu).toBe(2);
  });

  it('rejects inverted cluster score bounds', async () => {
    const cfg = baseConfig();
    (cfg.llm as Record<string, unknown>).cluster_score_min = 0.8;
    (cfg.llm as Record<string, unknown>).cluster_score_max = 0.5;
    const cfgPath = await writeConfig(cfg);
    await expect(loadConfigWithPath(cfgPath)).rejects.toThrow(/cluster_score_min/);
  });

  it('rejects unsupported sandbox network policies at the configuration boundary', async () => {
    const cfg = baseConfig();
    const agent = cfg.agent as unknown as {
      sandboxes: { python: { local?: { limits: { network: string } } } };
    };
    agent.sandboxes.python.local = { limits: { network: 'pypi-only' } };
    const cfgPath = await writeConfig(cfg);
    await expect(loadConfigWithPath(cfgPath)).rejects.toThrow(/network/);
  });

  it('rejects the removed llm.default option', async () => {
    const cfg = baseConfig();
    (cfg.llm as Record<string, unknown>).default = 'ollama_code';
    const cfgPath = await writeConfig(cfg);
    await expect(loadConfigWithPath(cfgPath)).rejects.toThrow(/default/);
  });

  it('rejects configs where a role has no manually specified provider', async () => {
    const cfg = baseConfig();
    const roles = (cfg.llm as Record<string, unknown>).roles as Record<string, string[]>;
    delete roles.Debugger;
    const cfgPath = await writeConfig(cfg);
    await expect(loadConfigWithPath(cfgPath)).rejects.toThrow(/llm\.roles\.Debugger/);
  });

  it('accepts role coverage supplied via role_fallbacks', async () => {
    const cfg = baseConfig();
    const llm = cfg.llm as Record<string, unknown>;
    const roles = llm.roles as Record<string, string[]>;
    delete roles.Debugger;
    llm.role_fallbacks = { Debugger: ['ollama_code'] };
    const cfgPath = await writeConfig(cfg);
    const { config } = await loadConfigWithPath(cfgPath);
    expect(config.llm.role_fallbacks.Debugger).toEqual(['ollama_code']);
  });

  it('prefers XC_PATH as the short global config directory', async () => {
    const oldShort = process.env.XC_PATH;
    const oldLong = process.env.XCOMPILER_PATH;
    try {
      process.env.XC_PATH = '/tmp/xc-short';
      process.env.XCOMPILER_PATH = '/tmp/xcompiler-long';
      expect(getXCompilerPath()).toBe('/tmp/xc-short');
    } finally {
      if (oldShort === undefined) delete process.env.XC_PATH;
      else process.env.XC_PATH = oldShort;
      if (oldLong === undefined) delete process.env.XCOMPILER_PATH;
      else process.env.XCOMPILER_PATH = oldLong;
    }
  });
});

// PM judges outcomes on the project's behalf and never executes a Step. Letting it be assigned as a
// Step's role would put the judge in the position of doing the work it later assesses.
describe('ProjectManager is a judging role, not an executing one', () => {
  it('is configurable as an LLM role', async () => {
    const { ROLES } = await import('../src/core/plan.js');
    expect(ROLES).toContain('ProjectManager');
  });

  // No silent degradation: a project with no judge configured must not proceed believing it has
  // one. The gate that would have caught a wrong delivery is the thing being left unconfigured.
  it('is rejected at load time when no provider is configured for it', async () => {
    const { loadConfig } = await import('../src/config/config.js');
    const config = baseConfig() as { llm: { roles: Record<string, unknown> } };
    delete config.llm.roles.ProjectManager;
    const cfgPath = await writeConfig(config);
    await expect(loadConfig(cfgPath)).rejects.toThrow(/ProjectManager/u);
  });

  it('cannot be assigned as the role that runs a Step', async () => {
    const { StepSchema } = await import('../src/core/plan.js');
    const step = {
      id: 'S001', iterationId: 'P1', phase: 'REQUIREMENT_ANALYSIS', title: 't', description: 'd',
      systemPrompt: 'p', acceptance: 'a', maxAttempts: 3,
    };
    expect(StepSchema.safeParse({ ...step, role: 'Coder' }).success).toBe(true);
    expect(StepSchema.safeParse({ ...step, role: 'ProjectManager' }).success).toBe(false);
  });
});
