// ログ (誰がどの画面を開いたか・どんな操作をしたか・応答時間・エラー) の型と表示名。API と画面で共有する
import { APPS, SELF_APP_ID } from './apps';

/** CloudWatch Logs のロググループ。各アプリの CDK も同じ名前で作る */
export const ACCESS_LOG_PREFIX = '/wakalabo/access/';
export const EVENTS_LOG_GROUP = '/wakalabo/events';
/** 各アプリの CDK が読む、画面のログの送り先 (POST /events の URL) */
export const EVENTS_URL_PARAM = '/wakalabo/log/events-url';
export const LOG_RETENTION_DAYS = 90;

/** 画面から送るログの種類 */
export type ClientEventKind = 'view' | 'error' | 'perf';

/** 画面から POST /events に送る 1 件 */
export interface ClientEvent {
  kind: ClientEventKind;
  /** 画面の名前 (例: ホーム、設定) */
  screen?: string;
  /** エラーの内容 (kind = error) */
  message?: string;
  /** 表示にかかった時間 (kind = perf) */
  ms?: number;
  /** 画面で起きた時刻 (UNIX ミリ秒) */
  at?: number;
}

export type LogKind = 'api' | ClientEventKind;

export interface LogRow {
  at: string;
  app: string;
  kind: LogKind;
  /** メールアドレス。ショートカットなどログインなしは「ショートカット」 */
  user: string;
  /** 操作の名前 (API) または画面の名前 */
  action: string;
  status?: number;
  ms?: number;
  /** エラーの内容 */
  detail?: string;
  /** 端末 (例: iPad (iOS 12.5)) */
  device?: string;
}

export interface LogSummary {
  app: string;
  requests: number;
  /** サーバーのエラー (5xx) */
  serverErrors: number;
  /** 拒否・入力の誤り (4xx) */
  clientErrors: number;
  avgMs?: number;
  p95Ms?: number;
  views: number;
  /** 画面で起きたエラー */
  screenErrors: number;
}

export interface LogsResponse {
  rows: LogRow[];
  summary: LogSummary[];
  /** 絞り込みの選択肢 */
  users: { sub: string; email: string }[];
  /** 表示件数の上限に達した */
  truncated: boolean;
  /** まだログがないなどの補足 */
  note?: string;
}

export const LOG_HOURS = [1, 24, 24 * 7, 24 * 30, 24 * 90] as const;
export type LogFilterKind = 'all' | 'api' | 'view' | 'error';

/** ログに出てくるアプリ (ダッシュボード自身も含む) */
export const LOG_APPS: { id: string; name: string }[] = [{ id: SELF_APP_ID, name: 'ダッシュボード' }, ...APPS.map((a) => ({ id: a.id, name: a.name }))];

/**
 * API の操作 (API Gateway のルート) の表示名。ここにないルートは "POST /xxx" のまま出す。
 * 新しいアプリやルートを作ったら足す
 */
export const ACTION_LABELS: Record<string, Record<string, string>> = {
  [SELF_APP_ID]: {
    'GET /apps': 'アプリ一覧を表示',
    'GET /costs': 'AWS の利用料を表示',
    'GET /admin/users': 'ユーザー一覧を表示',
    'POST /admin/users': 'ユーザーを追加',
    'PUT /admin/users/{username}': 'ユーザーを変更',
    'DELETE /admin/users/{username}': 'ユーザーを削除',
    'GET /admin/logs': 'ログを表示',
  },
  'smart-home': {
    'GET /devices': '機器の状態を読み込み',
    'POST /devices/{id}/command': '家電を操作',
    'GET /automations': 'オートメーションを表示',
    'POST /automations': 'オートメーションを追加',
    'PUT /automations/{id}': 'オートメーションを変更',
    'DELETE /automations/{id}': 'オートメーションを削除',
    'POST /automations/{id}/run': 'オートメーションを今すぐ実行',
  },
  kakeibo: {
    'GET /categories': 'カテゴリーを読み込み',
    'POST /categories': 'カテゴリーを追加',
    'PUT /categories/{id}': 'カテゴリーを変更',
    'DELETE /categories/{id}': 'カテゴリーを削除',
    'GET /transactions': '明細を読み込み',
    'POST /transactions': '明細を追加',
    'PUT /transactions/{id}': '明細を変更',
    'DELETE /transactions/{id}': '明細を削除',
    'GET /rules': '自動分類のルールを読み込み',
    'POST /rules': '自動分類のルールを追加',
    'DELETE /rules/{id}': '自動分類のルールを削除',
    'GET /tokens': 'ショートカットのトークンを表示',
    'POST /tokens': 'ショートカットのトークンを発行',
    'DELETE /tokens/{id}': 'ショートカットのトークンを削除',
    'GET /push': '通知の設定を読み込み',
    'POST /push/subscriptions': '通知をオン',
    'POST /push/unsubscribe': '通知をオフ',
    'PUT /push/settings': '通知の設定を変更',
    'POST /push/test': '通知をテスト',
    'POST /mail/preview': 'カードのメールを試す',
    'POST /shortcut/transactions': 'ショートカットで明細を追加',
    'GET /shortcut/categories': 'ショートカットでカテゴリーを読み込み',
    'POST /shortcut/mail': 'カードのメールから明細を追加',
  },
  waripo: {
    'GET /api/summary': '残高と記録を表示',
    'POST /api/pair': 'ペアを作成',
    'POST /api/entries': '記録を追加',
    'DELETE /api/entries/{id}': '記録を削除',
  },
  mytask: {
    'GET /tasks': 'タスクを読み込み',
    'POST /tasks': 'タスクを追加',
    'PUT /tasks/{id}': 'タスクを変更',
    'DELETE /tasks/{id}': 'タスクを削除',
    'POST /tasks/{id}/complete': 'タスクを完了',
    'POST /tasks/{id}/keep': '放置タスクを残す',
    'GET /today': '今日のタスクを表示',
    'POST /auto/battery': '電池交換のタスクを作成',
    'GET /logs': 'やったこと日記を表示',
    'DELETE /logs/{id}': 'やったこと日記を削除',
    'GET /kakeibo/categories': '家計簿のカテゴリーを読み込み',
    'GET /tokens': 'ショートカットのトークンを表示',
    'POST /tokens': 'ショートカットのトークンを発行',
    'DELETE /tokens/{id}': 'ショートカットのトークンを削除',
    'GET /shortcut/widget': 'ウィジェットを更新',
    'GET /shortcut/today': 'ショートカットで今日のタスクを読み込み',
    'POST /shortcut/tasks': 'ショートカットでタスクを追加',
    'POST /shortcut/done': 'ショートカットでタスクを完了',
  },
};

export const actionLabel = (app: string, route: string) => ACTION_LABELS[app]?.[route] ?? route;
export const appName = (id: string) => LOG_APPS.find((a) => a.id === id)?.name ?? id;
