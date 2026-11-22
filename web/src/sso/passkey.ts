/**
 * パスキー (WebAuthn) とブラウザのやりとり。
 * Cognito は WebAuthn の JSON 形式 (バイト列は base64url の文字列) でやりとりするので、
 * ブラウザの API (バイト列は ArrayBuffer) との間で変換する
 */

const toBytes = (s: string): ArrayBuffer => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};

const toB64url = (buf: ArrayBuffer | null | undefined): string | undefined => {
  if (!buf) return undefined;
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

interface JsonDescriptor {
  type: 'public-key';
  id: string;
  transports?: AuthenticatorTransport[];
}

const descriptors = (list?: JsonDescriptor[]): PublicKeyCredentialDescriptor[] | undefined =>
  list?.map((d) => ({ type: d.type, id: toBytes(d.id), transports: d.transports }));

/** このブラウザでパスキーが使えるか */
export const passkeySupported = () => typeof window !== 'undefined' && 'PublicKeyCredential' in window && !!navigator.credentials;

/** この端末に Face ID / Touch ID などの本人確認つきの認証器があるか (パスキーの登録を勧めるかどうか) */
export async function platformAuthenticatorAvailable(): Promise<boolean> {
  if (!passkeySupported()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** 登録: Cognito の StartWebAuthnRegistration が返した CredentialCreationOptions から、パスキーを作る */
export async function createPasskey(options: Record<string, unknown>): Promise<Record<string, unknown>> {
  const o = options as {
    challenge: string;
    user: { id: string; name: string; displayName: string };
    excludeCredentials?: JsonDescriptor[];
  } & Record<string, unknown>;
  const publicKey = {
    ...o,
    challenge: toBytes(o.challenge),
    user: { ...o.user, id: toBytes(o.user.id) },
    excludeCredentials: descriptors(o.excludeCredentials),
  } as PublicKeyCredentialCreationOptions;
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error('パスキーを作成できませんでした');
  const res = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64url(res.clientDataJSON),
      attestationObject: toB64url(res.attestationObject),
      transports: typeof res.getTransports === 'function' ? res.getTransports() : undefined,
    },
  };
}

/** ログイン: Cognito の CREDENTIAL_REQUEST_OPTIONS (JSON 文字列) で、パスキーの署名をもらう */
export async function getPasskey(optionsJson: string): Promise<Record<string, unknown>> {
  const o = JSON.parse(optionsJson) as { challenge: string; allowCredentials?: JsonDescriptor[] } & Record<string, unknown>;
  const publicKey = {
    ...o,
    challenge: toBytes(o.challenge),
    allowCredentials: descriptors(o.allowCredentials),
  } as PublicKeyCredentialRequestOptions;
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error('パスキーでログインできませんでした');
  const res = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64url(res.clientDataJSON),
      authenticatorData: toB64url(res.authenticatorData),
      signature: toB64url(res.signature),
      userHandle: toB64url(res.userHandle),
    },
  };
}

/** パスキーの画面で自分でキャンセルした・時間切れになった (エラーとして表示しない) */
export const isPasskeyCancel = (e: unknown) => e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError');
