import { useEffect, useState, type FormEvent } from 'react';
import { ADMIN_GROUP, APPS, appGroup } from '../../../shared/apps';
import { b64urlEncode, cognito, type Handoff } from '../wsso-client';
import { createPasskey, getPasskey, isPasskeyCancel, passkeySupported, platformAuthenticatorAvailable } from './passkey';

/**
 * W-SSO のログイン画面 (https://apps.wakalabo.net/sso.html)。
 * パスワードは Cognito に直接送って確認する (このページやサーバーには保存しない)。
 * ログインできたら、ログインの情報 (リフレッシュトークン) をこの画面の保存領域に残し、
 * 次に別のアプリから来たときは入力なしで戻す (シングルサインオン)。
 * パスキー (Face ID / Touch ID) でもログインできる。登録・削除は ?manage=1 の画面で行う。
 */

interface SsoConfig {
  region: string;
  wssoClientId: string;
  /** ログイン後に戻ってよいアプリの URL (オリジン)。これ以外には戻さない */
  allowedOrigins: string[];
}

const SESSION_KEY = 'wsso.session';
/** 「メールアドレスを保存する」を選んだときのメールアドレス (ログアウトしても残る。次回の入力を省くため) */
const EMAIL_KEY = 'wsso.email';
/** 「パスキーの登録を今後すすめない」を選んだメールアドレス */
const NO_OFFER_KEY = 'wsso.passkeyNoOffer';
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

const loadEmail = (): string | null => {
  try {
    return localStorage.getItem(EMAIL_KEY);
  } catch {
    return null;
  }
};
/** 保存しないを選んだときは空文字を置き、次回もチェックを外したままにする */
const saveEmail = (email: string | null) => {
  try {
    localStorage.setItem(EMAIL_KEY, email ?? '');
  } catch {
    /* noop */
  }
};

const noOfferList = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(NO_OFFER_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
};
const setNoOffer = (email: string) => {
  try {
    localStorage.setItem(NO_OFFER_KEY, JSON.stringify([...new Set([...noOfferList(), email.toLowerCase()])]));
  } catch {
    /* noop */
  }
};

interface PasskeyInfo {
  CredentialId: string;
  FriendlyCredentialName?: string;
  AuthenticatorAttachment?: string;
  CreatedAt: number;
}

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
    case 'InvalidStateError':
      return 'この端末のパスキーはすでに登録されています';
    case 'SecurityError':
    case 'WebAuthnRelyingPartyMismatchException':
    case 'WebAuthnOriginNotAllowedException':
      return 'このページではパスキーを使えません (パスキーのドメインの設定を確認してください)';
    case 'WebAuthnNotEnabledException':
    case 'WebAuthnConfigurationMissingException':
      return 'パスキーはまだ使えるようになっていません';
    case 'WebAuthnCredentialNotSupportedException':
      return 'この種類のパスキーは使えません';
    case 'WebAuthnChallengeNotFoundException':
      return '時間がたったため、やり直してください';
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
  /** パスワードでログインした直後に、パスキーの登録をすすめる */
  | { name: 'offerPasskey'; accessToken: string; email: string; next: () => void }
  /** パスキーの一覧・登録・削除 (?manage=1) */
  | { name: 'manage'; accessToken: string; email: string }
  | { name: 'error'; text: string };

export function SsoApp() {
  const params = new URLSearchParams(location.search);
  const appId = params.get('app') ?? 'portal';
  const returnTo = params.get('return') ?? '';
  const manage = params.get('manage') === '1';
  const appName = appId === 'portal' ? 'wakalabo apps' : (APPS.find((a) => a.id === appId)?.name ?? appId);

  const [cfg, setCfg] = useState<SsoConfig | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });
  // 入力欄にあらかじめ入れるのは「保存する」を選んだメールアドレスだけ
  const [email, setEmail] = useState(loadEmail() ?? '');
  // 前回の選択を引き継ぐ。初めてのときはチェック済み (外せば保存しない)
  const [rememberEmail, setRememberEmail] = useState(() => loadEmail() !== '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  /**
   * ログインできたら、アプリの権限を確かめてアプリに戻す。
   * viaPassword: パスワードでログインしたとき。この端末でパスキーが使えて、まだ登録していなければ登録をすすめる
   */
  const finish = async (c: SsoConfig, r: AuthResult, refreshToken: string, who: string, viaPassword = false, remember?: boolean) => {
    saveStored({ email: who, refreshToken });
    // ログイン画面で入力してログインしたときだけ、保存するかどうかの選択を反映する
    if (remember !== undefined) saveEmail(remember ? who : null);
    if (manage) {
      setScreen({ name: 'manage', accessToken: r.AccessToken, email: who });
      return;
    }
    const claims = decodeClaims(r.AccessToken);
    const groups = Array.isArray(claims['cognito:groups']) ? (claims['cognito:groups'] as string[]) : [];
    if (appId !== 'portal' && !groups.includes(ADMIN_GROUP) && !groups.includes(appGroup(appId))) {
      setScreen({ name: 'denied', email: who });
      return;
    }
    const handoff: Handoff = { accessToken: r.AccessToken, refreshToken, expiresIn: r.ExpiresIn };
    const next = () => location.replace(`${returnTo}#wsso=${b64urlEncode(JSON.stringify(handoff))}`);
    if (viaPassword && !noOfferList().includes(who.toLowerCase()) && (await platformAuthenticatorAvailable())) {
      try {
        const list = await cognito<{ Credentials?: PasskeyInfo[] }>(c.region, 'ListWebAuthnCredentials', { AccessToken: r.AccessToken });
        if (!list.Credentials?.length) {
          setScreen({ name: 'offerPasskey', accessToken: r.AccessToken, email: who, next });
          return;
        }
      } catch {
        /* パスキーが使えない設定などのときは、すすめずにそのまま戻る */
      }
    }
    next();
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
            if (r.AuthenticationResult) return void (await finish(c, r.AuthenticationResult, stored.refreshToken, stored.email));
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
      if (!isPasskeyCancel(e)) setError(message(e));
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
      await finish(cfg!, r.AuthenticationResult, r.AuthenticationResult.RefreshToken, email.trim(), true, rememberEmail);
    });
  };

  /** パスキーでログイン: Cognito から受け取った条件でパスキーに署名してもらい、送り返す */
  const passkeyLogin = () => {
    const who = email.trim();
    if (!who) {
      setError('メールアドレスを入力してください');
      return;
    }
    void run(async () => {
      const r = await cognito<InitiateAuthResponse>(cfg!.region, 'InitiateAuth', {
        AuthFlow: 'USER_AUTH',
        ClientId: cfg!.wssoClientId,
        AuthParameters: { USERNAME: who, PREFERRED_CHALLENGE: 'WEB_AUTHN' },
      });
      const options = r.ChallengeParameters?.CREDENTIAL_REQUEST_OPTIONS;
      if (r.ChallengeName !== 'WEB_AUTHN' || !options) {
        throw new Error('このアカウントにはパスキーが登録されていません。パスワードでログインしてください');
      }
      const credential = await getPasskey(options);
      const done = await cognito<InitiateAuthResponse>(cfg!.region, 'RespondToAuthChallenge', {
        ChallengeName: 'WEB_AUTHN',
        ClientId: cfg!.wssoClientId,
        Session: r.Session,
        ChallengeResponses: { USERNAME: who, CREDENTIAL: JSON.stringify(credential) },
      });
      if (!done.AuthenticationResult?.RefreshToken) throw new Error('パスキーでログインできませんでした');
      await finish(cfg!, done.AuthenticationResult, done.AuthenticationResult.RefreshToken, who, false, rememberEmail);
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
      await finish(cfg!, r.AuthenticationResult, r.AuthenticationResult.RefreshToken, email.trim(), true, rememberEmail);
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
            <p className="sso-sub">wakalabo 共通ログイン</p>
          </div>
        </div>

        {!['error', 'loading', 'offerPasskey', 'manage'].includes(screen.name) && (
          <h1 className="sso-title">
            <strong>{appName}</strong> にログイン
          </h1>
        )}
        {notice && <p className="sso-notice" role="status">{notice}</p>}
        {error && <p className="sso-error" role="alert">{error}</p>}

        {screen.name === 'loading' && <div className="md-progress" role="progressbar" aria-label="確認中" />}
        {screen.name === 'error' && <p className="sso-error">{screen.text}</p>}

        {screen.name === 'login' && (
          <form className="sso-form" onSubmit={submitLogin}>
            <label className="md-field">
              <input className="md-input" placeholder=" " type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
              <span className="md-label">メールアドレス</span>
            </label>
            <label className="md-field">
              <input className="md-input" placeholder=" " type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              <span className="md-label">パスワード</span>
            </label>
            <label className="md-check">
              <input type="checkbox" checked={rememberEmail} onChange={(e) => setRememberEmail(e.target.checked)} />
              <span>メールアドレスを保存する</span>
            </label>
            <button className="md-btn md-filled" disabled={busy}>{busy ? 'ログイン中…' : 'ログイン'}</button>
            {passkeySupported() && (
              <>
                <div className="sso-divider"><span>または</span></div>
                <button type="button" className="md-btn md-tonal" disabled={busy} onClick={passkeyLogin}>
                  <KeyIcon /> パスキーでログイン
                </button>
              </>
            )}
            <button type="button" className="md-btn md-text" onClick={() => { setNotice(''); setError(''); setScreen({ name: 'forgot' }); }}>
              パスワードを忘れた
            </button>
          </form>
        )}

        {screen.name === 'offerPasskey' && (
          <OfferPasskey
            cfg={cfg!}
            accessToken={screen.accessToken}
            busy={busy}
            run={run}
            onDone={screen.next}
            onNever={() => {
              setNoOffer(screen.email);
              screen.next();
            }}
          />
        )}

        {screen.name === 'manage' && (
          <ManagePasskeys cfg={cfg!} accessToken={screen.accessToken} email={screen.email} busy={busy} run={run} setNotice={setNotice} returnTo={returnTo} />
        )}

        {screen.name === 'newPassword' && (
          <form className="sso-form" onSubmit={submitNewPassword}>
            <label className="md-field">
              <input className="md-input" placeholder=" " type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              <span className="md-label">新しいパスワード</span>
              <span className="md-support">{PASSWORD_HINT}</span>
            </label>
            <button className="md-btn md-filled" disabled={busy}>パスワードを設定してログイン</button>
          </form>
        )}

        {screen.name === 'forgot' && (
          <form className="sso-form" onSubmit={submitForgot}>
            <p className="sso-text">登録しているメールアドレスに、パスワードを再設定するための確認コードを送ります。</p>
            <label className="md-field">
              <input className="md-input" placeholder=" " type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
              <span className="md-label">メールアドレス</span>
            </label>
            <button className="md-btn md-filled" disabled={busy}>確認コードを送る</button>
            <button type="button" className="md-btn md-text" onClick={() => { setError(''); setScreen({ name: 'login' }); }}>ログインに戻る</button>
          </form>
        )}

        {screen.name === 'reset' && (
          <form className="sso-form" onSubmit={submitReset}>
            <label className="md-field">
              <input className="md-input" placeholder=" " inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
              <span className="md-label">確認コード (メールに書かれた数字)</span>
            </label>
            <label className="md-field">
              <input className="md-input" placeholder=" " type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              <span className="md-label">新しいパスワード</span>
              <span className="md-support">{PASSWORD_HINT}</span>
            </label>
            <button className="md-btn md-filled" disabled={busy}>パスワードを変更</button>
            <button type="button" className="md-btn md-text" onClick={() => { setError(''); setScreen({ name: 'login' }); }}>ログインに戻る</button>
          </form>
        )}

        {screen.name === 'denied' && (
          <div className="sso-form">
            <p className="sso-error">
              {screen.email} では {appName} を使えません。ダッシュボードの管理者に、使えるアプリへの追加を頼んでください。
            </p>
            <button className="md-btn md-outlined" onClick={switchAccount}>別のアカウントでログイン</button>
          </div>
        )}
      </div>
      <p className="sso-foot">パスワードとパスキーは Amazon Cognito で確認され、このページには保存されません。メールアドレスは「保存する」を選んだときだけ、この端末に保存されます。</p>
    </div>
  );
}

const KeyIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="15" r="4" />
    <path d="M10.85 12.15 19 4M17 6l3 3M15 8l2 2" />
  </svg>
);

type Run = (fn: () => Promise<void>) => Promise<void>;

/** パスキーを登録する (Cognito で登録を始め、この端末でパスキーを作り、Cognito に登録する) */
async function registerPasskey(cfg: SsoConfig, accessToken: string): Promise<void> {
  const start = await cognito<{ CredentialCreationOptions: Record<string, unknown> }>(cfg.region, 'StartWebAuthnRegistration', { AccessToken: accessToken });
  const credential = await createPasskey(start.CredentialCreationOptions);
  await cognito(cfg.region, 'CompleteWebAuthnRegistration', { AccessToken: accessToken, Credential: credential });
}

function OfferPasskey({ cfg, accessToken, busy, run, onDone, onNever }: { cfg: SsoConfig; accessToken: string; busy: boolean; run: Run; onDone: () => void; onNever: () => void }) {
  return (
    <div className="sso-form">
      <div className="sso-passkey-hero" aria-hidden="true"><KeyIcon /></div>
      <h2 className="sso-subtitle">パスキーを登録しますか？</h2>
      <p className="sso-text">
        次からは、パスワードの代わりに Face ID や Touch ID でログインできます。
        iPhone で登録したパスキーは、iCloud キーチェーンで同じ Apple アカウントの Mac などでも使えます。
      </p>
      <button className="md-btn md-filled" disabled={busy} onClick={() => void run(async () => { await registerPasskey(cfg, accessToken); onDone(); })}>
        パスキーを登録する
      </button>
      <button className="md-btn md-text" disabled={busy} onClick={onDone}>今はしない</button>
      <button className="md-btn md-text sso-muted-btn" disabled={busy} onClick={onNever}>今後は表示しない</button>
    </div>
  );
}

function ManagePasskeys({ cfg, accessToken, email, busy, run, setNotice, returnTo }: { cfg: SsoConfig; accessToken: string; email: string; busy: boolean; run: Run; setNotice: (s: string) => void; returnTo: string }) {
  const [list, setList] = useState<PasskeyInfo[] | null>(null);
  const reload = () => cognito<{ Credentials?: PasskeyInfo[] }>(cfg.region, 'ListWebAuthnCredentials', { AccessToken: accessToken }).then((r) => setList(r.Credentials ?? []));

  useEffect(() => {
    void run(reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = () =>
    void run(async () => {
      await registerPasskey(cfg, accessToken);
      setNotice('パスキーを登録しました');
      await reload();
    });
  const remove = (p: PasskeyInfo) => {
    if (!confirm(`「${p.FriendlyCredentialName || 'パスキー'}」を削除しますか？ この端末のパスキーでは、ログインできなくなります。`)) return;
    void run(async () => {
      await cognito(cfg.region, 'DeleteWebAuthnCredential', { AccessToken: accessToken, CredentialId: p.CredentialId });
      setNotice('パスキーを削除しました。端末 (iPhone の「パスワード」アプリなど) に残ったパスキーも削除してください');
      await reload();
    });
  };

  return (
    <div className="sso-form">
      <h2 className="sso-subtitle">パスキー</h2>
      <p className="sso-text">{email} でログインするときに使えるパスキーです。</p>
      {!list && <div className="md-progress" role="progressbar" aria-label="読み込み中" />}
      {list?.length === 0 && <p className="sso-text">まだ登録されていません。</p>}
      {list && list.length > 0 && (
        <ul className="sso-list">
          {list.map((p) => (
            <li key={p.CredentialId}>
              <KeyIcon />
              <span className="sso-list-main">
                <strong>{p.FriendlyCredentialName || 'パスキー'}</strong>
                <span>
                  {new Date(p.CreatedAt * 1000).toLocaleDateString('ja-JP')} に登録
                  {p.AuthenticatorAttachment === 'cross-platform' ? '・セキュリティキーなど' : ''}
                </span>
              </span>
              <button className="md-btn md-text sso-danger" disabled={busy} onClick={() => remove(p)}>削除</button>
            </li>
          ))}
        </ul>
      )}
      {passkeySupported() && (
        <button className="md-btn md-filled" disabled={busy} onClick={add}>
          この端末のパスキーを登録
        </button>
      )}
      <a className="md-btn md-outlined" href={returnTo}>もどる</a>
    </div>
  );
}
