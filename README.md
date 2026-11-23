# wakalabo apps

wakalabo の Web アプリをまとめるダッシュボードと、全アプリ共通のログインです。

- **アプリ一覧**: 使えるアプリだけが表示されます (管理者はすべて)
- **AWS** (管理者のみ): クレジットの残高と期限、今月・先月の利用額、アプリ別・サービス別の内訳、AWS コンソールへのリンク
- **使用量** (管理者のみ): Claude のトークン使用量を、ユーザー別・アプリ別 (アプリと Claude Code) に月ごとで表示。送信用キーの発行と取り消し
- **ユーザー管理** (管理者のみ): ユーザーの追加、使えるアプリの設定、管理者の切り替え、仮パスワードの再設定、停止、削除

```
[スマホ/PC] ─▶ CloudFront + S3 (React の画面)   https://apps.wakalabo.net
     │
     └─▶ API Gateway (共通ログインのトークン) ─▶ Lambda ─┬─▶ Cognito (ユーザー管理)
                                                       ├─▶ Cost Explorer / Free Tier (利用料・クレジット)
                                                       └─▶ SSM (利用料の 12 時間キャッシュ)
```

| ディレクトリ | 内容 |
|---|---|
| `shared/` | アプリの一覧 (`apps.ts`) と、API・画面で共有する型 |
| `api/` | Lambda (TypeScript) |
| `web/` | 画面 (React + Vite) |
| `infra/` | AWS CDK。共通ログイン (Cognito)、API、画面、各アプリ用のログイン設定 (SSM) |

## 共通ログイン (W-SSO)

wakalabo の全アプリで使うログインです。ログイン画面は自作 (`https://apps.wakalabo.net/sso.html`、`web/src/sso/`) で、
パスワードの確認は Amazon Cognito (ユーザープール `wakalabo-users`) が行います。

- アプリは `login()` で W-SSO に移動し、ログイン後は URL の `#wsso=...` でトークンを受け取って戻る (`web/src/wsso-client.ts` を各アプリにコピーして使う)
- 一度ログインすれば、ほかのアプリは入力なしで入れる (W-SSO の画面がリフレッシュトークンを覚えている)。ログアウトはすべてのアプリから
- 戻ってよいのは `shared/apps.ts` のアプリとダッシュボードのオリジンだけ
- 初回ログイン時の新しいパスワードの設定、「パスワードを忘れた」(確認コードをメールで送る) も W-SSO の画面で行う
- **パスキー** (Face ID / Touch ID) でもログインできる。パスワードでログインしたあと、この端末で使えれば登録をすすめる。
  一覧・追加・削除はダッシュボードの「パスキー」(`/sso.html?app=portal&manage=1&return=...`)。
  パスキーのドメイン (relying party) は `wakalabo.net` (独自ドメイン `apps.wakalabo.net` の親) で、Cognito の Essentials プランの機能 (月 10,000 人まで無料)。
  パスワードは予備として残している (新しい端末やパスキーが使えないとき用)
- 使えるアプリは Cognito のグループ `app-<アプリの id>` で決まる (画面の「ユーザー管理」で設定)。`admin` グループは管理者
- 各アプリの CDK は SSM パラメータ `/wakalabo/auth/user-pool-id`、`/wakalabo/auth/wsso-client-id`、`/wakalabo/auth/sso-url` を読んで、
  API で W-SSO のアクセストークンを受け付ける。権限 (グループ) は各アプリの API でも確認する
- ユーザープールの名前は変えない (変えると作り直しになり、全ユーザーが消える)。「W-SSO」は表示名

### 新しいアプリを追加するとき

1. `shared/apps.ts` の `APPS` に追加してデプロイ (グループと、W-SSO から戻れる URL に追加される)
2. アプリ側: `wsso-client.ts` をコピーし、CDK で上の SSM パラメータを読む。AWS リソースに `app=<id>` のタグを付ける

## デプロイ (ブラウザだけでできます)

GitHub Actions からのデプロイは、このアカウントの制限 (SCP) で使えないため、AWS コンソールの **CloudShell** から行います。

```bash
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null \
  && cd /tmp && rm -rf wakalabo-apps && git clone --depth 1 https://github.com/ikumi10132/wakalabo-apps.git && cd wakalabo-apps \
  && npm ci && npm run build && cd infra && npx cdk deploy WakalaboApps --require-approval never
```

(`nvm: command not found` と出たら、先に `curl -so- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && source ~/.nvm/nvm.sh && nvm install 22`)

### 最初の管理者を作る (初回だけ)

画面からユーザーを追加するには管理者が必要なので、最初の 1 人だけ CloudShell で作ります。
`<UserPoolId>` はデプロイ後に表示される `WakalaboApps.UserPoolId`。1 行で貼り付け、表示されたらパスワードを入力します
(12 文字以上で英大文字・英小文字・数字・記号を含める)。

```bash
read -p "メールアドレス: " EMAIL && read -s -p "パスワード: " PW && echo && aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username "$EMAIL" --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true --message-action SUPPRESS >/dev/null && aws cognito-idp admin-set-user-password --user-pool-id <UserPoolId> --username "$EMAIL" --password "$PW" --permanent && aws cognito-idp admin-add-user-to-group --user-pool-id <UserPoolId> --username "$EMAIL" --group-name admin && echo "作成しました"; unset PW
```

### 独自ドメイン (apps.wakalabo.net)

kakeibo と同じ手順です。CloudShell で us-east-1 に証明書を申請し、確認用の CNAME をお名前.com に登録、
`ISSUED` になったら `infra/cdk.json` の context に `domainName` と `certificateArn` を書いてデプロイし、
お名前.com で `apps` の CNAME を `WakalaboApps.CloudFrontDomain` に向けます。

## Claude のトークン使用量

DynamoDB のテーブル (`UsageTable`、オンデマンド課金) に、日・ユーザー・発生元 (`claude-code` / `app:<id>`)・モデルごとに足し込みます。

- 送信: `POST /usage` (ログインなし。管理者が「使用量」画面で発行した送信用キーを `x-wakalabo-key` ヘッダーで送る。DB にはキーの SHA-256 だけを保存)
- 表示: `GET /admin/usage?month=YYYY-MM` (管理者のみ)、キーの管理は `/admin/usage-keys`
- Claude Code から送る hook: [`tools/claude-code-usage/`](tools/claude-code-usage/README.md)
- アプリから送る: `shared/usage-client.ts` を各アプリにコピーして使う
- 月の集計は Scan で読みます (行数は 日数 × ユーザー × 発生元 × モデル 程度)。ユーザーが大きく増えたら月ごとの索引を検討してください

## アプリ別の利用料

Cost Explorer で、AWS リソースの `app` タグごとに集計します。初回だけ、請求コンソールの
**コスト配分タグ** で `app` を有効にしてください (タグの付いたリソースをデプロイしてから選べるようになります。反映まで最大 24 時間)。

## 費用の目安

Cognito・Lambda・API Gateway・CloudFront は個人利用ならほぼ無料枠内です。
Cost Explorer API は 1 回 0.01 USD かかるため、結果を 12 時間保存して 1 日 2 回までに抑えています (最大でも月 約 0.6 USD)。
