import { useCallback, useEffect, useState } from 'react';
import { appName, LOG_APPS, type LogBucket, type LogFilterKind, type LogRow, type LogsResponse } from '../../../shared/logs';
import { api } from '../api';
import type { Shared } from '../App';

const PERIODS: { hours: number; label: string }[] = [
  { hours: 1, label: '1時間' },
  { hours: 24, label: '24時間' },
  { hours: 24 * 7, label: '7日' },
  { hours: 24 * 30, label: '30日' },
  { hours: 24 * 90, label: '90日' },
];

const KINDS: { id: LogFilterKind; label: string }[] = [
  { id: 'all', label: 'すべて' },
  { id: 'api', label: '操作' },
  { id: 'view', label: '画面' },
  { id: 'error', label: 'エラー' },
];

/** 応答が遅い (1 秒以上) */
const SLOW_MS = 1000;
const TZ = 'Asia/Tokyo';

type Level = 'ERROR' | 'WARN' | 'INFO';
function levelOf(r: LogRow): Level {
  if (r.kind === 'error' || (r.status ?? 0) >= 500) return 'ERROR';
  if ((r.status ?? 0) >= 400 || (r.kind === 'api' && (r.ms ?? 0) >= SLOW_MS)) return 'WARN';
  return 'INFO';
}

const pad = (n: number) => String(n).padStart(2, '0');
/** 日本時間の部品 */
function jst(iso: string) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return { m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes(), s: d.getUTCSeconds() };
}
const logTime = (iso: string, withDate: boolean) => {
  const t = jst(iso);
  const time = `${pad(t.h)}:${pad(t.min)}:${pad(t.s)}`;
  return withDate ? `${pad(t.m)}/${pad(t.d)} ${time}` : time;
};
const bucketLabel = (iso: string, minutes: number) => {
  const t = jst(iso);
  if (minutes < 60 * 6) return `${pad(t.h)}:${pad(t.min)}`;
  if (minutes < 60 * 24) return `${t.m}/${t.d} ${t.h}時`;
  return `${t.m}/${t.d}`;
};
const fmt = (n: number) => n.toLocaleString('ja-JP');
const ms = (n?: number) => (n === undefined ? '—' : `${fmt(n)} ms`);
const shortUser = (u: string) => (u.includes('@') ? u.split('@')[0]! : u);

/** ログ: 上はダッシュボード (数字・件数の推移・アプリ別)、下はログの一覧 (管理者のみ) */
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

  const t = data?.totals;
  const errors = t ? t.serverErrors + t.screenErrors : 0;

  return (
    <div className={`logs${loading ? ' is-loading' : ''}`}>
      <header className="page-head">
        <h1 className="page-title">ログ</h1>
        <button className="btn btn-small" onClick={() => void load()} disabled={loading}>
          {loading ? '読み込み中…' : '更新'}
        </button>
      </header>

      <div className="logs-toolbar" role="group" aria-label="絞り込み">
        <div className="segmented small-seg" role="radiogroup" aria-label="期間">
          {PERIODS.map((p) => (
            <button key={p.hours} role="radio" aria-checked={hours === p.hours} className={hours === p.hours ? 'active' : ''} onClick={() => setHours(p.hours)}>
              {p.label}
            </button>
          ))}
        </div>
        <select className="input logs-select" aria-label="アプリ" value={app} onChange={(e) => setApp(e.target.value)}>
          <option value="">すべてのアプリ</option>
          {LOG_APPS.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <select className="input logs-select" aria-label="ユーザー" value={user} onChange={(e) => setUser(e.target.value)}>
          <option value="">すべてのユーザー</option>
          {users.map((u) => (
            <option key={u.sub} value={u.sub}>{u.email}</option>
          ))}
        </select>
      </div>

      <section className="logs-kpis" aria-label="期間の数字">
        <Kpi label="操作" value={t ? fmt(t.requests) : '—'} />
        <Kpi label="エラー" value={t ? fmt(errors) : '—'} tone={errors ? 'error' : undefined} />
        <Kpi label="拒否 (4xx)" value={t ? fmt(t.clientErrors) : '—'} tone={t?.clientErrors ? 'warn' : undefined} />
        <Kpi label="平均応答" value={ms(t?.avgMs)} />
        <Kpi label="応答 p95" value={ms(t?.p95Ms)} tone={(t?.p95Ms ?? 0) >= SLOW_MS ? 'warn' : undefined} />
        <Kpi label="画面表示" value={t ? fmt(t.views) : '—'} />
      </section>

      <section className="card logs-chart-card" aria-label="操作の件数の推移">
        <div className="logs-card-head">
          <h2 className="card-title">操作の件数</h2>
          <ul className="logs-legend">
            <li><span className="swatch swatch-ok" />正常</li>
            <li><span className="swatch swatch-err" />エラー</li>
          </ul>
        </div>
        {data && <Timeline buckets={data.timeline} minutes={data.bucketMinutes} />}
      </section>

      {data && data.summary.length > 0 && (
        <section className="card logs-apps" aria-label="アプリ別">
          <div className="table-wrap">
            <table className="logs-table">
              <thead>
                <tr>
                  <th>アプリ</th>
                  <th className="num">操作</th>
                  <th className="num">エラー</th>
                  <th className="num">拒否</th>
                  <th className="num opt">平均</th>
                  <th className="num">p95</th>
                  <th className="num opt">画面</th>
                </tr>
              </thead>
              <tbody>
                {data.summary.map((s) => (
                  <tr key={s.app} className={s.recorded === false ? 'is-empty' : ''}>
                    <td>{appName(s.app)}</td>
                    {s.recorded === false ? (
                      <td className="num muted" colSpan={6}>記録なし</td>
                    ) : (
                      <>
                        <td className="num">{fmt(s.requests)}</td>
                        <td className={`num${s.serverErrors + s.screenErrors ? ' t-error' : ''}`}>{fmt(s.serverErrors + s.screenErrors)}</td>
                        <td className={`num${s.clientErrors ? ' t-warn' : ''}`}>{fmt(s.clientErrors)}</td>
                        <td className="num opt">{ms(s.avgMs)}</td>
                        <td className={`num${(s.p95Ms ?? 0) >= SLOW_MS ? ' t-warn' : ''}`}>{ms(s.p95Ms)}</td>
                        <td className="num opt">{fmt(s.views)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card logs-stream" aria-label="ログの一覧">
        <div className="logs-card-head">
          <div className="segmented small-seg" role="radiogroup" aria-label="種類">
            {KINDS.map((k) => (
              <button key={k.id} role="radio" aria-checked={kind === k.id} className={kind === k.id ? 'active' : ''} onClick={() => setKind(k.id)}>
                {k.label}
              </button>
            ))}
          </div>
          {data && <span className="logs-count">{fmt(data.rows.length)}{data.truncated ? '+' : ''} 件</span>}
        </div>
        {data && !data.rows.length && <p className="logs-empty">ログはありません</p>}
        <ol className="log-lines">
          {data?.rows.map((r, i) => <LogLine key={i} r={r} withDate={hours > 24} />)}
        </ol>
      </section>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'error' | 'warn' }) {
  return (
    <div className={`lkpi${tone ? ` lkpi-${tone}` : ''}`}>
      <span className="lkpi-label">{label}</span>
      <span className="lkpi-value">{value}</span>
    </div>
  );
}

/** 1 行 1 件。押すと詳しい内容 (端末・ルート・エラーの全文) を開く */
function LogLine({ r, withDate }: { r: LogRow; withDate: boolean }) {
  const [open, setOpen] = useState(false);
  const level = levelOf(r);
  const message =
    r.kind === 'api' ? r.action : r.kind === 'view' ? `画面 ${r.action}` : r.kind === 'perf' ? `表示 ${r.action}` : `${r.action ? `${r.action}: ` : ''}${r.detail ?? ''}`;
  return (
    <li className={`log-line lv-${level.toLowerCase()}${open ? ' is-open' : ''}`}>
      <button className="log-line-main" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <time className="ll-time" dateTime={r.at}>{logTime(r.at, withDate)}</time>
        <span className="ll-level">{level}</span>
        <span className="ll-app">{r.app}</span>
        <span className="ll-user">{shortUser(r.user)}</span>
        <span className="ll-msg">{message}</span>
        <span className="ll-status">{r.status ?? ''}</span>
        <span className={`ll-ms${r.kind === 'api' && (r.ms ?? 0) >= SLOW_MS ? ' t-warn' : ''}`}>{r.ms === undefined ? '' : `${fmt(r.ms)}ms`}</span>
      </button>
      {open && (
        <dl className="log-detail">
          <dt>時刻</dt><dd>{new Date(r.at).toLocaleString('ja-JP', { timeZone: TZ })}</dd>
          <dt>アプリ</dt><dd>{appName(r.app)}</dd>
          <dt>ユーザー</dt><dd>{r.user || '—'}</dd>
          {r.route && (<><dt>ルート</dt><dd>{r.route}</dd></>)}
          {r.device && (<><dt>端末</dt><dd>{r.device}</dd></>)}
          {r.detail && (<><dt>内容</dt><dd className="t-error">{r.detail}</dd></>)}
        </dl>
      )}
    </li>
  );
}

/** 0 から始まる、きりのよい目盛りの最大値 */
function niceMax(v: number): number {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  // 半分の目盛りも整数になるように偶数だけにする
  const n = [1, 2, 3, 4, 5, 6, 8, 10].find((x) => x * p >= v)!;
  if (p === 1 && n % 2) return n + 1;
  return n * p;
}

/** 区切りごとの操作の件数 (正常とエラーの積み上げ)。棒にカーソルを合わせると数字が出る */
function Timeline({ buckets, minutes }: { buckets: LogBucket[]; minutes: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...buckets.map((b) => Math.max(b.requests, b.errors))));
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 6));
  const h = hover === null ? null : buckets[hover]!;
  const total = buckets.reduce((a, b) => a + b.requests, 0);

  return (
    <div className="tl" role="img" aria-label={`操作の件数の推移。合計 ${fmt(total)} 件`}>
      <div className="tl-plot">
        {[1, 0.5, 0].map((f) => (
          <div key={f} className="tl-grid" style={{ bottom: `${f * 100}%` }}>
            <span>{fmt(max * f)}</span>
          </div>
        ))}
        <div className="tl-bars" onMouseLeave={() => setHover(null)}>
          {buckets.map((b, i) => {
            const errors = Math.min(b.errors, b.requests || b.errors);
            const ok = Math.max(0, b.requests - errors);
            return (
              <div
                key={b.start}
                className={`tl-col${hover === i ? ' is-hover' : ''}`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                tabIndex={0}
                aria-label={`${bucketLabel(b.start, minutes)} 操作 ${b.requests} 件、エラー ${b.errors} 件`}
              >
                <div className="tl-stack" style={{ height: `${((ok + errors) / max) * 100}%` }}>
                  {errors > 0 && <div className="tl-err" style={{ flexGrow: errors }} />}
                  {ok > 0 && <div className="tl-ok" style={{ flexGrow: ok }} />}
                </div>
              </div>
            );
          })}
        </div>
        {h && hover !== null && (
          <div className="tl-tip" style={{ left: `${((hover + 0.5) / buckets.length) * 100}%` }}>
            <strong>{bucketLabel(h.start, minutes)}</strong>
            <span>操作 {fmt(h.requests)}</span>
            <span>エラー {fmt(h.errors)}</span>
          </div>
        )}
      </div>
      <div className="tl-x" aria-hidden="true">
        {buckets.map((b, i) => (
          <span key={b.start}>{i % labelEvery === 0 ? bucketLabel(b.start, minutes) : ''}</span>
        ))}
      </div>
    </div>
  );
}
