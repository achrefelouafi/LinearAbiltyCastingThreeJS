import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('snare taper uses max(sin, 0) so pow never sees a negative base', () => {
  const src = readFileSync(fileURLToPath(new URL('./SnareMaterial.js', import.meta.url)), 'utf8');
  const hits = [...src.matchAll(/pow\(\s*(?:sin|max\(sin)/g)];
  assert.equal(hits.length, 2);
  assert.equal([...src.matchAll(/pow\(\s*max\(sin\(/g)].length, 2);
  assert.equal([...src.matchAll(/pow\(\s*sin\(/g)].length, 0);
});
