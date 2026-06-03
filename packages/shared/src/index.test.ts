import { describe, expect, it } from 'vitest';

import { workspacePackageName } from './index.js';

describe('@xxyy/shared smoke test', () => {
  it('exports its workspace package name', () => {
    expect(workspacePackageName).toBe('@xxyy/shared');
  });
});
