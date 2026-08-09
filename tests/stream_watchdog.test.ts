import { describe, expect, it } from 'vitest';
import { detectRepeatedTextLoop } from '../src/llm/stream_watchdog.js';

describe('stream semantic-loop watchdog', () => {
  it('detects a regularly repeated long-form response loop', () => {
    const repeated =
      'The classifier should produce one technology item, but the failing test reports two items, ' +
      'so the same implementation hypothesis is being repeated instead of producing a patch. ';
    const output = Array.from(
      { length: 40 },
      (_, index) => `${repeated}Next I will inspect candidate ${String(index).padStart(3, '0')} and apply the smallest change. `,
    ).join('');

    expect(detectRepeatedTextLoop(output)).toBe(true);
  });

  it('does not mistake repeated TypeScript fixture fields for a response loop', () => {
    const fixturePositions = [200, 1_400, 1_608, 608, 2_400, 384, 1_912, 720, 3_104, 456];
    const objects = fixturePositions.map((padding, index) =>
      `${'x'.repeat(padding)}{ title: "item-${index}", summary: "summary-${index}", ` +
      'publishedAt: "2025-03-15T10:00:00Z", heat: 1000, tags: [] }',
    );
    const output = JSON.stringify({
      thoughts: 'write a large contract test with representative fixtures',
      actions: [{
        tool: 'write_file',
        args: { path: 'tests/modules/aggregator.test.ts', content: objects.join('\n') },
      }],
      done: false,
    });

    expect(output.length).toBeGreaterThan(6_000);
    expect(detectRepeatedTextLoop(output)).toBe(false);
  });
});
