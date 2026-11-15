// AWS の利用料とクレジット (smart-home-dashboard から移管)
import { CostExplorerClient, GetCostAndUsageCommand, type ResultByTime } from '@aws-sdk/client-cost-explorer';
import { FreeTierClient, GetAccountPlanStateCommand } from '@aws-sdk/client-freetier';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { APPS, SELF_APP_ID } from '../../shared/apps.js';
import type { CostsResponse, NamedCost } from '../../shared/types.js';
import { cached, invalidate } from './cache.js';

// Cost Explorer API は 1 回 0.01 USD かかる。
// サービス別とアプリ別は GroupBy を 2 つ指定して 1 回でまとめて取り、結果を 12 時間保存する
// (呼び出しは 1 日 2 回まで。最大でも 1 か月 約 0.6 USD)
export const COST_TTL_MS = 12 * 60 * 60_000;
const MAX_SERVICES = 8;
const TAG_KEY = 'app';
export const UNTAGGED = '共通・その他';

// Cost Explorer と Free Tier はグローバルサービスで、API の窓口が us-east-1 にある。
// リソースは作らず読み取るだけ
const ce = new CostExplorerClient({ region: 'us-east-1' });
const freeTier = new FreeTierClient({ region: 'us-east-1' });
const ssm = new SSMClient({});

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** 先月 1 日〜今日 (今日は含まない、UTC) の期間 */
export function costPeriod(now: Date): { start: string; thisMonth: string; end: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    start: ymd(new Date(Date.UTC(y, m - 1, 1))),
    thisMonth: ymd(new Date(Date.UTC(y, m, 1))),
    end: ymd(new Date(Date.UTC(y, m, now.getUTCDate()))),
  };
}

export type Usage = Required<Pick<CostsResponse, 'currency' | 'thisMonth' | 'lastMonth'>> & Pick<CostsResponse, 'appsNote'>;

const round2 = (n: number) => Math.round(n * 100) / 100;
const sum = (list: NamedCost[]) => round2(list.reduce((s, x) => s + x.amount, 0));

const appName = (id: string) =>
  id === SELF_APP_ID ? 'このダッシュボード' : (APPS.find((a) => a.id === id)?.name ?? id);

/** "app$kakeibo" → "kakeibo"、"app$" (タグなし) → "" */
const tagValue = (key: string | undefined) => (key?.startsWith(`${TAG_KEY}$`) ? key.slice(TAG_KEY.length + 1) : '');

function addTo(map: Map<string, number>, key: string, amount: number) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

const toList = (map: Map<string, number>) =>
  [...map.entries()]
    .map(([name, amount]) => ({ name, amount }))
    .filter((x) => Math.abs(x.amount) >= 0.005)
    .sort((a, b) => b.amount - a.amount);

/** Cost Explorer の「月 × サービス × app タグ」の結果を、サービス別とアプリ別に集計する */
export function summarize(results: ResultByTime[], period: { start: string; thisMonth: string }): Usage {
  let currency = 'USD';
  const month = (start: string) => {
    const services = new Map<string, number>();
    const apps = new Map<string, number>();
    for (const g of results.find((r) => r.TimePeriod?.Start === start)?.Groups ?? []) {
      const metric = g.Metrics?.UnblendedCost;
      if (metric?.Unit) currency = metric.Unit;
      const amount = Number(metric?.Amount ?? 0);
      addTo(services, g.Keys?.[0] ?? '不明', amount);
      const tag = tagValue(g.Keys?.[1]);
      addTo(apps, tag ? appName(tag) : UNTAGGED, amount);
    }
    return { services: toList(services), apps: toList(apps) };
  };

  const current = month(period.thisMonth);
  const last = month(period.start);
  const top = current.services.slice(0, MAX_SERVICES).map((s) => ({ ...s, amount: round2(s.amount) }));
  const rest = current.services.slice(MAX_SERVICES);
  if (rest.length > 0) top.push({ name: 'その他', amount: sum(rest) });

  const total = sum(current.services);
  const allUntagged = total > 0 && current.apps.every((a) => a.name === UNTAGGED);
  return {
    currency,
    thisMonth: {
      start: period.thisMonth,
      total,
      services: top,
      apps: current.apps.map((a) => ({ ...a, amount: round2(a.amount) })),
    },
    lastMonth: { start: period.start, total: sum(last.services) },
    ...(allUntagged && {
      appsNote:
        'アプリ別に分けるには、請求コンソールの「コスト配分タグ」で app タグを有効にしてください (反映まで最大 24 時間。有効にした日以降の利用分から分かれます)',
    }),
  };
}

function explain(e: unknown): Error {
  const name = e instanceof Error ? e.name : '';
  if (name === 'DataUnavailableException') {
    return new Error('Cost Explorer がまだ有効になっていません。請求コンソールで Cost Explorer を一度開くと、約 24 時間後から表示できます');
  }
  if (name === 'AccessDeniedException') {
    return new Error('利用料を読み取る権限がありません。プランで Cost Explorer が使えるか確認してください');
  }
  return e instanceof Error ? e : new Error(String(e));
}

async function fetchUsage(): Promise<Usage> {
  const period = costPeriod(new Date());
  const results: ResultByTime[] = [];
  let token: string | undefined;
  do {
    const res = await ce.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: period.start, End: period.end },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        GroupBy: [
          { Type: 'DIMENSION', Key: 'SERVICE' },
          { Type: 'TAG', Key: TAG_KEY },
        ],
        // 無料プランのクレジットで相殺される前の「実際に使った額」を見たいので除外する
        Filter: { Not: { Dimensions: { Key: 'RECORD_TYPE', Values: ['Credit', 'Refund'] } } },
        NextPageToken: token,
      }),
    );
    results.push(...(res.ResultsByTime ?? []));
    token = res.NextPageToken;
  } while (token);
  return summarize(results, period);
}

async function fetchPlan(): Promise<NonNullable<CostsResponse['plan']>> {
  const p = await freeTier.send(new GetAccountPlanStateCommand({}));
  return {
    type: p.accountPlanType ?? 'UNKNOWN',
    status: p.accountPlanStatus,
    remainingCredits: p.accountPlanRemainingCredits?.amount,
    creditUnit: p.accountPlanRemainingCredits?.unit,
    expiresAt: p.accountPlanExpirationDate?.toISOString(),
  };
}

// 利用額 (Cost Explorer) とプラン情報 (Free Tier API) は片方だけでも表示する
export async function fetchCosts(
  usage: () => Promise<Usage> = fetchUsage,
  planState: () => Promise<NonNullable<CostsResponse['plan']>> = fetchPlan,
): Promise<CostsResponse> {
  const [u, p] = await Promise.allSettled([usage(), planState()]);
  if (u.status === 'rejected') console.warn('GetCostAndUsage failed', u.reason);
  if (p.status === 'rejected') console.warn('GetAccountPlanState failed', p.reason);
  if (u.status === 'rejected' && p.status === 'rejected') throw explain(u.reason);
  return {
    ...(u.status === 'fulfilled' ? u.value : { costsError: explain(u.reason).message }),
    plan: p.status === 'fulfilled' ? p.value : undefined,
    fetchedAt: new Date().toISOString(),
  };
}

// 利用額が取れなかったときは 1 時間で取り直す
export const isFresh = (c: CostsResponse | undefined, now = Date.now()): c is CostsResponse =>
  !!c?.fetchedAt && now - new Date(c.fetchedAt).getTime() < (c.costsError ? 60 * 60_000 : COST_TTL_MS);

// Lambda はしばらく使わないとメモリが消えるので、結果を SSM パラメータ (標準・無料) にも保存する
async function loadSaved(name: string): Promise<CostsResponse | undefined> {
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: name }));
    return JSON.parse(res.Parameter?.Value ?? '{}') as CostsResponse;
  } catch (e) {
    console.warn('cost cache read failed', e);
    return undefined;
  }
}

async function getCostsUncached(cacheParam: string, force: boolean): Promise<CostsResponse> {
  const saved = force ? undefined : await loadSaved(cacheParam);
  if (isFresh(saved)) return saved;
  const fresh = await fetchCosts();
  await ssm
    .send(new PutParameterCommand({ Name: cacheParam, Value: JSON.stringify(fresh), Type: 'String', Overwrite: true }))
    .catch((e) => console.warn('cost cache write failed', e));
  return fresh;
}

/** force: 保存した結果を使わずに取り直す (1 回 0.01 USD かかるので画面のボタンからだけ) */
export function getCosts(cacheParam: string, force = false): Promise<CostsResponse> {
  if (force) invalidate('costs');
  return cached('costs', 60 * 60_000, () => getCostsUncached(cacheParam, force));
}
