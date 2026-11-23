// アプリのサーバー (Lambda など) から、Claude API の使用量を apps.wakalabo.net に送る。
// このファイルを各アプリにコピーして使う (wsso-client.ts と同じやり方)。
// 管理画面の「使用量」で「アプリのサーバー用」のキーを作り、URL とキーは環境変数や SSM に置く (リポジトリには書かない)。
// 送信に失敗しても、アプリの処理は止めない (使用量の記録より、アプリの動作が優先)。

export interface UsageClientConfig {
  /** 例: https://xxxx.execute-api.ap-southeast-2.amazonaws.com (API の URL。末尾の / はあってもなくてもよい) */
  url: string;
  key: string;
}

/** Anthropic API のレスポンスの usage */
export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * @param user  利用者の名前 (W-SSO のトークンの username、またはメールアドレス)
 * @param appId shared/apps.ts のアプリの id (kakeibo など)
 */
export async function reportUsage(cfg: UsageClientConfig, user: string, appId: string, model: string, usage: AnthropicUsage): Promise<void> {
  try {
    const res = await fetch(`${cfg.url.replace(/\/$/, '')}/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wakalabo-key': cfg.key },
      body: JSON.stringify({
        user,
        source: `app:${appId}`,
        model,
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        requests: 1,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.warn('usage: 送信に失敗しました', res.status);
  } catch (e) {
    console.warn('usage: 送信に失敗しました', e instanceof Error ? e.message : e);
  }
}
