import { getConfig } from './config';

// Cognito のログイン画面を使った OAuth 2.0 認可コード + PKCE フロー
const TOKENS_KEY = 'wa.tokens';
const PKCE_KEY = 'wa.pkce';

interface Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

const redirectUri = () => `${location.origin}/`;

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function loadTokens(): Tokens | null {
  try {
    const raw = localStorage.getItem(TOKENS_KEY);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null;
  }
}

function clearTokens() {
  try {
    localStorage.removeItem(TOKENS_KEY);
  } catch {
    /* noop */
  }
}

async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
  const { cognitoDomain, userPoolClientId } = getConfig();
  const res = await fetch(`${cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: userPoolClientId, ...params }),
  });
  if (!res.ok) throw new Error(`トークンの取得に失敗しました (${res.status})`);
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  const tokens: Tokens = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? loadTokens()?.refreshToken,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
  return tokens;
}

export async function login(): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const { cognitoDomain, userPoolClientId } = getConfig();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: userPoolClientId,
    redirect_uri: redirectUri(),
    scope: 'openid email',
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  });
  location.assign(`${cognitoDomain}/oauth2/authorize?${params}`);
}

/** ログイン画面から戻ってきたときの ?code=... を処理する */
export async function handleRedirect(): Promise<void> {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  if (!code) return;
  const saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? 'null') as {
    verifier: string;
    state: string;
  } | null;
  sessionStorage.removeItem(PKCE_KEY);
  history.replaceState(null, '', url.pathname);
  if (!saved || saved.state !== url.searchParams.get('state')) {
    throw new Error('ログイン情報が一致しません。もう一度ログインしてください');
  }
  await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: saved.verifier,
  });
}

export function isLoggedIn(): boolean {
  return loadTokens() !== null;
}

export async function getAccessToken(): Promise<string | null> {
  const tokens = loadTokens();
  if (!tokens) return null;
  if (tokens.expiresAt - 60_000 > Date.now()) return tokens.accessToken;
  if (!tokens.refreshToken) {
    clearTokens();
    return null;
  }
  try {
    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
    return refreshed.accessToken;
  } catch {
    clearTokens();
    return null;
  }
}

export function logout(): void {
  clearTokens();
  const { cognitoDomain, userPoolClientId } = getConfig();
  const params = new URLSearchParams({ client_id: userPoolClientId, logout_uri: redirectUri() });
  location.assign(`${cognitoDomain}/logout?${params}`);
}

/** ログイン中のユーザーが入っている Cognito グループ (表示の切り替え用。実際の権限確認は API 側で行う) */
export function currentGroups(): string[] {
  const token = loadTokens()?.accessToken;
  if (!token) return [];
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    const groups = payload['cognito:groups'];
    return Array.isArray(groups) ? groups.map(String) : [];
  } catch {
    return [];
  }
}

export const isAdmin = () => currentGroups().includes('admin');

/** ログイン中のユーザーの Cognito ユーザー名 (sub) */
export function currentUsername(): string | undefined {
  const token = loadTokens()?.accessToken;
  if (!token) return undefined;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    return typeof payload.username === 'string' ? payload.username : undefined;
  } catch {
    return undefined;
  }
}
