// API と画面で共有する型
import type { AppDef } from './apps';

export interface Me {
  username: string;
  email: string;
  isAdmin: boolean;
}

export interface AppsResponse {
  me: Me;
  apps: AppDef[];
}

export interface NamedCost {
  name: string;
  amount: number;
}

export interface CostsResponse {
  currency?: string;
  thisMonth?: {
    start: string;
    total: number;
    services: NamedCost[];
    /** アプリ (AWS リソースの app タグ) ごと。タグのないものは「共通・その他」 */
    apps: NamedCost[];
  };
  lastMonth?: { start: string; total: number };
  /** 利用額が取れなかった理由 (Cost Explorer の有効化待ちなど) */
  costsError?: string;
  /** アプリ別の集計ができない理由 (コスト配分タグが未有効など) */
  appsNote?: string;
  plan?: {
    type: string;
    status?: string;
    remainingCredits?: number;
    creditUnit?: string;
    expiresAt?: string;
  };
  fetchedAt: string;
}

export interface AdminUser {
  username: string;
  email: string;
  status: string;
  enabled: boolean;
  isAdmin: boolean;
  /** 使えるアプリの id */
  apps: string[];
  createdAt: string;
}
