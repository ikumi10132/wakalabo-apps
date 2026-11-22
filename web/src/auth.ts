// ダッシュボードのログインは W-SSO (同じサイトの /sso.html) を使う
export { getAccessToken, handleRedirect, isAdmin, isLoggedIn, login, logout } from './wsso-client';
