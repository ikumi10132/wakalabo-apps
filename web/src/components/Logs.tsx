import { useCallback, useEffect, useState } from 'react';
import { appName, LOG_APPS, type LogFilterKind, type LogKind, type LogRow, type LogsResponse } from '../../../shared/logs';
import { api } from '../api';
import type { Shared } from '../App';

const PERIODS: { hours: number; label: string }[] = [
  { hours: 1, label: '1 時間' },
  { hours: 24, label: '24 時間' },
  { hours: 24 * 7, label: '7 日' },
  { hours: 24 * 30, label: '30 日' },
  { hours: 24 * 90, label: '90 日' },
];

const KINDS: { id: LogFilterKind; label: string }[] = [
  { id: 'all', label: 'すべて' },
  { id: 'api', label: '操作' },
  { id: 'view', label: '画面' },
  { id: 'error', label: 'エラー' },
];

const KIND_LABEL: Record<LogKind, string> = { api: '操作', view: '画面', error: '画面のエラー', perf: '表示時間' };

const time = (iso: string, withDate: boolean) =>
  new Date(iso).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    ...(withDate && { month: 'numeric', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

const isError = (r: LogRow) => r.kind === 'error' || (r.status ?? 0) >= 500;
const isWarn = (r: LogRow) => !isError(r) && (r.status ?? 0) >= 400;
/** 応答が遅い (1 秒以上) */
const SLOW_MS = 1000;

/** 誰がどの画面を開いたか・どんな操作をしたか・応答時間・エラー (管理者のみ) */
export function Logs({ handleError }: Shared) {
  const [hours, setHours] = useState(24);
  const [app, setApp] = useState('');
  const [user, setUser] = useState('');
  const [kind, setKind] = useState<LogFilterKind>('all');
  const [data, setData] = useState<LogsResponse | null>(null);
  const [users, setUsers] = useState<LogsResponse['users']>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.logs({ hours, app, user, kind });
      setData(res);
      setUsers(res.users);
    } catch (e) {
      handleError(e);
    } finally {
      setLoading(false);
    }
  }, [hours, app, user, kind, handleError]);

  useEffect(() => void load(), [load]);

  const withDate = hours > 24;

  return (
    <>
      <header className="page-head">
        <h1 className="page-title">ログ</h1>
        <button className="btn btn-small" onClick={() => void load()} disabled={loading}>
          {loading ? '読み込み中…' : '更新'}
        </button>
      </header>

      <section className="card logs-filters" aria-label="絞り込み">
        <div className="logs-filter-grid">
          <label className="field">
            期間
            <select className="input" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {PERIODS.map((p) => (
                <option key={p.hours} value={p.hours}>直近 {p.label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            アプリ
            <select className="input" value={app} onChange={(e) => setApp(e.target.value)}>
              <option value="">すべて</option>
              {LOG_APPS.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            ユーザー
            <select className="input" value={user} onChange={(e) => setUser(e.target.value)}>
              <option value="">すべて</option>
              {users.map((u) => (
                <option key={u.sub} value={u.sub}>{u.email}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="segmented small-seg" role="radiogroup" aria-label="種類">
          {KINDS.map((k) => (
            <button key={k.id} role="radio" aria-checked={kind === k.id} className={kind === k.id ? 'active' : ''} onClick={() => setKind(k.id)}>
              {k.label}
            </button>
          ))}
        </div>
      </section>

      {data?.note && <p className="note">{data.note}</p>}

      {data && data.summary.length > 0 && (
        <section className="card" aria-label="アプリ別の集計">
          <h2 className="card-title">アプリ別</h2>
          <div className="table-wrap">
            <table className="tx-table logs-summary">
              <thead>
                <tr>
                  <th>アプリ</th>
                  <th className="num-col">操作</th>
                  <th className="num-col">エラー</th>
                  <th className="num-col">拒否・入力の誤り</th>
                  <th className="num-col">平均の応答</th>
                  <th className="num-col">遅い方 5%</th>
                  <th className="num-col">画面</th>
                  <th className="num-col">画面のエラー</th>
                </tr>
              </thead>
              <tbody>
                {data.summary.map((s) => (
                  <tr key={s.app}>
                    <td>{appName(s.app)}</td>
                    <td className="num-col">{s.requests}</td>
                    <td className={`num-col${s.serverErrors ? ' log-error' : ''}`}>{s.serverErrors}</td>
                    <td className={`num-col${s.clientErrors ? ' log-warn' : ''}`}>{s.clientErrors}</td>
                    <td className="num-col">{s.avgMs === undefined ? '—' : `${s.avgMs} ms`}</td>
                    <td className={`num-col${(s.p95Ms ?? 0) >= SLOW_MS ? ' log-warn' : ''}`}>{s.p95Ms === undefined ? '—' : `${s.p95Ms} ms`}</td>
                    <td className="num-col">{s.views}</td>
                    <td className={`num-col${s.screenErrors ? ' log-error' : ''}`}>{s.screenErrors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">「遅い方 5%」: 応答が遅い順に並べて上位 5% に入る境目の時間。エラーは 500 番台、拒否・入力の誤りは 400 番台 (ログイン切れ・権限なしを含む)</p>
        </section>
      )}

      <section className="card list logs-list" aria-label="ログの一覧">
        {!data && <p className="muted logs-empty">読み込み中…</p>}
        {data && !data.rows.length && <p className="muted logs-empty">この条件のログはありません</p>}
        <ul className="list">
          {data?.rows.map((r, i) => (
            <li key={i} className={`log-row${isError(r) ? ' is-error' : isWarn(r) ? ' is-warn' : ''}`}>
              <div className="log-meta">
                <time dateTime={r.at}>{time(r.at, withDate)}</time>
                <span>{appName(r.app)}</span>
                <span className="log-user">{r.user}</span>
                {r.device && <span>{r.device}</span>}
              </div>
              <div className="log-main">
                <span className={`chip log-kind log-kind-${r.kind}`}>{KIND_LABEL[r.kind]}</span>
                <span className="grow">{r.action || '—'}</span>
                {r.status !== undefined && <span className="log-status">{r.status}</span>}
                {r.ms !== undefined && <span className={`log-ms${r.ms >= SLOW_MS ? ' log-warn' : ''}`}>{r.ms.toLocaleString('ja-JP')} ms</span>}
              </div>
              {r.detail && <p className="log-detail">{r.detail}</p>}
            </li>
          ))}
        </ul>
        {data?.truncated && <p className="muted small logs-empty">新しいものから 300 件まで表示しています。期間や条件を絞ると古いものも見られます</p>}
      </section>
    </>
  );
}
