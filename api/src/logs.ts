// ログの検索 (管理者だけ)。CloudWatch Logs Insights で各アプリのロググループをまとめて調べる。
// - /wakalabo/access/<アプリ>: API Gateway のアクセスログ (誰が・どの操作を・結果・応答時間)
// - /wakalabo/events: 画面から届くログ (開いた画面・画面のエラー・表示にかかった時間)
// Logs Insights は調べたデータ量で課金 (1 GB あたり約 0.0076 USD)。2 人の利用なら 1 回あたりほぼ 0 円
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  GetQueryResultsCommand,
  StartQueryCommand,
  type ResultField,
} from '@aws-sdk/client-cloudwatch-logs';
import { SELF_APP_ID } from '../../shared/apps.js';
import {
  ACCESS_LOG_PREFIX,
  actionLabel,
  EVENTS_LOG_GROUP,
  LOG_APPS,
  LOG_HOURS,
  type LogFilterKind,
  type LogKind,
  type LogRow,
  type LogsResponse,
  type LogSummary,
} from '../../shared/logs.js';

const logs = new CloudWatchLogsClient({});
export const ROW_LIMIT = 300;
const SUB_RE = /^[0-9a-f-]{36}$/;

export interface LogQuery {
  hours: number;
  app?: string;
  /** Cognito の sub */
  user?: string;
  kind: LogFilterKind;
}

/** URL の ?hours=&app=&user=&kind= を確かめる。おかしな値は使わない (Logs Insights の検索文に入れるため) */
export function parseLogQuery(q: Record<string, string | undefined>): LogQuery {
  const hours = Number(q.hours);
  const app = LOG_APPS.some((a) => a.id === q.app) ? q.app : undefined;
  const user = q.user && SUB_RE.test(q.user) ? q.user : undefined;
  const kind = (['all', 'api', 'view', 'error'] as const).find((k) => k === q.kind) ?? 'all';
  return { hours: (LOG_HOURS as readonly number[]).includes(hours) ? hours : 24, app, user, kind };
}

// ---------- 検索文 ----------

const userFilter = (q: LogQuery) => (q.user ? `| filter sub = "${q.user}" or message.sub = "${q.user}"\n` : '');

/** 一覧 (新しい順) */
export function rowsQuery(q: LogQuery): string {
  let s =
    'fields @timestamp, @log, route, status, latency, sub, ua, err, ierr, ' +
    'message.kind, message.app, message.screen, message.message, message.ms, message.sub, message.ua\n' +
    // ダッシュボードの API への POST /events は、画面のログそのものなので一覧に出さない
    '| filter (ispresent(route) and route != "POST /events") or ispresent(message.kind)\n';
  if (q.app) s += `| filter ispresent(route) or message.app = "${q.app}"\n`;
  s += userFilter(q);
  if (q.kind === 'api') s += '| filter ispresent(route)\n';
  if (q.kind === 'view') s += '| filter message.kind = "view"\n';
  if (q.kind === 'error') s += '| filter status >= 400 or message.kind = "error"\n';
  return `${s}| sort @timestamp desc\n| limit ${ROW_LIMIT}`;
}

/** アプリごとの件数・応答時間 (API) */
export const apiStatsQuery = (q: LogQuery) =>
  `filter ispresent(route) and route != "POST /events"\n${userFilter(q)}| stats count(*) as n, avg(latency) as avgMs, pct(latency, 95) as p95 by @log`;

/** アプリごとのエラーの件数 (4xx / 5xx) */
export const apiErrorsQuery = (q: LogQuery) =>
  `filter status >= 400 and route != "POST /events"\n${userFilter(q)}| fields floor(status / 100) as cls\n| stats count(*) as n by @log, cls`;

/** アプリごとの画面のログの件数 */
export const eventStatsQuery = (q: LogQuery) =>
  `filter ispresent(message.kind)\n${q.app ? `| filter message.app = "${q.app}"\n` : ''}${userFilter(q)}| stats count(*) as n by message.app, message.kind`;

// ---------- 実行 ----------

/** 今あるロググループ (アプリをまだデプロイし直していないと、アクセスログのグループがない) */
async function existingGroups(): Promise<{ access: string[]; events: boolean }> {
  const names: string[] = [];
  let token: string | undefined;
  do {
    const res = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: '/wakalabo/', nextToken: token }));
    names.push(...(res.logGroups ?? []).map((g) => g.logGroupName!).filter(Boolean));
    token = res.nextToken;
  } while (token);
  return { access: names.filter((n) => n.startsWith(ACCESS_LOG_PREFIX)), events: names.includes(EVENTS_LOG_GROUP) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runQuery(groups: string[], query: string, from: Date, to: Date, limit = ROW_LIMIT): Promise<Record<string, string>[]> {
  if (!groups.length) return [];
  const { queryId } = await logs.send(
    new StartQueryCommand({
      logGroupNames: groups,
      startTime: Math.floor(from.getTime() / 1000),
      endTime: Math.ceil(to.getTime() / 1000),
      queryString: query,
      limit,
    }),
  );
  // API Gateway は 30 秒で打ち切るので、待つのは 20 秒まで
  for (let i = 0; i < 40; i++) {
    await sleep(i < 4 ? 250 : 500);
    const res = await logs.send(new GetQueryResultsCommand({ queryId }));
    if (res.status === 'Complete') return (res.results ?? []).map(toRecord);
    if (res.status === 'Failed' || res.status === 'Cancelled' || res.status === 'Timeout') {
      throw new Error(`ログの検索に失敗しました (${res.status})`);
    }
  }
  throw new Error('ログの検索に時間がかかりすぎました。期間を短くしてください');
}

const toRecord = (fields: ResultField[]): Record<string, string> =>
  Object.fromEntries(fields.filter((f) => f.field && f.value !== undefined).map((f) => [f.field!, f.value!]));

// ---------- 結果を画面向けに ----------

/** "123456789012:/wakalabo/access/kakeibo" → kakeibo */
export const appFromLog = (log: string | undefined) => {
  const name = log?.slice(log.indexOf(':') + 1) ?? '';
  return name.startsWith(ACCESS_LOG_PREFIX) ? name.slice(ACCESS_LOG_PREFIX.length) : SELF_APP_ID;
};

/** User-Agent から端末を短く表す (例: iPad (iOS 12.5)) */
export function deviceFromUa(ua: string | undefined): string | undefined {
  if (!ua || ua === '-') return undefined;
  const ios = /\b(iPad|iPhone|iPod)\b.*? OS (\d+)_(\d+)/.exec(ua);
  if (ios) return `${ios[1]} (iOS ${ios[2]}.${ios[3]})`;
  if (/Shortcuts|WorkflowKit|CFNetwork|Scriptable/i.test(ua)) return 'iPhone のショートカット';
  if (/Macintosh/.test(ua)) return /Mobile\//.test(ua) ? 'iPad' : 'Mac';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  return ua.slice(0, 40);
}

const num = (v: string | undefined) => (v === undefined || v === '' || v === '-' || Number.isNaN(Number(v)) ? undefined : Number(v));
const present = (v: string | undefined) => (v && v !== '-' ? v : undefined);

export function toRow(r: Record<string, string>, emails: Map<string, string>): LogRow {
  const at = new Date(r['@timestamp']?.replace(' ', 'T') + 'Z').toISOString();
  if (r['message.kind']) {
    const kind = r['message.kind'] as LogKind;
    const sub = r['message.sub'];
    return {
      at,
      app: r['message.app'] ?? '',
      kind,
      user: (sub && emails.get(sub)) ?? sub ?? '',
      action: r['message.screen'] ?? (kind === 'perf' ? '表示' : ''),
      ms: num(r['message.ms']),
      detail: r['message.message'],
      device: deviceFromUa(r['message.ua']),
    };
  }
  const app = appFromLog(r['@log']);
  const sub = present(r.sub);
  return {
    at,
    app,
    kind: 'api',
    user: sub ? (emails.get(sub) ?? sub) : 'ショートカット・ログインなし',
    action: actionLabel(app, r.route ?? ''),
    status: num(r.status),
    ms: num(r.latency),
    detail: present(r.err) ?? present(r.ierr),
    device: deviceFromUa(r.ua),
  };
}

export function toSummary(
  apiStats: Record<string, string>[],
  apiErrors: Record<string, string>[],
  eventStats: Record<string, string>[],
): LogSummary[] {
  const map = new Map<string, LogSummary>();
  const get = (app: string) => {
    let s = map.get(app);
    if (!s) map.set(app, (s = { app, requests: 0, serverErrors: 0, clientErrors: 0, views: 0, screenErrors: 0 }));
    return s;
  };
  for (const r of apiStats) {
    const s = get(appFromLog(r['@log']));
    s.requests += num(r.n) ?? 0;
    s.avgMs = num(r.avgMs) === undefined ? undefined : Math.round(num(r.avgMs)!);
    s.p95Ms = num(r.p95) === undefined ? undefined : Math.round(num(r.p95)!);
  }
  for (const r of apiErrors) {
    const s = get(appFromLog(r['@log']));
    if (r.cls === '5') s.serverErrors += num(r.n) ?? 0;
    if (r.cls === '4') s.clientErrors += num(r.n) ?? 0;
  }
  for (const r of eventStats) {
    const app = r['message.app'];
    if (!app) continue;
    const s = get(app);
    if (r['message.kind'] === 'view') s.views += num(r.n) ?? 0;
    if (r['message.kind'] === 'error') s.screenErrors += num(r.n) ?? 0;
  }
  const order = LOG_APPS.map((a) => a.id);
  return [...map.values()].sort((a, b) => order.indexOf(a.app) - order.indexOf(b.app));
}

export async function searchLogs(q: LogQuery, users: { sub: string; email: string }[]): Promise<LogsResponse> {
  const to = new Date();
  const from = new Date(to.getTime() - q.hours * 60 * 60_000);
  const groups = await existingGroups();
  const accessGroups = q.app ? groups.access.filter((g) => g === `${ACCESS_LOG_PREFIX}${q.app}`) : groups.access;
  // 画面のログだけ / API だけ のときは、使わないグループを調べない (調べる量 = 料金を減らす)
  const rowGroups = [
    ...(q.kind === 'view' ? [] : accessGroups),
    ...(q.kind === 'api' || !groups.events ? [] : [EVENTS_LOG_GROUP]),
  ];
  if (!groups.access.length && !groups.events) {
    return { rows: [], summary: [], users, truncated: false, note: 'まだログがありません。各アプリをデプロイし直すと記録が始まります' };
  }
  const [rows, apiStats, apiErrors, eventStats] = await Promise.all([
    runQuery(rowGroups, rowsQuery(q), from, to),
    runQuery(accessGroups, apiStatsQuery(q), from, to, 100),
    runQuery(accessGroups, apiErrorsQuery(q), from, to, 100),
    groups.events ? runQuery([EVENTS_LOG_GROUP], eventStatsQuery(q), from, to, 100) : Promise.resolve([]),
  ]);
  const emails = new Map(users.map((u) => [u.sub, u.email]));
  const missing = LOG_APPS.filter((a) => !groups.access.includes(`${ACCESS_LOG_PREFIX}${a.id}`)).map((a) => a.name);
  return {
    rows: rows.map((r) => toRow(r, emails)),
    summary: toSummary(apiStats, apiErrors, eventStats),
    users,
    truncated: rows.length >= ROW_LIMIT,
    ...(missing.length && { note: `まだ操作のログがないアプリ: ${missing.join('、')} (デプロイし直すと記録が始まります)` }),
  };
}
