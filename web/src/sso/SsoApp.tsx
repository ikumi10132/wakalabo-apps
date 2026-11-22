import { useEffect, useState, type FormEvent } from 'react';
import { ADMIN_GROUP, APPS, appGroup } from '../../../shared/apps';
import { b64urlEncode, cognito, type Handoff } from '../wsso-client';

/**
 * W-SSO のログイン画面 (https://apps.wakalabo.net/sso.html)。
 * パスワードは Cognito に直接送って確認する (このページやサーバーには保存しない)。
 * ログインできたら、ログインの情報 (リフレッシュトークン) をこの画面の保存領域に残し、
 * 次に別のアプリから来たときは入力なしで戻す (シングルサインオン)。
 */

interface SsoConfig {
  region: string;
  wssoClientId: string;
  /** ログイン後に戻ってよいアプリの URL (オリジン)。これ以外には戻さない */
  allowedOrigins: string[];
}

const SESSION_KEY = 'wsso.session';
const PASSWORD_HINT = '12 文字以上で、英大文字・英小文字・数字・記号をそれぞれ含めてください';

interface Stored {
  email: string;
  refreshToken: string;
}

const loadStored = (): Stored | null => {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Stored | null;
  } catch {
    return null;
  }
};
const saveStored = (s: Stored | null) => {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* 保存できないときは、毎回ログインが必要になるだけ */
  }
};

interface AuthResult {
  AccessToken: string;
  RefreshToken?: string;
  ExpiresIn: number;
}
interface InitiateAuthResponse {
  AuthenticationResult?: AuthResult;
  ChallengeName?: string;
  ChallengeParameters?: Record<string, string>;
  Session?: string;
}

function decodeClaims(token: string): Record<string, unknown> {
  const p = token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(p + '='.repeat((4 - (p.length % 4)) % 4))))) as Record<string, unknown>;
}

/** Cognito のエラーを日本語にする */
function message(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  switch (name) {
    case 'NotAuthorizedException':
      return (e as Error).message.includes('disabled')
        ? 'このアカウントは停止されています。管理者に確認してください'
        : 'メールアドレスかパスワードが違います';
    case 'UserNotFoundException':
      return 'メールアドレスかパスワードが違います';
    case 'PasswordResetRequiredException':
      return 'パスワードの再設定が必要です。「パスワードを忘れた」から再設定してください';
    case 'InvalidPasswordException':
      return `パスワードが条件を満たしていません。${PASSWORD_HINT}`;
    case 'CodeMismatchException':
      return '確認コードが違います';
    case 'ExpiredCodeException':
      return '確認コードの有効期限が切れました。もう一度送ってください';
    case 'LimitExceededException':
    case 'TooManyRequestsException':
    case 'TooManyFailedAttemptsException':
      return '試した回数が多すぎます。しばらく待ってからやり直してください';
    default:
      return e instanceof Error ? e.message : String(e);
  }
}

type Screen =
  | { name: 'loading' }
  | { name: 'login' }
  | { name: 'newPassword'; session: string; username: string }
  | { name: 'forgot' }
  | { name: 'reset'; email: string }
  | { name: 'denied'; email: string }
  | { name: 'error'; text: string };

export function SsoApp() {
  const params = new URLSearchParams(location.search);
  const appId = params.get('app') ?? 'portal';
  const returnTo = params.get('return') ?? '';
  const appName = appId === 'portal' ? 'wakalabo apps' : (APPS.find((a) => a.id === appId)?.name ?? appId);

  const [cfg, setCfg] = useState<SsoConfig | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });
  const [email, setEmail] = useState(loadStored()?.email ?? '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  /** ログインできたら、アプリの権限を確かめてアプリに戻す */
  const finish = (c: SsoConfig, r: AuthResult, refreshToken: string, who: string) => {
    saveStored({ email: who, refreshToken });
    const claims = decodeClaims(r.AccessToken);
    const groups = Array.isArray(claims['cognito:groups']) ? (claims['cognito:groups'] as string[]) : [];
    if (appId !== 'portal' && !groups.includes(ADMIN_GROUP) && !groups.includes(appGroup(appId))) {
      setScreen({ name: 'denied', email: who });
      return;
    }
    const handoff: Handoff = { accessToken: r.AccessToken, refreshToken, expiresIn: r.ExpiresIn };
    location.replace(`${returnTo}#wsso=${b64urlEncode(JSON.stringify(handoff))}`);
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/config.json', { cache: 'no-store' });
        const c = (await res.json()) as SsoConfig;
        setCfg(c);
        // 登録されたアプリ以外には戻さない (ログイン情報を偽のサイトに渡さないため)
        let origin = '';
        try {
          origin = new URL(returnTo).origin;
        } catch {
          /* 下でエラー */
        }
        if (!origin || !c.allowedOrigins.includes(origin)) {
          setScreen({ name: 'error', text: 'このアプリからのログインは受け付けていません。アプリのログインボタンからやり直してください' });
          return;
        }

        const stored = loadStored();
        if (params.get('logout')) {
          // すべてのアプリからログアウト (リフレッシュトークンを無効にする)
          if (stored) {
            await cognito(c.region, 'RevokeToken', { ClientId: c.wssoClientId, Token: stored.refreshToken }).catch(() => undefined);
          }
          saveStored(null);
          location.replace(returnTo);
          return;
        }
        if (stored) {
          try {
            const r = await cognito<InitiateAuthResponse>(c.region, 'InitiateAuth', {
              AuthFlow: 'REFRESH_TOKEN_AUTH',
              ClientId: c.wssoClientId,
              AuthParameters: { REFRESH_TOKEN: stored.refreshToken },
            });
            if (r.AuthenticationResult) return finish(c, r.AuthenticationResult, stored.refreshToken, stored.email);
          } catch {
            saveStored(null); // 期限切れ・無効化されていたらログインし直す
          }
        }
        setScreen({ name: 'login' });
      } catch (e) {
        setScreen({ name: 'error', text: message(e) });
      }
    })();
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const submitLogin = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await cognito<InitiateAuthResponse>(cfg!.region, 'InitiateAuth', {
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: cfg!.wssoClientId,
        AuthParameters: { USERNAME: email.trim(), PASSWORD: password },
      });
      setPassword('');
      if (r.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
        setNotice('初めてのログインです。新しいパスワードを決めてください');
        setScreen({ name: 'newPassword', session: r.Session!, username: r.ChallengeParameters?.USER_ID_FOR_SRP ?? email.trim() });
        return;
      }
      if (!r.AuthenticationResult?.RefreshToken) throw new Error(`ログインを完了できませんでした (${r.ChallengeName ?? '不明'})`);
      finish(cfg!, r.AuthenticationResult, r.AuthenticationResult.RefreshToken, email.trim());
    });
  };

  const submitNewPassword = (e: FormEvent) => {
    e.preventDefault();
    if (screen.name !== 'newPassword') return;
    void run(async () => {
      const r = await cognito<InitiateAuthResponse>(cfg!.region, 'RespondToAuthChallenge', {
        ChallengeName: 'NEW_PASSWORD_REQUIRED',
        ClientId: cfg!.wssoClientId,
        Session: screen.session,
        ChallengeResponses: { USERNAME: screen.username, NEW_PASSWORD: password },
      });
      if (!r.AuthenticationResult?.RefreshToken) throw new Error('パスワードを設定できませんでした');
      finish(cfg!, r.AuthenticationResult, r.AuthenticationResult.RefreshToken, email.trim());
    });
  };

  const submitForgot = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await cognito(cfg!.region, 'ForgotPassword', { ClientId: cfg!.wssoClientId, Username: email.trim() });
      setNotice(`${email.trim()} に確認コードを送りました (迷惑メールに入ることがあります)`);
      setScreen({ name: 'reset', email: email.trim() });
    });
  };

  const submitReset = (e: FormEvent) => {
    e.preventDefault();
    if (screen.name !== 'reset') return;
    void run(async () => {
      await cognito(cfg!.region, 'ConfirmForgotPassword', {
        ClientId: cfg!.wssoClientId,
        Username: screen.email,
        ConfirmationCode: code.trim(),
        Password: password,
      });
      setPassword('');
      setCode('');
      setNotice('パスワードを変更しました。新しいパスワードでログインしてください');
      setScreen({ name: 'login' });
    });
  };

  const switchAccount = () => {
    saveStored(null);
    setPassword('');
    setNotice('');
    setScreen({ name: 'login' });
  };

  return (
    <div className="sso">
      <div className="sso-card">
        <div className="sso-brand">
          <span className="sso-logo" aria-hidden="true">W</span>
          <div>
            <p className="sso-name">W-SSO</p>
            <p className="muted small">wakalabo 共通ログイン</p>
          </div>
        </div>

        {screen.name !== 'error' && screen.name !== 'loading' && (
          <h1 className="sso-title">
            <strong>{appName}</strong> にログイン
          </h1>
        )}
        {notice && <p className="sso-notice" role="status">{notice}</p>}
        {error && <p className="sso-error" role="alert">{error}</p>}

        {screen.name === 'loading' && <p className="muted center-text">確認中…</p>}
        {screen.name === 'error' && <p className="sso-error">{screen.text}</p>}

        {screen.name === 'login' && (
          <form className="sso-form" onSubmit={submitLogin}>
            <label className="field">
              <span>メールアドレス</span>
              <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field">
              <span>パスワード</span>
              <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <button className="btn btn-primary btn-block btn-large" disabled={busy}>{busy ? 'ログイン中…' : 'ログイン'}</button>
            <button type="button" className="link-button" onClick={() => { setNotice(''); setError(''); setScreen({ name: 'forgot' }); }}>
              パスワードを忘れた
            </button>
          </form>
        )}

        {screen.name === 'newPassword' && (
          <form className="sso-form" onSubmit={submitNewPassword}>
            <label className="field">
              <span>新しいパスワード</span>
              <input className="input" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              <span className="muted small">{PASSWORD_HINT}</span>
            </label>
            <button className="btn btn-primary btn-block btn-large" disabled={busy}>パスワードを設定してログイン</button>
          </form>
        )}

        {screen.name === 'forgot' && (
          <form className="sso-form" onSubmit={submitForgot}>
            <p className="small">登録しているメールアドレスに、パスワードを再設定するための確認コードを送ります。</p>
            <label className="field">
              <span>メールアドレス</span>
              <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <button className="btn btn-primary btn-block btn-large" disabled={busy}>確認コードを送る</button>
            <button type="button" className="link-button" onClick={() => { setError(''); setScreen({ name: 'login' }); }}>ログインに戻る</button>
          </form>
        )}

        {screen.name === 'reset' && (
          <form className="sso-form" onSubmit={submitReset}>
            <label className="field">
              <span>確認コード (メールに書かれた数字)</span>
              <input className="input" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
            </label>
            <label className="field">
              <span>新しいパスワード</span>
              <input className="input" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              <span className="muted small">{PASSWORD_HINT}</span>
            </label>
            <button className="btn btn-primary btn-block btn-large" disabled={busy}>パスワードを変更</button>
            <button type="button" className="link-button" onClick={() => { setError(''); setScreen({ name: 'login' }); }}>ログインに戻る</button>
          </form>
        )}

        {screen.name === 'denied' && (
          <div className="sso-form">
            <p className="sso-error">
              {screen.email} では {appName} を使えません。ダッシュボードの管理者に、使えるアプリへの追加を頼んでください。
            </p>
            <button className="btn btn-block" onClick={switchAccount}>別のアカウントでログイン</button>
          </div>
        )}
      </div>
      <p className="muted small sso-foot">パスワードは Amazon Cognito で確認され、このページには保存されません。</p>
    </div>
  );
}
