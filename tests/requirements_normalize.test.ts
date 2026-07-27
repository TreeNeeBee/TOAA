import { describe, it, expect } from 'vitest';
import { calibratePythonRequirements } from '../src/agents/calibration.js';
import { sanitizeVenvName } from '../src/sandbox/subprocess.js';
import { normalizeTypeScriptTestArgs } from '../src/sandbox/test_args.js';

describe('calibratePythonRequirements', () => {
  it('rewrites common hallucinated Python package aliases and strips version pins', () => {
    const out = calibratePythonRequirements(['sklearn==1.4.*', 'cv2==4.*']);
    expect(out).toContain('scikit-learn');
    expect(out).toContain('opencv-python');
    // 版本锁定被剥离
    expect(out.some((r) => r.includes('=='))).toBe(false);
    // pytest 自动补齐
    expect(out.some((r) => /^pytest$/.test(r))).toBe(true);
  });

  it('strips markdown bullets / quotes / blank lines and dedupes', () => {
    const out = calibratePythonRequirements([
      '- pytest',
      '"requests==2.*"',
      '',
      'pytest',
      '# comment line',
    ]);
    expect(out.filter((r) => /^pytest$/.test(r))).toHaveLength(1);
    expect(out).toContain('requests');
    expect(out.some((r) => r.startsWith('#'))).toBe(false);
    expect(out.some((r) => r.includes('=='))).toBe(false);
  });

  it('always ensures pytest is present', () => {
    const out = calibratePythonRequirements(['requests']);
    expect(out.some((r) => /^pytest$/.test(r))).toBe(true);
  });

  it('strips PEP 440 version specifiers from arbitrary packages', () => {
    const out = calibratePythonRequirements([
      'fastapi==0.110.*',
      'pandas>=1.5,<2',
      'numpy~=1.26',
      'requests!=2.30',
    ]);
    expect(out).toEqual(expect.arrayContaining(['fastapi', 'pandas', 'numpy', 'requests', 'pytest']));
    expect(out.some((r) => /[<>=!~]/.test(r))).toBe(false);
  });

});

describe('sanitizeVenvName', () => {
  it('keeps simple names untouched', () => {
    expect(sanitizeVenvName('myproject')).toBe('myproject');
    expect(sanitizeVenvName('my-proj_1.2')).toBe('my-proj_1.2');
  });
  it('replaces unsafe chars and trims hyphens', () => {
    expect(sanitizeVenvName('hello world!@#')).toBe('hello-world');
    expect(sanitizeVenvName('---')).toBe('venv');
    expect(sanitizeVenvName('')).toBe('venv');
  });
});

describe('normalizeTypeScriptTestArgs', () => {
  it('drops redundant Vitest run tokens that npm would pass as file filters', () => {
    expect(normalizeTypeScriptTestArgs(['run'])).toEqual([]);
    expect(normalizeTypeScriptTestArgs(['--run'])).toEqual([]);
    expect(normalizeTypeScriptTestArgs(['vitest', 'run'])).toEqual([]);
    expect(normalizeTypeScriptTestArgs(['npm', 'test', '--', 'run'])).toEqual([]);
    expect(normalizeTypeScriptTestArgs(['npm', 'run', 'test', '--', '--run'])).toEqual([]);
  });

  it('keeps real test file filters after command normalization', () => {
    expect(normalizeTypeScriptTestArgs(['run', 'tests/unit'])).toEqual(['tests/unit']);
    expect(normalizeTypeScriptTestArgs(['npm', 'test', '--', 'tests/unit/parser.test.ts'])).toEqual([
      'tests/unit/parser.test.ts',
    ]);
    expect(normalizeTypeScriptTestArgs(['vitest', 'run', 'tests/module'])).toEqual(['tests/module']);
  });
});
