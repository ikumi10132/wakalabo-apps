import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aggregate,
  generateKey,
  hashKey,
  jstDate,
  parseEntries,
  parseMonth,
  parseUsageSk,
  parseUser,
  usageSk,
  UsageError,
} from '../src/usage-core.js';

test('明細 1 件でも entries でも受け付け、数は整数に限る', () => {
  const one = parseEntries({ source: 'claude-code', model: 'claude-sonnet-5-5', input: 10, output: 5 });
  assert.deepEqual(one, [{ source: 'claude-code', model: 'claude-sonnet-5-5', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, requests: 1 }]);
  assert.equal(parseEntries({ entries: [{ source: 'app:kakeibo', model: 'm', input: 1 }, { source: 'claude-code', input: 2 }] }).length, 2);
  assert.throws(() => parseEntries({ source: 'claude-code', input: -1 }), UsageError);
  assert.throws(() => parseEntries({ source: 'claude-code', input: 1.5 }), UsageError);
  assert.throws(() => parseEntries({ source: 'claude-code', input: '10' }), UsageError);
  assert.throws(() => parseEntries({ source: 'claude-code', input: 2e9 }), UsageError);
  assert.throws(() => parseEntries({ source: 'other', input: 1 }), UsageError);
  assert.throws(() => parseEntries({ source: 'app:Bad Id', input: 1 }), UsageError);
  assert.throws(() => parseEntries({ entries: [] }), UsageError);
  assert.throws(() => parseEntries({ entries: Array.from({ length: 51 }, () => ({ source: 'claude-code' })) }), UsageError);
});

test('モデル名は DB のキーを壊さない文字だけにする', () => {
  const [e] = parseEntries({ source: 'claude-code', model: 'a#b c/d:e' });
  assert.equal(e?.model, 'a_b_c/d:e');
  assert.equal(parseEntries({ source: 'claude-code' })[0]?.model, 'unknown');
  assert.deepEqual(parseUsageSk(usageSk('2026-11-23', 'app:kakeibo', e!.model)), { date: '2026-11-23', source: 'app:kakeibo', model: 'a_b_c/d:e' });
});

test('利用者の名前と月の検証', () => {
  assert.equal(parseUser('ikumi@example.com'), 'ikumi@example.com');
  assert.throws(() => parseUser('a#b'), UsageError);
  assert.throws(() => parseUser(undefined), UsageError);
  assert.equal(parseMonth('2026-11'), '2026-11');
  assert.equal(parseMonth(undefined, new Date('2026-11-30T16:00:00Z')), '2026-12'); // 日本時間では 12 月 1 日
  assert.throws(() => parseMonth('2026-13'), UsageError);
  assert.throws(() => parseMonth('2026-1'), UsageError);
});

test('日付は日本時間', () => {
  assert.equal(jstDate(new Date('2026-11-22T15:30:00Z')), '2026-11-23');
  assert.equal(jstDate(new Date('2026-11-22T14:59:59Z')), '2026-11-22');
});

test('送信用キーは wk_ で始まり、保存するのはハッシュだけ', () => {
  const { key, id } = generateKey();
  assert.match(key, /^wk_[A-Za-z0-9_-]{43}$/);
  assert.equal(id, hashKey(key));
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.notEqual(generateKey().key, key);
});

test('月の明細をユーザー別・発生元別・日別に集計する', () => {
  const row = (user: string, date: string, source: string, input: number, output: number) => ({
    pk: `U#${user}`,
    sk: usageSk(date, source, 'm'),
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    requests: 1,
  });
  const res = aggregate(
    [
      row('u1', '2026-11-01', 'claude-code', 100, 50),
      row('u1', '2026-11-02', 'claude-code', 10, 5),
      row('u1', '2026-11-02', 'app:kakeibo', 1, 1),
      row('u2', '2026-11-02', 'claude-code', 500, 500),
      row('u1', '2026-10-31', 'claude-code', 9999, 9999), // 別の月は入れない
    ],
    '2026-11',
    (n) => (n === 'u1' ? 'ikumi@example.com' : undefined),
  );
  assert.equal(res.total.input, 611);
  assert.deepEqual(res.users.map((u) => [u.email, u.totals.input + u.totals.output]), [['u2', 1000], ['ikumi@example.com', 167]]);
  assert.deepEqual(res.users[1]?.sources.map((s) => s.source), ['claude-code', 'app:kakeibo']);
  assert.deepEqual(res.daily.map((d) => [d.date, d.totals.input]), [['2026-11-01', 100], ['2026-11-02', 511]]);
});
