// 共通ログイン (Cognito) のユーザー管理。管理者だけが使う
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  type AttributeType,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { ADMIN_GROUP, APPS, appGroup } from '../../shared/apps.js';
import type { AdminUser } from '../../shared/types.js';

const POOL = process.env.USER_POOL_ID ?? '';
const cognito = new CognitoIdentityProviderClient({});

/** JWT の cognito:groups (API Gateway では "[admin other]" のような文字列で届くことがある) */
export function groupsFromClaim(claim: unknown): string[] {
  if (Array.isArray(claim)) return claim.map(String);
  if (typeof claim !== 'string') return [];
  return claim
    .replace(/^\[|\]$/g, '')
    .split(/[\s,]+/)
    .map((s) => s.replace(/^"|"$/g, ''))
    .filter(Boolean);
}

/** グループ一覧から、使えるアプリの id を取り出す */
export const appsFromGroups = (groups: string[]) => APPS.filter((a) => groups.includes(appGroup(a.id))).map((a) => a.id);

const attr = (attrs: AttributeType[] | undefined, name: string) => attrs?.find((a) => a.Name === name)?.Value;

/** いまのグループ (ログインのトークンの中身は最大 1 時間古いので、権限の変更をすぐ反映するために Cognito に聞く) */
export async function groupsOf(username: string): Promise<string[]> {
  const res = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: POOL, Username: username, Limit: 60 }));
  return (res.Groups ?? []).map((g) => g.GroupName!).filter(Boolean);
}

export async function getEmail(username: string): Promise<string> {
  const res = await cognito.send(new AdminGetUserCommand({ UserPoolId: POOL, Username: username }));
  return attr(res.UserAttributes, 'email') ?? '';
}

async function members(group: string): Promise<Set<string>> {
  const names = new Set<string>();
  let token: string | undefined;
  do {
    const res = await cognito.send(new ListUsersInGroupCommand({ UserPoolId: POOL, GroupName: group, NextToken: token }));
    for (const u of res.Users ?? []) if (u.Username) names.add(u.Username);
    token = res.NextToken;
  } while (token);
  return names;
}

export async function listUsers(): Promise<AdminUser[]> {
  // グループの数はアプリの数 + 1 なので、グループごとにメンバーを引くほうが呼び出しが少ない
  const [admins, ...appMembers] = await Promise.all([members(ADMIN_GROUP), ...APPS.map((a) => members(appGroup(a.id)))]);
  const users: UserType[] = [];
  let token: string | undefined;
  do {
    const res = await cognito.send(new ListUsersCommand({ UserPoolId: POOL, PaginationToken: token }));
    users.push(...(res.Users ?? []));
    token = res.PaginationToken;
  } while (token);
  return users
    .map((u) => {
      const username = u.Username ?? '';
      return {
        username,
        email: attr(u.Attributes, 'email') ?? '',
        status: u.UserStatus ?? 'UNKNOWN',
        enabled: u.Enabled ?? false,
        isAdmin: admins!.has(username),
        apps: APPS.filter((_, i) => appMembers[i]!.has(username)).map((a) => a.id),
        createdAt: u.UserCreateDate?.toISOString() ?? '',
      };
    })
    .sort((a, b) => a.email.localeCompare(b.email));
}

async function setGroup(username: string, group: string, on: boolean) {
  const input = { UserPoolId: POOL, Username: username, GroupName: group };
  await cognito.send(on ? new AdminAddUserToGroupCommand(input) : new AdminRemoveUserFromGroupCommand(input));
}

/** 使えるアプリと管理者権限を、指定どおりにそろえる */
export async function setAccess(username: string, current: { apps: string[]; isAdmin: boolean }, next: { apps?: string[]; isAdmin?: boolean }) {
  const tasks: Promise<void>[] = [];
  if (next.apps) {
    for (const app of APPS) {
      const want = next.apps.includes(app.id);
      if (want !== current.apps.includes(app.id)) tasks.push(setGroup(username, appGroup(app.id), want));
    }
  }
  if (next.isAdmin !== undefined && next.isAdmin !== current.isAdmin) tasks.push(setGroup(username, ADMIN_GROUP, next.isAdmin));
  await Promise.all(tasks);
}

/**
 * ユーザーを追加する。password を指定したときは初回ログイン用の仮パスワードにする (メールは送らない)。
 * 省略したときは Cognito が仮パスワードをメールで送る。どちらも初回ログイン時に本人が新しいパスワードを設定する
 */
export async function createUser(email: string, password: string | undefined, apps: string[], isAdmin: boolean): Promise<void> {
  const res = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: POOL,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
      ...(password ? { TemporaryPassword: password, MessageAction: 'SUPPRESS' as const } : {}),
    }),
  );
  const username = res.User?.Username;
  if (!username) throw new Error('ユーザーを作成できませんでした');
  await setAccess(username, { apps: [], isAdmin: false }, { apps, isAdmin });
}

export async function resetPassword(username: string, password: string): Promise<void> {
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: username, Password: password, Permanent: false }));
}

export async function setEnabled(username: string, enabled: boolean): Promise<void> {
  const input = { UserPoolId: POOL, Username: username };
  await cognito.send(enabled ? new AdminEnableUserCommand(input) : new AdminDisableUserCommand(input));
}

export async function deleteUser(username: string): Promise<void> {
  await cognito.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: username }));
}

/** Cognito のエラーを日本語にする */
export function cognitoMessage(e: unknown): string | undefined {
  switch ((e as { name?: string })?.name) {
    case 'UsernameExistsException':
      return 'このメールアドレスのユーザーはすでにいます';
    case 'InvalidPasswordException':
      return 'パスワードは 12 文字以上で、英大文字・英小文字・数字・記号をそれぞれ含めてください';
    case 'InvalidParameterException':
      return '入力内容が正しくありません (メールアドレスを確認してください)';
    case 'UserNotFoundException':
      return 'ユーザーが見つかりません';
    default:
      return undefined;
  }
}
export const ADMIN_GROUP_NAME = ADMIN_GROUP;

/** ログの表示用: Cognito の sub (トークンに入っている利用者の ID) とメールアドレスの対応 */
export async function subEmails(): Promise<{ sub: string; email: string }[]> {
  const out: { sub: string; email: string }[] = [];
  let token: string | undefined;
  do {
    const res = await cognito.send(new ListUsersCommand({ UserPoolId: POOL, PaginationToken: token, AttributesToGet: ['sub', 'email'] }));
    for (const u of res.Users ?? []) {
      const sub = attr(u.Attributes, 'sub');
      if (sub) out.push({ sub, email: attr(u.Attributes, 'email') ?? sub });
    }
    token = res.PaginationToken;
  } while (token);
  return out.sort((a, b) => a.email.localeCompare(b.email));
}
