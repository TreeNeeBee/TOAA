import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { LLM_DYNAMIC_SCORES_FILE, LLM_USER_SCORES_FILE, ScoreStore } from '../src/llm/scores.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-scores-'));
}

describe('ScoreStore', () => {
  it('returns DEFAULT for unknown providers', () => {
    const s = new ScoreStore('/tmp/fake/config.yaml');
    expect(s.get('nope')).toBe(ScoreStore.DEFAULT);
  });

  it('dynamic decay floors at MIN and boost caps at MAX', () => {
    const s = new ScoreStore('/tmp/fake/config.yaml');
    for (let i = 0; i < 10; i++) s.decay('p1', 'fail');
    expect(s.get('p1')).toBe(ScoreStore.MIN);
    for (let i = 0; i < 200; i++) s.boost('p1', 'ok');
    expect(s.get('p1')).toBe(ScoreStore.MAX);
  });

  it('allows llm_scores_user.yaml score=0 as a user disable', async () => {
    const dir = await tmpDir();
    const cfgPath = path.join(dir, 'config.yaml');
    await fs.writeFile(path.join(dir, LLM_USER_SCORES_FILE), 'disabled: 0\n');
    const s = new ScoreStore(cfgPath);
    await s.load();
    expect(s.get('disabled')).toBe(0);
    expect(s.isUserDisabled('disabled')).toBe(true);
    s.boost('disabled', 'would otherwise recover');
    expect(s.get('disabled')).toBe(0);
  });

  it('persists scores to sidecar yaml and reloads them', async () => {
    const dir = await tmpDir();
    const cfgPath = path.join(dir, 'config.yaml');
    const s1 = new ScoreStore(cfgPath);
    s1.set('alpha', 0.3, 'test');
    s1.set('beta', 2.5, 'test');
    await s1.flush();

    const sidecar = path.join(dir, LLM_DYNAMIC_SCORES_FILE);
    const txt = await fs.readFile(sidecar, 'utf8');
    const parsed = YAML.parse(txt) as Record<string, number>;
    expect(parsed.alpha).toBe(0.3);
    expect(parsed.beta).toBe(ScoreStore.MAX);

    const s2 = new ScoreStore(cfgPath);
    await s2.load();
    expect(s2.get('alpha')).toBe(0.3);
    expect(s2.get('beta')).toBe(ScoreStore.MAX);
    expect(s2.get('unset')).toBe(ScoreStore.DEFAULT);
  });

  it('uses provider defaults when sidecar is absent', async () => {
    const dir = await tmpDir();
    const cfgPath = path.join(dir, 'config.yaml');
    const s = new ScoreStore(cfgPath);
    await s.load();
    expect(s.get('seed')).toBe(ScoreStore.DEFAULT);
  });

  it('loads the maintained dynamic sidecar', async () => {
    const dir = await tmpDir();
    const cfgPath = path.join(dir, 'config.yaml');
    await fs.writeFile(path.join(dir, LLM_DYNAMIC_SCORES_FILE), YAML.stringify({ shared: 0.4 }));
    const s = new ScoreStore(cfgPath);
    await s.load();
    expect(s.get('shared')).toBe(0.4);
  });

  it('does not let a dynamic sidecar override a user disable', async () => {
    const dir = await tmpDir();
    const cfgPath = path.join(dir, 'config.yaml');
    await fs.writeFile(path.join(dir, LLM_DYNAMIC_SCORES_FILE), YAML.stringify({ disabled: 1 }));
    await fs.writeFile(path.join(dir, LLM_USER_SCORES_FILE), YAML.stringify({ disabled: 0 }));
    const s = new ScoreStore(cfgPath);
    await s.load();
    expect(s.get('disabled')).toBe(0);
  });

  it('keeps sidecar score=0 as dynamic state instead of user disable', async () => {
    const dir = await tmpDir();
    const cfgPath = path.join(dir, 'config.yaml');
    await fs.writeFile(path.join(dir, LLM_DYNAMIC_SCORES_FILE), YAML.stringify({ openrouter_free: 0 }));
    const s = new ScoreStore(cfgPath, undefined, {
      clusterProviderNames: ['openrouter_free'],
    });

    await s.load();

    expect(s.get('openrouter_free')).toBe(0);
    expect(s.isUserDisabled('openrouter_free')).toBe(false);
    s.set('openrouter_free', 1, 'preflight revive');
    expect(s.get('openrouter_free')).toBe(ScoreStore.CLUSTER_MAX);
  });

  it('loads llm_scores_user.yaml as a user override ahead of dynamic scores', async () => {
    const dir = await tmpDir();
    const cfgPath = path.join(dir, 'config.yaml');
    await fs.writeFile(path.join(dir, LLM_DYNAMIC_SCORES_FILE), YAML.stringify({ openrouter_free: 0.2 }));
    await fs.writeFile(path.join(dir, LLM_USER_SCORES_FILE), YAML.stringify({ openrouter_free: 0.9 }));
    const s = new ScoreStore(cfgPath, undefined, {
      clusterProviderNames: ['openrouter_free'],
    });

    await s.load();

    expect(s.get('openrouter_free')).toBe(0.9);
    expect(s.snapshot().openrouter_free).toBe(0.2);
    expect(s.userSnapshot().openrouter_free).toBe(0.9);
  });

  it('lets llm_scores_user.yaml disable a provider without changing the dynamic snapshot', async () => {
    const dir = await tmpDir();
    const cfgPath = path.join(dir, 'config.yaml');
    await fs.writeFile(path.join(dir, LLM_DYNAMIC_SCORES_FILE), YAML.stringify({ openai: 0.8 }));
    await fs.writeFile(path.join(dir, LLM_USER_SCORES_FILE), YAML.stringify({ openai: 0 }));
    const s = new ScoreStore(cfgPath);

    await s.load();

    expect(s.get('openai')).toBe(0);
    expect(s.isUserDisabled('openai')).toBe(true);
    s.boost('openai', 'would otherwise recover');
    expect(s.get('openai')).toBe(0);
    expect(s.snapshot().openai).toBe(0.8);
  });

  it('uses the narrower default score band for cluster providers', () => {
    const s = new ScoreStore('/tmp/fake/config.yaml', undefined, {
      clusterProviderNames: ['openrouter_free'],
    });
    expect(s.get('openrouter_free')).toBe(ScoreStore.CLUSTER_MAX);
    s.set('openrouter_free', 0.9, 'manual high seed');
    expect(s.get('openrouter_free')).toBe(ScoreStore.CLUSTER_MAX);
    for (let i = 0; i < 10; i++) s.decay('openrouter_free', 'fail');
    expect(s.get('openrouter_free')).toBe(ScoreStore.CLUSTER_MIN);
    for (let i = 0; i < 10; i++) s.boost('openrouter_free', 'ok');
    expect(s.get('openrouter_free')).toBe(ScoreStore.CLUSTER_MAX);
  });

  it('lets users widen the cluster score band within global limits', () => {
    const s = new ScoreStore('/tmp/fake/config.yaml', undefined, {
      clusterProviderNames: ['openrouter_free'],
      clusterScoreMin: 0.1,
      clusterScoreMax: 1,
    });
    expect(s.get('openrouter_free')).toBe(1);
    s.set('openrouter_free', 0.05, 'manual low seed');
    expect(s.get('openrouter_free')).toBe(0.1);
  });
});
