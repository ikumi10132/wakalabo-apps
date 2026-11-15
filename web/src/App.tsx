import { useCallback, useEffect, useState } from 'react';
import type { AppsResponse } from '../../shared/types';
import { api, AuthError } from './api';
import { handleRedirect, isLoggedIn, login, logout } from './auth';
import { AppsGrid } from './components/AppsGrid';
import { AwsPanel } from './components/AwsPanel';
import { Users } from './components/Users';
import { loadConfig } from './config';

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
        <button className="btn btn-primary btn-wide" onClick={() => void login()}>ログイン</button>
      </div>
    );
  }
  return <Main onAuthError={() => setPhase({ name: 'login' })} />;
}

export interface Shared {
  toast: (text: string, error?: boolean) => void;
  handleError: (e: unknown) => void;
}

type Tab = 'home' | 'users';

function Main({ onAuthError }: { onAuthError: () => void }) {
  const [data, setData] = useState<AppsResponse | null>(null);
  const [tab, setTab] = useState<Tab>('home');
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

  const shared: Shared = { toast, handleError };
  const isAdmin = data?.me.isAdmin ?? false;

  return (
    <div className="app">
      <main className="content">
        <header className="topbar">
          <div className="brand">
            <img src="/icon.svg" alt="" width={32} height={32} />
            wakalabo apps
          </div>
          <div className="topbar-side">
            {data && <span className="who">{data.me.email}{isAdmin && <span className="chip">管理者</span>}</span>}
            <button className="btn btn-small btn-ghost" onClick={logout}>ログアウト</button>
          </div>
        </header>

        {isAdmin && (
          <div className="segmented" role="tablist">
            {([
              ['home', 'アプリと AWS'],
              ['users', 'ユーザー管理'],
            ] as const).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
        )}

        {!data && <p className="muted center-text">読み込み中…</p>}

        {data && tab === 'home' && (
          <>
            <h2 className="section-title">アプリ</h2>
            <AppsGrid apps={data.apps} isAdmin={isAdmin} />
            {isAdmin && <AwsPanel {...shared} />}
          </>
        )}
        {data && tab === 'users' && isAdmin && <Users {...shared} me={data.me.username} />}
      </main>

      {toastMsg && (
        <div className={`toast${toastMsg.error ? ' toast-error' : ''}`} role="status">
          {toastMsg.text}
        </div>
      )}
    </div>
  );
}
