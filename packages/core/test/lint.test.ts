import { describe, it, expect } from 'vitest';
// @ts-expect-error importing mjs helper from scripts
import { checkCrlf, checkLineBudget } from '../../../scripts/lint.mjs';

describe('lint rules', () => {
  it('detects CRLF line endings', () => {
    expect(checkCrlf('foo\r\nbar')).toBe(true);
  });

  it('rejects files exceeding 300 lines unless grandfathered', () => {
    expect(checkLineBudget('packages/core/src/new-file.ts', 350)).toBe(false);
  });
});
