import { useEffect, useState, type FormEvent } from 'react';
import type { AdminUser, UsageKey, UsageResponse, UsageTotals } from '../../../shared/types';
import { api } from '../api';
import type { Shared } from '../App';

const num = (n: number) => n.toLocaleString('ja-JP');
/** 入力 + 出力 + キャッシュの合計 */
const all = (t: UsageTotals) => t.input + t.output + t.cacheRead + t.cacheWrite;

/** 日本時間の今月 (YYYY-MM) */
const thisMonth = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 7);
function shift(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

const sourceLabel = (s: string) => (s === 'claude-code' ? 'Claude Code' : s.startsWith('app:') ? `アプリ: ${s.slice(4)}` : s);

function Breakdown({ t }: { t: UsageTotals }) {
  return (
    <span className="muted small">
      入力 {num(t.input)}・出力 {num(t.output)}・キャッシュ {num(t.cacheRead + t.cacheWrite)}・{num(t.requests)} 回
    </span>
  );
}

/** 管理者向け: Claude の使用量 (アプリと Claude Code) と、送信用キーの管理 */
export function UsagePanel({ handleError, toast }: Shared) {
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState<UsageResponse | null>(null);
  const [keys, setKeys] = useState<UsageKey[] | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState<'user' | 'service'>('user');
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    api.usage(month).then(setData, handleError);
  }, [month, handleError]);

  const loadKeys = () => api.usageKeys().then(setKeys, handleError);
  useEffect(() => {
    void loadKeys();
    api.users().then((u) => {
      setUsers(u);
      setUsername((cur) => cur || u[0]?.username || '');
    }, handleError);
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.createUsageKey({ label: label.trim(), scope, username: scope === 'user' ? username : undefined });
      setCreated(res.key);
      setLabel('');
      await loadKeys();
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (k: UsageKey) => {
    if (!confirm(`「${k.label}」のキーを取り消しますか？ このキーでは送れなくなります。`)) return;
    try {
      await api.deleteUsageKey(k.id);
      toast('取り消しました');
      await loadKeys();
    } catch (err) {
      handleError(err);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('コピーしました');
    } catch {
      toast('コピーできませんでした。手で選んでコピーしてください', true);
    }
  };

  const max = Math.max(...(data?.users.map((u) => all(u.totals)) ?? []), 1);

  return (
    <>
      <header className="page-head">
        <h1 className="page-title">使用量</h1>
      </header>
      <p className="muted">Claude のトークン使用量です (アプリと Claude Code の分。日本時間の月ごと)。</p>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{month.replace('-', ' 年 ')} 月</h2>
          <span>
            <button className="btn btn-small" onClick={() => setMonth(shift(month, -1))}>前の月</button>{' '}
            <button className="btn btn-small" disabled={month >= thisMonth()} onClick={() => setMonth(shift(month, 1))}>次の月</button>
          </span>
        </div>
        {!data && <p className="muted">読み込み中…</p>}
        {data && (
          <>
            <div className="aws-grid">
              <div className="stat">
                <p className="muted small">合計トークン</p>
                <p className="big">{num(all(data.total))}</p>
                <p className="muted small">{num(data.total.requests)} 回</p>
              </div>
              <div className="stat">
                <p className="muted small">入力 / 出力</p>
                <p className="big">{num(data.total.input)} / {num(data.total.output)}</p>
                <p className="muted small">キャッシュ {num(data.total.cacheRead + data.total.cacheWrite)}</p>
              </div>
            </div>
            {data.users.length === 0 && <p className="muted small">この月の使用量はまだありません</p>}
            <ul className="bars">
              {data.users.map((u) => (
                <li key={u.username}>
                  <div className="bar-head">
                    <span>{u.email}</span>
                    <span className="num">{num(all(u.totals))}</span>
                  </div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${(all(u.totals) / max) * 100}%` }} />
                  </div>
                  <Breakdown t={u.totals} />
                  {u.sources.map((s) => (
                    <p key={s.source} className="muted small">
                      {sourceLabel(s.source)}: {num(all(s.totals))}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">送信用キー</h2>
        <p className="muted small">
          Claude Code の hook やアプリのサーバーから、使用量を送るためのキーです。キーは作った直後の 1 回だけ表示されます。
          「ユーザー用」は持ち主の分だけ送れます。「アプリのサーバー用」は、利用者の名前を付けて送れます。
        </p>
        <form className="admin-form" onSubmit={create}>
          <div className="segmented small-seg" role="group" aria-label="キーの種類">
            <button type="button" className={scope === 'user' ? 'active' : ''} onClick={() => setScope('user')}>ユーザー用</button>
            <button type="button" className={scope === 'service' ? 'active' : ''} onClick={() => setScope('service')}>アプリのサーバー用</button>
          </div>
          {scope === 'user' && (
            <label className="field">
              <span>持ち主</span>
              <select className="input" value={username} onChange={(e) => setUsername(e.target.value)} required>
                {users.map((u) => (
                  <option key={u.username} value={u.username}>{u.email || u.username}</option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>ラベル (どこで使うか。例: いくみの Mac の Claude Code)</span>
            <input className="input" required maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <button className="btn btn-primary" disabled={busy}>キーを作る</button>
        </form>

        {created && (
          <div className="note">
            <p><strong>このキーは今しか表示されません。</strong>安全な場所に保存してください (リポジトリには書かないでください)。</p>
            <p className="small" style={{ wordBreak: 'break-all', fontFamily: 'monospace' }}>{created}</p>
            <button className="btn btn-small" onClick={() => void copy(created)}>コピー</button>{' '}
            <button className="btn btn-small btn-ghost" onClick={() => setCreated(null)}>閉じる</button>
          </div>
        )}

        {!keys && <p className="muted">読み込み中…</p>}
        <ul className="list">
          {keys?.map((k) => (
            <li key={k.id} className="user-row">
              <div className="grow">
                <strong>{k.label}</strong>
                <span className="muted small">
                  <span className="chip">{k.scope === 'service' ? 'アプリのサーバー用' : 'ユーザー用'}</span>
                  {k.scope === 'user' && (k.email || k.username)} ・{k.createdAt.slice(0, 10)} 作成
                </span>
              </div>
              <div className="user-actions">
                <button className="btn btn-small btn-danger" onClick={() => void remove(k)}>取り消す</button>
              </div>
            </li>
          ))}
          {keys?.length === 0 && <li className="muted small">まだキーはありません</li>}
        </ul>
      </section>
    </>
  );
}
