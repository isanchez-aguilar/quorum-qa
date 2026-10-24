import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greeting } from './index.mjs';
test('default and custom punctuation', () => {
  assert.equal(greeting('Sam'), 'Hello, Sam!');
  assert.equal(greeting('Sam', '?'), 'Hello, Sam?');
  assert.equal(greeting('Sam', ''), 'Hello, Sam');
});
