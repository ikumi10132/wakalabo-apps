import type { AdminUser, AppsResponse, CostsResponse } from '../../shared/types';
import { getAccessToken } from './auth';
import { getConfig } from './config';

export class AuthError extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new AuthError('ログインが必要です');
  const res = await fetch(`${getConfig().apiUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (res.status === 401) throw new AuthError('ログインの有効期限が切れました');
  const body = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(body.message ?? `エラーが発生しました (${res.status})`);
  return body;
}

const send = <T>(method: string, path: string, body?: unknown) =>
  call<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const enc = encodeURIComponent;

export interface UserChange {
  enabled?: boolean;
  password?: string;
  apps?: string[];
  isAdmin?: boolean;
}

export const api = {
  apps: () => call<AppsResponse>('/apps'),
  // サーバー側で 12 時間保存している (Cost Explorer は 1 回 0.01 USD のため)。refresh は取り直し
  costs: (refresh = false) => call<CostsResponse>(`/costs${refresh ? '?refresh=1' : ''}`),
  users: () => call<AdminUser[]>('/admin/users'),
  createUser: (body: { email: string; password?: string; apps: string[]; isAdmin: boolean }) =>
    send<{ ok: true }>('POST', '/admin/users', body),
  updateUser: (username: string, body: UserChange) => send<{ ok: true }>('PUT', `/admin/users/${enc(username)}`, body),
  deleteUser: (username: string) => send<{ ok: true }>('DELETE', `/admin/users/${enc(username)}`),
};
