import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costPeriod, fetchCosts, isFresh, summarize, UNTAGGED } from '../src/costs.js';
import { visibleApps } from '../src/handler.js';
import { appsFromGroups, groupsFromClaim } from '../src/users.js';

const group = (service: string, tag: string, amount: string) => ({
  Keys: [service, `app$${tag}`],
  Metrics: { UnblendedCost: { Amount: amount, Unit: 'USD' } },
});

test('サービス別とアプリ別を 1 回の結果から集計する', () => {
  const period = { start: '2026-10-01', thisMonth: '2026-11-01' };
  const u = summarize(
    [
      { TimePeriod: { Start: '2026-10-01', End: '2026-11-01' }, Groups: [group('AWS Lambda', 'kakeibo', '0.40')] },
      {
        TimePeriod: { Start: '2026-11-01', End: '2026-11-15' },
        Groups: [
          group('AWS Lambda', 'kakeibo', '0.10'),
          group('AWS Lambda', 'smart-home', '0.20'),
          group('Amazon CloudFront', 'kakeibo', '0.05'),
          group('AWS Cost Explorer', '', '0.30'),
          group('Tax', '', '0.001'), // 0.005 未満は出さない
        ],
      },
    ],
    period,
  );
  assert.equal(u.thisMonth.total, 0.65);
  assert.equal(u.lastMonth.total, 0.4);
  assert.deepEqual(u.thisMonth.services.map((s) => s.name), ['AWS Lambda', 'AWS Cost Explorer', 'Amazon CloudFront']);
  assert.deepEqual(u.thisMonth.apps, [
    { name: UNTAGGED, amount: 0.3 },
    { name: 'おうちダッシュボード', amount: 0.2 },
    { name: '家計簿', amount: 0.15 },
  ]);
  assert.equal(u.appsNote, undefined);
});

test('タグがまだ集計に使えないときは案内を出す', () => {
  const u = summarize(
    [{ TimePeriod: { Start: '2026-11-01', End: '2026-11-15' }, Groups: [group('AWS Lambda', '', '0.10')] }],
    { start: '2026-10-01', thisMonth: '2026-11-01' },
  );
  assert.match(u.appsNote ?? '', /コスト配分タグ/);
});

test('期間は先月 1 日〜今日 (UTC)', () => {
  assert.deepEqual(costPeriod(new Date('2026-11-15T10:00:00Z')), { start: '2026-10-01', thisMonth: '2026-11-01', end: '2026-11-15' });
  assert.deepEqual(costPeriod(new Date('2026-01-01T00:00:00Z')), { start: '2025-12-01', thisMonth: '2026-01-01', end: '2026-01-01' });
});

test('利用額が取れなくてもクレジットは表示し、取り直しは 1 時間後', async () => {
  const err = Object.assign(new Error('x'), { name: 'DataUnavailableException' });
  const c = await fetchCosts(
    () => Promise.reject(err),
    () => Promise.resolve({ type: 'FREE', remainingCredits: 100 }),
  );
  assert.match(c.costsError ?? '', /有効/);
  assert.equal(c.plan?.remainingCredits, 100);
  const now = new Date(c.fetchedAt).getTime();
  assert.ok(isFresh(c, now + 30 * 60_000));
  assert.ok(!isFresh(c, now + 61 * 60_000));
});

test('グループから見られるアプリを決める', () => {
  assert.deepEqual(groupsFromClaim('[admin app-kakeibo]'), ['admin', 'app-kakeibo']);
  assert.deepEqual(groupsFromClaim(['app-kakeibo']), ['app-kakeibo']);
  assert.deepEqual(appsFromGroups(['app-kakeibo', 'app-unknown']), ['kakeibo']);
  assert.deepEqual(visibleApps({ groups: ['app-kakeibo'], isAdmin: false }).map((a) => a.id), ['kakeibo']);
  assert.equal(visibleApps({ groups: [], isAdmin: true }).length >= 2, true);
  assert.deepEqual(visibleApps({ groups: [], isAdmin: false }), []);
});
