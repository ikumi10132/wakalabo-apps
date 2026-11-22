import { configure } from './wsso-client';

export interface AppConfig {
  apiUrl: string;
  /** W-SSO のアプリ クライアント ID (全アプリ共通) */
  wssoClientId: string;
  region: string;
  account: string;
  /** W-SSO がログイン後に戻ってよいアプリのオリジン */
  allowedOrigins: string[];
}

let config: AppConfig | undefined;

/** デプロイ時に CDK が書き出す /config.json を読み込む */
export async function loadConfig(): Promise<AppConfig> {
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error('config.json が見つかりません。ローカル開発時は web/public/config.json を作成してください');
  }
  config = (await res.json()) as AppConfig;
  // ダッシュボード自身も W-SSO でログインする (W-SSO は同じサイトにある)
  configure({
    ssoUrl: location.origin,
    userPoolClientId: config.wssoClientId,
    region: config.region,
    appId: 'portal',
    storageKey: 'wa.session',
  });
  return config;
}

export function getConfig(): AppConfig {
  if (!config) throw new Error('config が読み込まれていません');
  return config;
}
