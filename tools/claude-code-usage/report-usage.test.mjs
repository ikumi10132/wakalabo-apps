import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeTranscript, toEntries } from './report-usage.mjs';

const line = (o) => JSON.stringify(o);
const asst = (id, model, usage) => line({ type: 'assistant', uuid: `u-${id}`, message: { id, model, usage } });

test('同じメッセージ id は最後の行だけ数え、モデルごとに合計する', () => {
  const text = [
    line({ type: 'user', message: { role: 'user', content: 'hi' } }),
    asst('m1', 'claude-sonnet-5-5', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }),
    asst('m1', 'claude-sonnet-5-5', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }),
    asst('m2', 'claude-sonnet-5-5', { input_tokens: 3, output_tokens: 4 }),
    asst('m3', 'claude-haiku-5-5', { input_tokens: 1, output_tokens: 2 }),
    asst('m4', '<synthetic>', { input_tokens: 0, output_tokens: 0 }),
    'これは JSON ではない行',
    '',
  ].join('\n');
  assert.deepEqual(summarizeTranscript(text), {
    'claude-sonnet-5-5': { input: 13, output: 24, cacheRead: 100, cacheWrite: 5, requests: 2 },
    'claude-haiku-5-5': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, requests: 1 },
  });
});

test('送信済みを引いた差分だけ送り、増えていなければ送らない', () => {
  const totals = { a: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, requests: 3 } };
  assert.deepEqual(toEntries(totals, {}), [{ source: 'claude-code', model: 'a', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, requests: 3 }]);
  assert.deepEqual(toEntries(totals, { a: { input: 4, output: 5, cacheRead: 0, cacheWrite: 0, requests: 1 } }), [
    { source: 'claude-code', model: 'a', input: 6, output: 0, cacheRead: 0, cacheWrite: 0, requests: 2 },
  ]);
  assert.deepEqual(toEntries(totals, totals), []);
  // 記録が短くなっても (整理されたとき) マイナスにはしない
  assert.deepEqual(toEntries({ a: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1 } }, totals), []);
});
