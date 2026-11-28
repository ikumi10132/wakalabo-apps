// 各アプリの画面から届くログ (どの画面を開いたか・画面のエラー・表示にかかった時間) を受け取り、
// CloudWatch Logs (/wakalabo/events) に 1 件 1 行で書く。API Gateway の POST /events から呼ばれる (W-SSO のログインが必要)
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { APPS, SELF_APP_ID } from '../../shared/apps.js';
import type { ClientEvent, ClientEventKind } from '../../shared/logs.js';

const APP_IDS = new Set([SELF_APP_ID, ...APPS.map((a) => a.id)]);
const KINDS = new Set<ClientEventKind>(['view', 'error', 'perf']);
export const MAX_EVENTS = 20;
const DAY_MS = 24 * 60 * 60_000;

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** 1 件分を確かめて、ログに書く形にする。おかしなものは捨てる (null) */
export function cleanEvent(v: unknown, now = Date.now()): Required<Pick<ClientEvent, 'kind' | 'at'>> & ClientEvent | null {
  if (!v || typeof v !== 'object') return null;
  const e = v as Record<string, unknown>;
  if (typeof e.kind !== 'string' || !KINDS.has(e.kind as ClientEventKind)) return null;
  const at = typeof e.at === 'number' && Math.abs(e.at - now) < DAY_MS ? Math.round(e.at) : now;
  const ms = typeof e.ms === 'number' && Number.isFinite(e.ms) && e.ms >= 0 && e.ms < 10 * 60_000 ? Math.round(e.ms) : undefined;
  return {
    kind: e.kind as ClientEventKind,
    at,
    screen: text(e.screen, 40),
    message: text(e.message, 300),
    ms,
  };
}

export function parseEvents(body: unknown): { app: string; events: NonNullable<ReturnType<typeof cleanEvent>>[] } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.app !== 'string' || !APP_IDS.has(b.app)) throw new Error('app が不正です');
  if (!Array.isArray(b.events)) throw new Error('events が不正です');
  const events = b.events.slice(0, MAX_EVENTS).map((e) => cleanEvent(e)).filter((e) => e !== null);
  return { app: b.app, events };
}

const json = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== 'string') return json(401, { message: 'ログインが必要です' });
  let parsed: ReturnType<typeof parseEvents>;
  try {
    const raw = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? '{}');
    parsed = parseEvents(JSON.parse(raw));
  } catch (e) {
    return json(400, { message: e instanceof Error ? e.message : '不正な内容です' });
  }
  const ua = event.requestContext.http.userAgent?.slice(0, 300);
  // Lambda のログの形式を JSON にしているので、オブジェクトを渡すと message の中に項目ごとに入る (Logs Insights で message.kind などで探せる)
  for (const e of parsed.events) console.info({ ...e, app: parsed.app, sub, ua });
  return json(200, { ok: true, accepted: parsed.events.length });
}
