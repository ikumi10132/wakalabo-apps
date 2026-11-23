# Claude Code の使用量を送る hook

Claude Code で使ったトークン量を、apps.wakalabo.net の「使用量」に送ります (依存パッケージなし、Node 18 以上)。

## 設定 (自分のパソコンで 1 回だけ)

1. 管理者に、管理画面の **使用量 → 送信用キー** で「ユーザー用」のキーを作ってもらう (キーは作った直後の 1 回だけ表示される)
2. このリポジトリの `tools/claude-code-usage/report-usage.mjs` を、パソコンの好きな場所に置く (例: `~/.wakalabo-usage/report-usage.mjs`)
3. `~/.wakalabo-usage/config.json` を作る (**このファイルはリポジトリに入れないこと**):

   ```json
   { "url": "https://<API の URL>", "key": "wk_..." }
   ```

   API の URL は、デプロイ後に https://apps.wakalabo.net/config.json を開くと出てくる `apiUrl` の値です。
   `config.json` の代わりに、環境変数 `WAKALABO_USAGE_URL` / `WAKALABO_USAGE_KEY` でも設定できます。
4. `~/.claude/settings.json` に hook を足す:

   ```json
   {
     "hooks": {
       "Stop": [{ "hooks": [{ "type": "command", "command": "node ~/.wakalabo-usage/report-usage.mjs" }] }]
     }
   }
   ```

## 仕組みと注意

- 返答が終わるたびに、会話の記録 (transcript) を読み、**前回送った分との差分だけ**送ります。何度呼ばれても二重には数えません
- 送れなかったときは、次回にまとめて送ります。失敗しても Claude Code は止まりません (エラーは `~/.wakalabo-usage/error.log`)
- 送るのはトークン数・モデル名・回数だけです。会話の内容は送りません
- 記録の形式は Claude Code のバージョンで変わることがあります。数字が 0 のままのときは `error.log` を見て、`summarizeTranscript` を直してください
- サブエージェントの分など、別の記録ファイルに書かれる分は数えられないことがあります
- 使用量はモデルごと・日ごとに足し込まれます。Claude Code を使う人それぞれが自分用のキーを使います (名前はキーの持ち主から決まります)

## アプリから送る

アプリのサーバーからは `shared/usage-client.ts` を各アプリにコピーして使います。
管理画面で「アプリのサーバー用」のキーを作り、API の URL とキーは環境変数や SSM に置きます (リポジトリには書きません)。

```ts
const res = await anthropic.messages.create({ /* ... */ });
await reportUsage({ url: process.env.USAGE_URL!, key: process.env.USAGE_KEY! }, username, 'kakeibo', res.model, res.usage);
```
