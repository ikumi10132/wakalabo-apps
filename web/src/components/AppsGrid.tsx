import type { AppDef } from '../../../shared/apps';
import { REGION } from '../../../shared/apps';
import { IconExternal } from './Icons';

const stackUrl = (stack: string) =>
  `https://${REGION}.console.aws.amazon.com/cloudformation/home?region=${REGION}#/stacks?filteringText=${encodeURIComponent(stack)}`;

export function AppsGrid({ apps, isAdmin }: { apps: AppDef[]; isAdmin: boolean }) {
  if (apps.length === 0) {
    return (
      <section className="card">
        <p className="muted center-text">使えるアプリがありません。管理者に追加してもらってください。</p>
      </section>
    );
  }
  return (
    <div className="apps">
      {apps.map((a) => (
        <section key={a.id} className="card app-card">
          <div className="app-head">
            <span className="app-icon" aria-hidden>{a.icon}</span>
            <div>
              <h3 className="app-name">{a.name}</h3>
              <p className="app-desc">{a.description}</p>
            </div>
          </div>
          <a className="btn btn-primary" href={a.url} target="_blank" rel="noreferrer">
            開く <IconExternal />
          </a>
          {isAdmin && (
            <div className="app-links">
              {a.repo && <a href={`https://github.com/${a.repo}`} target="_blank" rel="noreferrer">GitHub</a>}
              {a.stack && <a href={stackUrl(a.stack)} target="_blank" rel="noreferrer">CloudFormation</a>}
              <a href={a.url} target="_blank" rel="noreferrer">{new URL(a.url).host}</a>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
