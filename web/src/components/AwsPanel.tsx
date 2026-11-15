import { useEffect, useState } from 'react';
import { REGION } from '../../../shared/apps';
import type { CostsResponse, NamedCost } from '../../../shared/types';
import { api } from '../api';
import type { Shared } from '../App';

const R = REGION;
const CONSOLE_LINKS: [string, string][] = [
  ['コンソールのホーム', `https://${R}.console.aws.amazon.com/console/home?region=${R}`],
  ['CloudShell', `https://${R}.console.aws.amazon.com/cloudshell/home?region=${R}`],
  ['CloudFormation (スタック)', `https://${R}.console.aws.amazon.com/cloudformation/home?region=${R}`],
  ['Cognito (ログイン)', `https://${R}.console.aws.amazon.com/cognito/v2/idp/user-pools?region=${R}`],
  ['請求ダッシュボード', 'https://us-east-1.console.aws.amazon.com/billing/home'],
  ['無料プラン・クレジット', 'https://us-east-1.console.aws.amazon.com/billing/home#/freetier'],
  ['Cost Explorer', 'https://us-east-1.console.aws.amazon.com/costmanagement/home#/cost-explorer'],
  ['予算 (Budgets)', 'https://us-east-1.console.aws.amazon.com/costmanagement/home#/budgets'],
  ['コスト配分タグ', 'https://us-east-1.console.aws.amazon.com/billing/home#/tags'],
  ['AWS Settings', 'https://settings.aws.com/'],
];

const money = (n: number | undefined, unit = 'USD') =>
  n === undefined ? '—' : unit === 'USD' ? `$${n.toFixed(2)}` : `${n.toLocaleString('ja-JP')} ${unit}`;

const dateJa = (iso: string) => new Date(iso).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });

function daysLeft(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

/** 今月の利用額から、月末までの目安を日割りで出す (予測 API は有料なので使わない) */
function monthEndEstimate(total: number, now = new Date()): number {
  const day = now.getUTCDate();
  const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const elapsed = Math.max(1, day - 1);
  return (total / elapsed) * days;
}

function Bars({ items, unit }: { items: NamedCost[]; unit: string }) {
  const max = Math.max(...items.map((i) => i.amount), 0.01);
  return (
    <ul className="bars">
      {items.map((i) => (
        <li key={i.name}>
          <div className="bar-head">
            <span>{i.name}</span>
            <span className="num">{money(i.amount, unit)}</span>
          </div>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(i.amount / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function AwsPanel({ handleError, toast }: Shared) {
  const [costs, setCosts] = useState<CostsResponse | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.costs().then(setCosts, handleError);
  }, [handleError]);

  const refresh = async () => {
    if (!confirm('最新の利用料を取り直しますか？ (AWS の Cost Explorer の料金が 1 回 約 1.5 円かかります)')) return;
    setBusy(true);
    try {
      setCosts(await api.costs(true));
      toast('最新の利用料を取得しました');
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  const unit = costs?.currency ?? 'USD';
  const plan = costs?.plan;
  const month = costs?.thisMonth;

  return (
    <>
      <h2 className="section-title">AWS</h2>
      <section className="card">
        <div className="aws-grid">
          <div className="stat">
            <p className="muted small">残りのクレジット</p>
            <p className="big">{plan?.remainingCredits !== undefined ? money(plan.remainingCredits, plan.creditUnit ?? 'USD') : '—'}</p>
            <p className="muted small">{plan ? `プラン: ${plan.type === 'FREE' ? '無料プラン' : plan.type === 'PAID' ? '有料プラン' : plan.type}` : ''}</p>
          </div>
          <div className="stat">
            <p className="muted small">無料プランの期限</p>
            <p className="big">{plan?.expiresAt ? `あと ${daysLeft(plan.expiresAt)} 日` : '—'}</p>
            <p className={`small ${plan?.expiresAt && daysLeft(plan.expiresAt) <= 30 ? 'warn' : 'muted'}`}>
              {plan?.expiresAt ? `${dateJa(plan.expiresAt)} まで (それまでに有料プランへ切り替え)` : ''}
            </p>
          </div>
          <div className="stat">
            <p className="muted small">今月の利用額</p>
            <p className="big">{money(month?.total, unit)}</p>
            <p className="muted small">{month ? `月末の目安 ${money(monthEndEstimate(month.total), unit)}` : ''}</p>
          </div>
          <div className="stat">
            <p className="muted small">先月の利用額</p>
            <p className="big">{money(costs?.lastMonth?.total, unit)}</p>
            <p className="muted small">クレジット適用前の金額</p>
          </div>
        </div>

        {!costs && <p className="muted">読み込み中…</p>}
        {costs?.costsError && <p className="note">{costs.costsError}</p>}

        {month && (
          <div className="two-col">
            <div>
              <h3 className="card-title">アプリ別 (今月)</h3>
              {costs?.appsNote && <p className="note">{costs.appsNote}</p>}
              {month.apps.length > 0 ? <Bars items={month.apps} unit={unit} /> : <p className="muted small">まだ利用はありません</p>}
            </div>
            <div>
              <h3 className="card-title">サービス別 (今月)</h3>
              {month.services.length > 0 ? <Bars items={month.services} unit={unit} /> : <p className="muted small">まだ利用はありません</p>}
            </div>
          </div>
        )}

        {costs && (
          <p className="muted small">
            {new Date(costs.fetchedAt).toLocaleString('ja-JP')} 時点 (12 時間ごとに更新)
            <button className="btn btn-small btn-ghost" disabled={busy} onClick={() => void refresh()}>
              {busy ? '取得中…' : '今すぐ更新'}
            </button>
          </p>
        )}
      </section>

      <section className="card">
        <h3 className="card-title">AWS コンソール</h3>
        <div className="links">
          {CONSOLE_LINKS.map(([label, href]) => (
            <a key={label} href={href} target="_blank" rel="noreferrer">{label}</a>
          ))}
        </div>
      </section>
    </>
  );
}
