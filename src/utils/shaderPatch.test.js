import assert from 'node:assert/strict';
import test from 'node:test';
import { patchOnBeforeCompile } from './shaderPatch.js';

test('composed patches get distinct program cache keys', () => {
  const material = {};
  patchOnBeforeCompile(material, function icePatch() {});
  const iceKey = material.customProgramCacheKey();
  patchOnBeforeCompile(material, function firePatch() {});
  const fireKey = material.customProgramCacheKey();
  assert.notEqual(iceKey, fireKey);
  assert.match(iceKey, /icePatch/);
  assert.match(fireKey, /firePatch/);
  assert.match(fireKey, /icePatch/);
});
