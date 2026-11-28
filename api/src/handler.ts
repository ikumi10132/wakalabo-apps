import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { APPS } from '../../shared/apps.js';
import type { AppsResponse } from '../../shared/types.js';
import { getCosts } from './costs.js';
import { parseLogQuery, searchLogs } from './logs.js';
import * as users from './users.js';

const COST_CACHE_PARAM = process.env.COST_CACHE_PARAM ?? '/wakalabo-apps/cache/costs';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

function parseBody(event: APIGatewayProxyEventV2WithJWTAuthorizer): Record<string, unknown> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* 下でエラーにする */
  }
  throw new HttpError(400, '本文は JSON オブジェクトで送ってください');
}

/** 指定されたアプリ id のうち、登録済みのものだけを残す */
const validApps = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? APPS.map((a) => a.id).filter((id) => v.includes(id)) : undefined;

interface Caller {
  username: string;
  groups: string[];
  isAdmin: boolean;
}

function caller(event: APIGatewayProxyEventV2WithJWTAuthorizer): Caller {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const username = typeof claims.username === 'string' ? claims.username : typeof claims.sub === 'string' ? claims.sub : '';
  if (!username) throw new HttpError(401, 'ログインが必要です');
  const groups = users.groupsFromClaim(claims['cognito:groups']);
  return { username, groups, isAdmin: groups.includes(users.ADMIN_GROUP_NAME) };
}

/** 管理者はすべてのアプリ、それ以外は使えるアプリだけ */
export function visibleApps(c: Pick<Caller, 'groups' | 'isAdmin'>) {
  if (c.isAdmin) return APPS;
  const allowed = users.appsFromGroups(c.groups);
  return APPS.filter((a) => allowed.includes(a.id));
}

async function adminRoute(event: APIGatewayProxyEventV2WithJWTAuthorizer, c: Caller): Promise<APIGatewayProxyStructuredResultV2> {
  if (!c.isAdmin) throw new HttpError(403, '管理者だけが使える機能です');
  const target = event.pathParameters?.username ? decodeURIComponent(event.pathParameters.username) : '';
  try {
    switch (event.routeKey) {
      case 'GET /costs':
        return json(200, await getCosts(COST_CACHE_PARAM, event.queryStringParameters?.refresh === '1'));

      case 'GET /admin/users':
        return json(200, await users.listUsers());

      case 'GET /admin/logs':
        return json(200, await searchLogs(parseLogQuery(event.queryStringParameters ?? {}), await users.subEmails()));

      case 'POST /admin/users': {
        const b = parseBody(event);
        const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
        if (!EMAIL_RE.test(email)) throw new HttpError(400, 'メールアドレスを正しく入力してください');
        const password = typeof b.password === 'string' && b.password ? b.password : undefined;
        await users.createUser(email, password, validApps(b.apps) ?? [], b.isAdmin === true);
        return json(201, { ok: true });
      }

      case 'PUT /admin/users/{username}': {
        const b = parseBody(event);
        const self = target === c.username;
        if (self && (b.enabled === false || b.isAdmin === false)) {
          throw new HttpError(400, '自分自身の管理者権限を外したり、停止したりはできません');
        }
        if (typeof b.enabled === 'boolean') await users.setEnabled(target, b.enabled);
        if (typeof b.password === 'string' && b.password) await users.resetPassword(target, b.password);
        const apps = validApps(b.apps);
        const isAdmin = typeof b.isAdmin === 'boolean' ? b.isAdmin : undefined;
        if (apps || isAdmin !== undefined) {
          const current = (await users.listUsers()).find((u) => u.username === target);
          if (!current) throw new HttpError(404, 'ユーザーが見つかりません');
          await users.setAccess(target, current, { apps, isAdmin });
        }
        return json(200, { ok: true });
      }

      case 'DELETE /admin/users/{username}':
        if (target === c.username) throw new HttpError(400, '自分自身は削除できません');
        await users.deleteUser(target);
        return json(200, { ok: true });

      default:
        throw new HttpError(404, 'Not Found');
    }
  } catch (e) {
    const message = users.cognitoMessage(e);
    if (message) throw new HttpError(400, message);
    throw e;
  }
}

/**
 * 画面に返してよいエラー文か。アプリが自分で投げた Error (日本語の説明) だけを返し、
 * AWS の SDK のエラー (アカウント ID や ARN が入ることがある) やプログラムの誤り (TypeError など) は返さない
 */
const publicMessage = (e: unknown) =>
  e instanceof Error && e.constructor === Error ? e.message : 'サーバーでエラーが発生しました。時間をおいてもう一度お試しください';

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const c = caller(event);
    // 管理者がアプリの権限を変えたら、ログインし直さなくてもすぐ反映する (聞けなければトークンの中身を使う)
    try {
      c.groups = await users.groupsOf(c.username);
      c.isAdmin = c.groups.includes(users.ADMIN_GROUP_NAME);
    } catch (e) {
      console.warn('groups: fallback to token', (e as Error).message);
    }
    if (event.routeKey === 'GET /apps') {
      const res: AppsResponse = {
        me: { username: c.username, email: await users.getEmail(c.username), isAdmin: c.isAdmin },
        apps: visibleApps(c),
      };
      return json(200, res);
    }
    return await adminRoute(event, c);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { message: e.message });
    console.error(e);
    return json(500, { message: publicMessage(e) });
  }
}
