import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { Workspace } from '../src/workspace/workspace.js';
import { createSandbox, isRunningInContainer } from '../src/sandbox/factory.js';
import { SubprocessSandbox } from '../src/sandbox/subprocess.js';
import { DockerSandbox } from '../src/sandbox/docker.js';
import type { XCompilerConfig } from '../src/config/config.js';

const baseCfg = (sandbox: 'subprocess' | 'docker'): XCompilerConfig =>
  ({
    llm: { providers: {}, roles: {}, fallbacks: [] },
    agent: {
      max_steps: 10,
      max_rounds_per_step: 6,
      max_debug_retries: 3,
      max_edit_lines_per_step: 400,
      sandboxes: {
        python: {
          mode: sandbox,
          local: { inherit_env: false, limits: { cpu: 1, memory_mb: 512, wall_seconds: 60, network: 'download-only', expose_ports: [] } },
          docker: { image: 'python:3.11-slim', workdir: '/workspace', pull: false, docker_bin: 'docker', extra_run_args: [], limits: { cpu: 1, memory_mb: 512, wall_seconds: 60, network: 'download-only', expose_ports: [] } },
        },
        typescript: {
          mode: sandbox,
          local: { inherit_env: false, limits: { cpu: 1, memory_mb: 512, wall_seconds: 60, network: 'download-only', expose_ports: [] } },
          docker: { image: 'node:24-slim', workdir: '/workspace', pull: false, docker_bin: 'docker', extra_run_args: [], limits: { cpu: 1, memory_mb: 512, wall_seconds: 60, network: 'download-only', expose_ports: [] } },
        },
      },
    },
  }) as unknown as XCompilerConfig;

let savedEnv: string | undefined;
let savedLongEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.XC_IN_CONTAINER;
  savedLongEnv = process.env.XCOMPILER_IN_CONTAINER;
  delete process.env.XC_IN_CONTAINER;
  delete process.env.XCOMPILER_IN_CONTAINER;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.XC_IN_CONTAINER;
  else process.env.XC_IN_CONTAINER = savedEnv;
  if (savedLongEnv === undefined) delete process.env.XCOMPILER_IN_CONTAINER;
  else process.env.XCOMPILER_IN_CONTAINER = savedLongEnv;
});

describe('sandbox factory — container detection', () => {
  it('XC_IN_CONTAINER=1 强制识别为容器', () => {
    process.env.XC_IN_CONTAINER = '1';
    expect(isRunningInContainer()).toBe(true);
  });

  it('XC_IN_CONTAINER=0 强制识别为宿主', () => {
    process.env.XC_IN_CONTAINER = '0';
    expect(isRunningInContainer()).toBe(false);
  });

  it('XCOMPILER_IN_CONTAINER fallback remains supported', () => {
    process.env.XCOMPILER_IN_CONTAINER = '1';
    expect(isRunningInContainer()).toBe(true);
  });

  it('容器内创建 sandbox=docker 时抛出引导性错误', () => {
    process.env.XC_IN_CONTAINER = '1';
    const ws = new Workspace('/tmp/xcompiler-factory-test');
    expect(() => createSandbox(baseCfg('docker'), ws)).toThrowError(/sandbox mode docker/);
    expect(() => createSandbox(baseCfg('docker'), ws)).toThrowError(/subprocess/);
  });

  it('容器内 sandbox=subprocess 正常返回 SubprocessSandbox', () => {
    process.env.XC_IN_CONTAINER = '1';
    const ws = new Workspace('/tmp/xcompiler-factory-test');
    const sb = createSandbox(baseCfg('subprocess'), ws);
    expect(sb).toBeInstanceOf(SubprocessSandbox);
  });

  it('宿主上 sandbox=docker 正常实例化（不抛错）', () => {
    process.env.XC_IN_CONTAINER = '0';
    const ws = new Workspace('/tmp/xcompiler-factory-test');
    expect(() => createSandbox(baseCfg('docker'), ws)).not.toThrow();
  });

  it('subprocess 拒绝无法兑现的 network=off 策略', () => {
    const ws = new Workspace('/tmp/xcompiler-factory-test');
    const cfg = baseCfg('subprocess');
    cfg.agent.sandboxes.python.local.limits.network = 'off';
    expect(() => createSandbox(cfg, ws)).toThrow(/cannot be enforced in subprocess mode/);
  });

  it('跨语言执行时为 TypeScript plan 选择 Node 默认镜像，而不是沿用 Python 自定义镜像', () => {
    process.env.XC_IN_CONTAINER = '0';
    const ws = new Workspace('/tmp/xcompiler-factory-test');
    const cfg = baseCfg('docker');
    cfg.agent.sandboxes.python.docker.image = 'python:3.12-slim';
    const sb = createSandbox(cfg, ws, undefined, 'typescript') as DockerSandbox & { image?: string };
    expect(sb).toBeInstanceOf(DockerSandbox);
    expect((sb as { image?: string }).image).toBe('node:24-slim');
  });
});
