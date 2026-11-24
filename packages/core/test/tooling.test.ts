import { describe, it, expect } from 'vitest';
import { accessSync, constants, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('tooling and git hooks', () => {
  const root = resolve(__dirname, '../../../');

  it('has executable .githooks/pre-commit with lint and typecheck', () => {
    const hookPath = resolve(root, '.githooks/pre-commit');
    let isExecutable = false;
    try {
      accessSync(hookPath, constants.X_OK);
      isExecutable = true;
    } catch {
      isExecutable = false;
    }
    expect(isExecutable).toBe(true);

    const content = readFileSync(hookPath, 'utf8');
    expect(content).toContain('npm run lint');
    expect(content).toContain('npm run typecheck');
  });

  it('configures prepare script in package.json to set hooks path', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(pkg.scripts?.prepare).toBeDefined();
    expect(pkg.scripts.prepare).toContain('core.hooksPath');
  });
});
