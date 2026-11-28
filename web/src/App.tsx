import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { AppsResponse } from '../../shared/types';
import { api, AuthError } from './api';
import { handleRedirect, isLoggedIn, login, logout } from './auth';
import { AppsGrid } from './components/AppsGrid';
import { AwsPanel } from './components/AwsPanel';
import { IconCloud, IconGrid, IconLog, IconLogout, IconUsers, IconKey } from './components/Icons';
import { Logs } from './components/Logs';
import { Users } from './components/Users';
import { getAccessToken } from './auth';
import { initLog, logView } from './wakalabo-log';

/** W-SSO のパスキーの管理画面 (同じサイトの sso.html) */
const PASSKEY_URL = () => `/sso.html?app=portal&manage=1&return=${encodeURIComponent(`${location.origin}/`)}`;
import { getConfig, loadConfig } from './config';

type Phase = { name: 'loading' } | { name: 'login' } | { name: 'ready' } | { name: 'error'; message: string };

export function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });

  useEffect(() => {
    (async () => {
      try {
        await loadConfig();
        await handleRedirect();
        setPhase(isLoggedIn() ? { name: 'ready' } : { name: 'login' });
      } catch (e) {
        setPhase({ name: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, []);

  if (phase.name === 'loading') return <div className="center muted">読み込み中…</div>;
  if (phase.name === 'error') {
    return (
      <div className="center">
        <p className="error-text">{phase.message}</p>
        <button className="btn" onClick={() => location.reload()}>再読み込み</button>
      </div>
    );
  }
  if (phase.name === 'login') {
    return (
      <div className="center login">
        <img src="/icon.svg" alt="" width={64} height={64} />
        <h1>wakalabo apps</h1>
        <button className="btn btn-primary btn-wide" onClick={() => login()}>W-SSO でログイン</button>
      </div>
    );
  }
  return <Main onAuthError={() => setPhase({ name: 'login' })} />;
}

export interface Shared {
  toast: (text: string, error?: boolean) => void;
  handleError: (e: unknown) => void;
}

type Tab = 'apps' | 'aws' | 'users' | 'logs';

interface NavItem {
  id: Tab;
  label: string;
  icon: (size: number) => ReactNode;
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { id: 'apps', label: 'アプリ', icon: (s) => <IconGrid size={s} /> },
  { id: 'aws', label: 'AWS', icon: (s) => <IconCloud size={s} />, adminOnly: true },
  { id: 'users', label: 'ユーザー管理', icon: (s) => <IconUsers size={s} />, adminOnly: true },
  { id: 'logs', label: 'ログ', icon: (s) => <IconLog size={s} />, adminOnly: true },
];

function Main({ onAuthError }: { onAuthError: () => void }) {
  const [data, setData] = useState<AppsResponse | null>(null);
  const [tab, setTab] = useState<Tab>('apps');
  const [toastMsg, setToastMsg] = useState<{ text: string; error?: boolean } | null>(null);

  const toast = useCallback((text: string, error = false) => {
    setToastMsg({ text, error });
    window.setTimeout(() => setToastMsg((t) => (t?.text === text ? null : t)), 4000);
  }, []);
  const handleError = useCallback(
    (e: unknown) => {
      if (e instanceof AuthError) return onAuthError();
      toast(e instanceof Error ? e.message : String(e), true);
    },
    [onAuthError, toast],
  );

  useEffect(() => {
    api.apps().then(setData, handleError);
  }, [handleError]);

  // ダッシュボード自身の画面のログ (どの画面を開いたか・エラー)
  useEffect(() => {
    initLog({ url: `${getConfig().apiUrl}/events`, app: 'wakalabo-apps', getToken: getAccessToken });
  }, []);
  useEffect(() => logView(NAV.find((n) => n.id === tab)?.label ?? tab), [tab]);

  const shared: Shared = { toast, handleError };
  const isAdmin = data?.me.isAdmin ?? false;
  const nav = NAV.filter((n) => !n.adminOnly || isAdmin);
  const go = (t: Tab) => {
    setTab(t);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className={`shell${isAdmin ? ' has-tabbar' : ''}`}>
      <aside className="sidebar" aria-label="メインメニュー">
        <div className="brand">
          <img src="/icon.svg" alt="" width={36} height={36} />
          <span className="brand-text">
            <strong>wakalabo apps</strong>
            <span className="muted small">{location.host}</span>
          </span>
        </div>
        <nav>
          <ul className="side-nav">
            {nav.map((n) => (
              <li key={n.id}>
                <button className={tab === n.id ? 'active' : ''} aria-current={tab === n.id ? 'page' : undefined} onClick={() => go(n.id)}>
                  {n.icon(20)}
                  <span className="grow">{n.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="side-foot">
          {data && (
            <p className="who">
              {data.me.email}
              {isAdmin && <span className="chip">管理者</span>}
            </p>
          )}
          <ul className="side-nav">
            <li>
              <a className="side-link" href={PASSKEY_URL()}>
                <IconKey />
                <span className="grow">パスキー</span>
              </a>
            </li>
            <li>
              <button onClick={logout}>
                <IconLogout />
                <span className="grow">ログアウト</span>
              </button>
            </li>
          </ul>
        </div>
      </aside>

      <main className="main">
        {/* スマホの上部 (PC では左メニューに出ている内容) */}
        <header className="mobile-head phone-only">
          <span className="brand">
            <img src="/icon.svg" alt="" width={28} height={28} />
            <strong>wakalabo apps</strong>
          </span>
          <span className="head-actions">
            <a className="btn btn-small btn-ghost" href={PASSKEY_URL()}>パスキー</a>
            <button className="btn btn-small btn-ghost" onClick={logout}>ログアウト</button>
          </span>
        </header>

        {!data && <p className="muted center-text">読み込み中…</p>}

        {data && tab === 'apps' && (
          <>
            <header className="page-head">
              <h1 className="page-title">アプリ</h1>
            </header>
            <AppsGrid apps={data.apps} isAdmin={isAdmin} />
          </>
        )}
        {data && tab === 'aws' && isAdmin && <AwsPanel {...shared} />}
        {data && tab === 'users' && isAdmin && <Users {...shared} me={data.me.username} />}
        {data && tab === 'logs' && isAdmin && <Logs {...shared} />}
      </main>

      {/* スマホの下のタブ (管理者だけ。管理者でなければアプリ一覧しかないので出さない) */}
      {isAdmin && (
        <nav className="tabbar" style={{ gridTemplateColumns: `repeat(${nav.length}, minmax(0, 1fr))` }} aria-label="画面の切り替え">
          {nav.map((n) => (
            <button key={n.id} className={tab === n.id ? 'active' : ''} aria-current={tab === n.id ? 'page' : undefined} onClick={() => go(n.id)}>
              {n.icon(24)}
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
      )}

      {toastMsg && (
        <div className={`toast${toastMsg.error ? ' toast-error' : ''}`} role="status">
          {toastMsg.text}
        </div>
      )}
    </div>
  );
}
