// 管理しているアプリの一覧。新しいアプリを作ったらここに足してデプロイする。
// - infra: 共通ログイン用のアプリ クライアントと、利用者を絞るグループ (app-<id>) を作る
// - api: ダッシュボードに出す一覧と、利用料のアプリ別集計 (AWS リソースの app タグ) に使う

export interface AppDef {
  /** 英小文字とハイフン。AWS リソースの app タグ、Cognito のグループ名 (app-<id>) にも使う */
  id: string;
  name: string;
  description: string;
  /** 絵文字 1 文字 */
  icon: string;
  url: string;
  /** GitHub の owner/repo */
  repo?: string;
  /** CloudFormation のスタック名 */
  stack?: string;
}

export const REGION = 'ap-southeast-2';

export const APPS: AppDef[] = [
  {
    id: 'smart-home',
    name: 'おうちダッシュボード',
    description: 'SwitchBot と Nature Remo の家電を操作',
    icon: '🏠',
    url: 'https://d16ascn5rqjdeo.cloudfront.net',
    repo: 'ikumi10132/smart-home-dashboard',
    stack: 'SmartHomeDashboard',
  },
  {
    id: 'kakeibo',
    name: 'MyKakeibo!',
    description: 'Apple Pay で払うと自動で記録される家計簿アプリ',
    icon: '💴',
    url: 'https://kakeibo.wakalabo.net',
    repo: 'ikumi10132/kakeibo',
    stack: 'Kakeibo',
  },
  {
    id: 'waripo',
    name: 'waripo',
    description: '2 人の割り勘と貸し借りの精算。家計簿と連動',
    icon: '🤝',
    url: 'https://waripo.wakalabo.net',
    repo: 'ikumi10132/waripo',
    stack: 'Waripo',
  },
];

/** このダッシュボード自身 (利用料の集計にだけ使う) */
export const SELF_APP_ID = 'wakalabo-apps';

export const appGroup = (id: string) => `app-${id}`;
export const ADMIN_GROUP = 'admin';
