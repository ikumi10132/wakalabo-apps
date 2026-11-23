// トークン使用量の、AWS に触れない部分 (検証・集計・キー)。テストしやすいように DB の処理と分けている
import { createHash, randomBytes } from 'node:crypto';
import type { UsageResponse, UsageSourceTotals, UsageTotals, UsageUser } from '../../shared/types.js';

export const MAX_ENTRIES = 50;
const MAX_COUNT = 1_000_000_000;
const SOURCE_RE = /^(claude-code|app:[a-z0-9][a-z0-9-]{0,40})$/;
const USER_RE = /^[A-Za-z0-9@._+-]{1,128}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface UsageEntry {
  source: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
}

export class UsageError extends Error {}

export const emptyTotals = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 });

export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    requests: a.requests + b.requests,
  };
}

/** モデル名は DB のキーの一部になるので、使える文字だけにする (区切りの # は使わせない) */
export const cleanModel = (v: unknown): string =>
  typeof v === 'string' && v.trim() ? v.trim().replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, 80) : 'unknown';

function count(v: unknown, name: string): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_COUNT) {
    throw new UsageError(`${name} は 0 以上の整数で送ってください`);
  }
  return v;
}

/** 送られてきた本文から、保存する明細を取り出す。`{ entries: [...] }` か、明細 1 件そのまま */
export function parseEntries(body: Record<string, unknown>): UsageEntry[] {
  const list = Array.isArray(body.entries) ? body.entries : [body];
  if (list.length === 0 || list.length > MAX_ENTRIES) throw new UsageError(`明細は 1〜${MAX_ENTRIES} 件で送ってください`);
  return list.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UsageError(`${i + 1} 件目の形式が正しくありません`);
    const e = raw as Record<string, unknown>;
    if (typeof e.source !== 'string' || !SOURCE_RE.test(e.source)) {
      throw new UsageError('source は claude-code か app:<アプリの id> で送ってください');
    }
    const entry: UsageEntry = {
      source: e.source,
      model: cleanModel(e.model),
      input: count(e.input, 'input'),
      output: count(e.output, 'output'),
      cacheRead: count(e.cacheRead, 'cacheRead'),
      cacheWrite: count(e.cacheWrite, 'cacheWrite'),
      requests: e.requests === undefined ? 1 : count(e.requests, 'requests'),
    };
    return entry;
  });
}

/** service キーで送るときの、利用者の名前 (Cognito のユーザー名かメールアドレス) */
export function parseUser(v: unknown): string {
  if (typeof v !== 'string' || !USER_RE.test(v)) throw new UsageError('user (利用者の名前) を正しく指定してください');
  return v;
}

/** 日本時間の日付 (YYYY-MM-DD) */
export const jstDate = (now: Date): string => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

export function parseMonth(v: unknown, now = new Date()): string {
  if (v === undefined || v === '') return jstDate(now).slice(0, 7);
  if (typeof v !== 'string' || !MONTH_RE.test(v)) throw new UsageError('month は YYYY-MM で指定してください');
  return v;
}

// ---------- DB のキー ----------
export const usagePk = (username: string) => `U#${username}`;
export const usageSk = (date: string, source: string, model: string) => `D#${date}#${source}#${model}`;

export function parseUsageSk(sk: string): { date: string; source: string; model: string } | null {
  const m = /^D#(\d{4}-\d{2}-\d{2})#([^#]+)#(.+)$/.exec(sk);
  return m ? { date: m[1]!, source: m[2]!, model: m[3]! } : null;
}

// ---------- 送信用キー ----------
/** 送信用キーを作る。32 バイトの乱数なので、DB には SHA-256 だけを保存すれば十分 (元のキーは作った時に 1 回だけ見せる) */
export function generateKey(): { key: string; id: string } {
  const key = `wk_${randomBytes(32).toString('base64url')}`;
  return { key, id: hashKey(key) };
}

export const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

// ---------- 集計 ----------
export interface UsageRow extends UsageTotals {
  pk: string;
  sk: string;
}

/** 月の明細 (DB の行) を、ユーザー別・日別に集計する */
export function aggregate(rows: UsageRow[], month: string, emailOf: (username: string) => string | undefined): UsageResponse {
  const users = new Map<string, { totals: UsageTotals; sources: Map<string, UsageTotals> }>();
  const days = new Map<string, UsageTotals>();
  let total = emptyTotals();

  for (const r of rows) {
    const k = parseUsageSk(r.sk);
    if (!k || !k.date.startsWith(month) || !r.pk.startsWith('U#')) continue;
    const username = r.pk.slice(2);
    const t: UsageTotals = { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, requests: r.requests };
    const u = users.get(username) ?? { totals: emptyTotals(), sources: new Map<string, UsageTotals>() };
    u.totals = addTotals(u.totals, t);
    u.sources.set(k.source, addTotals(u.sources.get(k.source) ?? emptyTotals(), t));
    users.set(username, u);
    days.set(k.date, addTotals(days.get(k.date) ?? emptyTotals(), t));
    total = addTotals(total, t);
  }

  const weight = (t: UsageTotals) => t.input + t.output + t.cacheRead + t.cacheWrite;
  const list: UsageUser[] = [...users.entries()]
    .map(([username, u]) => ({
      username,
      email: emailOf(username) ?? username,
      totals: u.totals,
      sources: [...u.sources.entries()]
        .map(([source, totals]): UsageSourceTotals => ({ source, totals }))
        .sort((a, b) => weight(b.totals) - weight(a.totals)),
    }))
    .sort((a, b) => weight(b.totals) - weight(a.totals));

  return {
    month,
    total,
    users: list,
    daily: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, totals]) => ({ date, totals })),
    fetchedAt: new Date().toISOString(),
  };
}
