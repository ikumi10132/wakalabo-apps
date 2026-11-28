import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanEvent, MAX_EVENTS, parseEvents } from '../src/events.js';
import { appFromLog, deviceFromUa, parseLogQuery, rowsQuery, toRow, toSummary } from '../src/logs.js';

const SUB = '11111111-2222-3333-4444-555555555555';

test('画面のログ: おかしな値は捨て、長い文字は切る', () => {
  const now = 1_800_000_000_000;
  assert.equal(cleanEvent({ kind: 'hack' }, now), null);
  assert.equal(cleanEvent('x', now), null);
  const e = cleanEvent({ kind: 'error', message: 'x'.repeat(500), screen: ' ホーム ', at: now - 1000, ms: -5 }, now)!;
  assert.equal(e.message!.length, 300);
  assert.equal(e.screen, 'ホーム');
  assert.equal(e.at, now - 1000);
  assert.equal(e.ms, undefined);
  assert.equal(cleanEvent({ kind: 'view', at: now - 3 * 86_400_000 }, now)!.at, now); // 時計がずれていたらサーバーの時刻
});

test('画面のログ: 登録されたアプリだけ、1 回 20 件まで', () => {
  assert.throws(() => parseEvents({ app: 'evil', events: [] }));
  assert.throws(() => parseEvents({ app: 'kakeibo', events: 'x' }));
  const many = Array.from({ length: 30 }, () => ({ kind: 'view', screen: 'ホーム' }));
  assert.equal(parseEvents({ app: 'kakeibo', events: many }).events.length, MAX_EVENTS);
  assert.equal(parseEvents({ app: 'wakalabo-apps', events: [{ kind: 'view' }, { kind: 'nope' }] }).events.length, 1);
});

test('検索の条件: おかしな値は使わない (検索文に入れるため)', () => {
  assert.deepEqual(parseLogQuery({}), { hours: 24, app: undefined, user: undefined, kind: 'all' });
  const q = parseLogQuery({ hours: '168', app: 'kakeibo', user: SUB, kind: 'error' });
  assert.deepEqual(q, { hours: 168, app: 'kakeibo', user: SUB, kind: 'error' });
  const bad = parseLogQuery({ hours: '5', app: 'x" | delete', user: '" or 1=1', kind: 'drop' });
  assert.deepEqual(bad, { hours: 24, app: undefined, user: undefined, kind: 'all' });
});

test('検索文', () => {
  const s = rowsQuery({ hours: 24, app: 'kakeibo', user: SUB, kind: 'error' });
  assert.match(s, /message\.app = "kakeibo"/);
  assert.match(s, new RegExp(`sub = "${SUB}"`));
  assert.match(s, /status >= 400 or message\.kind = "error"/);
  assert.match(s, /limit 300$/);
});

test('結果を一覧の行にする', () => {
  const emails = new Map([[SUB, 'a@example.com']]);
  const api = toRow(
    {
      '@timestamp': '2026-11-28 01:02:03.456',
      '@log': '123456789012:/wakalabo/access/kakeibo',
      route: 'POST /transactions',
      status: '502',
      latency: '1234',
      sub: SUB,
      ua: 'Mozilla/5.0 (iPad; CPU OS 12_5_7 like Mac OS X) AppleWebKit/605.1.15',
      err: '-',
      ierr: 'Lambda timeout',
    },
    emails,
  );
  assert.deepEqual(api, {
    at: '2026-11-28T01:02:03.456Z',
    app: 'kakeibo',
    kind: 'api',
    user: 'a@example.com',
    action: '明細を追加',
    status: 502,
    ms: 1234,
    detail: 'Lambda timeout',
    device: 'iPad (iOS 12.5)',
  });
  const shortcut = toRow({ '@timestamp': '2026-11-28 01:02:03.000', '@log': '1:/wakalabo/access/mytask', route: 'GET /shortcut/widget', status: '200', latency: '80', sub: '-' }, emails);
  assert.equal(shortcut.user, 'ショートカット・ログインなし');
  assert.equal(shortcut.action, 'ウィジェットを更新');
  const view = toRow({ '@timestamp': '2026-11-28 01:02:03.000', 'message.kind': 'view', 'message.app': 'waripo', 'message.screen': 'ホーム', 'message.sub': SUB }, emails);
  assert.equal(view.kind, 'view');
  assert.equal(view.action, 'ホーム');
  assert.equal(view.user, 'a@example.com');
});

test('集計をアプリごとにまとめる', () => {
  const s = toSummary(
    [{ '@log': '1:/wakalabo/access/kakeibo', n: '10', avgMs: '120.4', p95: '480' }],
    [
      { '@log': '1:/wakalabo/access/kakeibo', cls: '5', n: '2' },
      { '@log': '1:/wakalabo/access/kakeibo', cls: '4', n: '3' },
    ],
    [
      { 'message.app': 'kakeibo', 'message.kind': 'view', n: '7' },
      { 'message.app': 'mytask', 'message.kind': 'error', n: '1' },
    ],
  );
  assert.deepEqual(s, [
    { app: 'kakeibo', requests: 10, serverErrors: 2, clientErrors: 3, avgMs: 120, p95Ms: 480, views: 7, screenErrors: 0 },
    { app: 'mytask', requests: 0, serverErrors: 0, clientErrors: 0, views: 0, screenErrors: 1 },
  ]);
});

test('端末とアプリの見分け方', () => {
  assert.equal(deviceFromUa('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)'), 'iPhone (iOS 18.1)');
  assert.equal(deviceFromUa('Shortcuts/1 CFNetwork/1.0 Darwin/24'), 'iPhone のショートカット');
  assert.equal(deviceFromUa('-'), undefined);
  assert.equal(appFromLog('1:/aws/lambda/wakalabo-events'), 'wakalabo-apps');
});
