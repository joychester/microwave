import { useState } from 'react';
import { fmtCost } from '../engine/cost';
import { CAUSE_LABELS } from '../engine/sim';
import { useStore } from './store';
import { useRuns, type RunReport } from './runs';
import { useLang, useT } from './i18n';
import { fmtAvail, fmtClock, fmtCount, fmtLatency, fmtPct, fmtRate } from './format';
import { Glyph } from './Glyph';
import type { NodeType } from '../engine/types';

type Better = 'up' | 'down';
interface Tile { k: string; v: string; prev?: number; cur?: number; better?: Better; fmtDelta?: (d: number) => string; note?: string; tone?: 'crit' | 'ok' | '' }

function Delta({ cur, prev, better, fmt }: { cur: number; prev: number; better: Better; fmt: (d: number) => string }) {
  const d = cur - prev;
  if (!isFinite(d) || Math.abs(d) < 1e-9) return <span className="dl dl--same">=</span>;
  const good = better === 'up' ? d > 0 : d < 0;
  return <span className={`dl ${good ? 'dl--good' : 'dl--bad'}`}>{d > 0 ? '▲' : '▼'} {fmt(Math.abs(d))}</span>;
}

export function ReportPanel() {
  const t = useT();
  const lang = useLang();
  const reports = useRuns((r) => r.reports);
  const acc = useRuns((r) => r.acc);
  const duration = useRuns((r) => r.duration);
  const [sel, setSel] = useState(0);
  const select = useStore((s) => s.select);
  const reset = useStore((s) => s.reset);
  const run = useStore((s) => s.run);
  const showToast = useStore((s) => s.showToast);

  if (reports.length === 0) {
    return (
      <div className="rp-empty">
        <p>{t('设置好运行时长（点顶部时钟）后开始运行，到点会自动停止，并在这里生成报告。', 'Pick a run length (click the clock at the top) and run. The simulation stops on time and the report appears here.')}</p>
        {acc && <p>{t(`当前运行进度：${fmtClock(acc.seconds * 1000)} / ${fmtClock(duration * 1000)}`, `Current run: ${fmtClock(acc.seconds * 1000)} / ${fmtClock(duration * 1000)}`)}</p>}
      </div>
    );
  }
  const r = reports[Math.min(sel, reports.length - 1)];
  const p: RunReport | undefined = reports[Math.min(sel, reports.length - 1) + 1];
  const relT = (abs: number) => fmtClock(Math.max(0, abs - r.t0) * 1000);
  const pct = r.pct ?? 'p99';

  const tiles: Tile[] = [
    { k: t('可用性', 'Availability'), v: fmtAvail(r.avail), cur: r.avail * 100, prev: p ? p.avail * 100 : undefined, better: 'up', fmtDelta: (d) => `${d.toFixed(2)}pt`, tone: r.avail < r.slo.avail ? 'crit' : 'ok', note: `SLO ${fmtAvail(r.slo.avail)}` },
    { k: t('平均延迟', 'Avg latency'), v: fmtLatency(r.latAvg ?? 0), cur: r.latAvg ?? 0, prev: p?.latAvg, better: 'down', fmtDelta: fmtLatency, note: t('整次运行所有请求的平均值', 'Mean over every request in the run') },
    { k: t(`${pct} 峰值`, `Peak ${pct}`), v: fmtLatency(r.p99Max), cur: r.p99Max, prev: p?.p99Max, better: 'down', fmtDelta: fmtLatency, tone: r.p99Max > r.slo.p99 ? 'crit' : 'ok', note: `SLO ${fmtLatency(r.slo.p99)}` },
    { k: t('SLO 达标时间', 'Time within SLO'), v: fmtPct(r.sloSeconds / Math.max(1, r.seconds)), cur: (r.sloSeconds / Math.max(1, r.seconds)) * 100, prev: p ? (p.sloSeconds / Math.max(1, p.seconds)) * 100 : undefined, better: 'up', fmtDelta: (d) => `${d.toFixed(0)}pt` },
    {
      k: t('拐点', 'Knee point'),
      v: r.knee ? `${fmtRate(r.knee.rps)}/s` : t('未出现', 'None'),
      note: r.knee ? t(`第 ${relT(r.knee.t)} 起 SLO 连续被打破${r.knee.nodeName ? `，当时最忙：${r.knee.nodeName}` : ''}`, `SLO broken from ${relT(r.knee.t)}${r.knee.nodeName ? `; busiest: ${r.knee.nodeName}` : ''}`) : t('整个运行期间 SLO 没有被连续打破', 'The SLO never broke for 3 s in a row'),
      cur: r.knee?.rps, prev: p?.knee?.rps, better: 'up', fmtDelta: (d) => `${fmtRate(d)}/s`, tone: r.knee ? 'crit' : 'ok',
    },
    {
      k: t('最先饱和', 'First to saturate'),
      v: r.firstSaturated ? r.firstSaturated.name : t('无', 'None'),
      note: r.firstSaturated ? t(`第 ${relT(r.firstSaturated.t)}，入口流量 ${fmtRate(r.firstSaturated.rps)}/s`, `at ${relT(r.firstSaturated.t)}, entry rate ${fmtRate(r.firstSaturated.rps)}/s`) : t('没有组件持续达到 95% 利用率', 'No component stayed at 95%+'),
    },
    { k: t('平均成本', 'Avg. cost'), v: `${fmtCost(r.costAvg)}/h`, cur: r.costAvg, prev: p?.costAvg, better: 'down', fmtDelta: (d) => fmtCost(d) },
  ];
  if (r.lagMax > 0) tiles.push({ k: t('Kafka 最大积压', 'Max Kafka lag'), v: fmtCount(r.lagMax), cur: r.lagMax, prev: p?.lagMax, better: 'down', fmtDelta: fmtCount });

  const nodes = Object.entries(r.nodes).filter(([, n]) => n.type !== 'client').sort((a, b) => b[1].peakUtil - a[1].peakUtil);
  const causes = Object.entries(r.causes).sort((a, b) => b[1] - a[1]);

  const copy = async () => {
    const lines = [
      `# SimBench ${t('运行报告', 'run report')} ${r.name}`,
      '',
      `- ${t('拓扑', 'Topology')}: ${r.topology}`,
      `- ${t('时长', 'Duration')}: ${fmtClock(r.seconds * 1000)}`,
      ...r.traffic.map((tr) => `- ${t('流量', 'Traffic')}: ${tr.name}: ${tr.model}`),
      `- ${t('请求', 'Requests')}: ${fmtCount(r.requests)}, ${t('峰值入口流量', 'peak entry rate')} ${fmtRate(r.offeredPeak)}/s`,
      '',
      ...tiles.map((x) => `- **${x.k}**: ${x.v}${x.note ? ` (${x.note})` : ''}`),
      '',
      `| ${t('组件', 'Component')} | ${t('峰值利用率', 'Peak util.')} | ${t('峰值时刻', 'At')} | ${pct} ${t('峰值', 'peak')} | ${t('失败', 'Failures')} |`,
      '|---|---|---|---|---|',
      ...nodes.map(([, n]) => `| ${n.name} | ${fmtPct(n.peakUtil)} | ${relT(n.peakT)} | ${fmtLatency(n.p99Max)} | ${fmtCount(n.err)} |`),
    ];
    try { await navigator.clipboard.writeText(lines.join('\n')); showToast(t('报告已复制为 Markdown', 'Report copied as Markdown')); }
    catch { showToast(t('浏览器不允许写剪贴板', 'The browser blocked clipboard access'), 'warn'); }
  };

  return (
    <div className="rp">
      <div className="rp-bar">
        <div className="seg" role="tablist" aria-label={t('选择报告', 'Choose a report')}>
          {reports.map((x, i) => (
            <button key={x.id} type="button" role="tab" aria-selected={i === sel} className={i === sel ? 'is-on' : ''} onClick={() => setSel(i)}>{x.name}</button>
          ))}
        </div>
        <span className="rp-meta">
          {r.topology}{lang === 'en' ? ', ' : '，'}{fmtClock(r.seconds * 1000)}{lang === 'en' ? ', ' : '，'}
          {r.traffic.map((tr) => `${tr.name}: ${tr.model}`).join(lang === 'en' ? '; ' : '；')}
        </span>
        {p && <span className="rp-cmp">{t(`对比 ${p.name}`, `vs ${p.name}`)}</span>}
        <span className="rp-actions">
          <button type="button" className="btn btn--ghost" onClick={copy}>{t('复制报告', 'Copy report')}</button>
          <button type="button" className="btn btn--primary" onClick={() => { reset(); setTimeout(run, 60); }}>{t('再跑一次', 'Run again')}</button>
        </span>
      </div>
      <div className="rp-body">
        <dl className="rp-tiles">
          {tiles.map((x) => (
            <div key={x.k} className={`rp-tile${x.tone ? ` rp-tile--${x.tone}` : ''}`}>
              <dt>{x.k}</dt>
              <dd>{x.v}{x.cur !== undefined && x.prev !== undefined && x.better && x.fmtDelta && <Delta cur={x.cur} prev={x.prev} better={x.better} fmt={x.fmtDelta} />}</dd>
              {x.note && <p>{x.note}</p>}
            </div>
          ))}
        </dl>
        <div className="rp-cols">
          <table className="cap-table rp-table">
            <thead>
              <tr>
                <th scope="col">{t('组件', 'Component')}</th>
                <th scope="col">{t('峰值利用率', 'Peak utilization')}</th>
                <th scope="col" className="r">{t('峰值时刻', 'At')}</th>
                <th scope="col" className="r">{t(`${pct} 峰值`, `Peak ${pct}`)}</th>
                <th scope="col" className="r">{t('失败', 'Failures')}</th>
                <th scope="col" className="r">{t('峰值到达', 'Peak arrivals')}</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map(([id, n]) => {
                const tone = n.peakUtil >= 0.95 ? 'crit' : n.peakUtil >= 0.75 ? 'warn' : 'ok';
                return (
                  <tr key={id} onClick={() => select({ kind: 'node', id })}>
                    <th scope="row"><span className="cap-node"><Glyph type={n.type as NodeType} size={16} />{n.name}</span></th>
                    <td>{n.type === 'lb' || n.type === 'queue' ? '—' : <><span className="cap-bar"><span className={`cap-bar-fill cap-bar-fill--${tone}`} style={{ width: `${Math.min(100, n.peakUtil * 100)}%` }} /></span>{fmtPct(n.peakUtil)}</>}</td>
                    <td className="r">{n.type === 'lb' || n.type === 'queue' ? '—' : relT(n.peakT)}</td>
                    <td className="r">{fmtLatency(n.p99Max)}</td>
                    <td className="r">{fmtCount(n.err)}</td>
                    <td className="r">{fmtRate(n.arrMax)}/s</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="rp-side">
            <h4>{t('失败原因', 'Failure causes')}</h4>
            {causes.length === 0 ? <p className="rp-none">{t('没有失败的请求', 'No failed requests')}</p> : (
              <ul className="rp-causes">
                {causes.map(([c, n]) => (
                  <li key={c}><span>{CAUSE_LABELS[c]?.[lang] ?? c}</span><b>{fmtCount(n)}</b><i style={{ width: `${(n / causes[0][1]) * 100}%` }} /></li>
                ))}
              </ul>
            )}
            <h4>{t('流量', 'Traffic')}</h4>
            <p className="rp-traffic">{t(`共 ${fmtCount(r.requests)} 个请求，平均 ${fmtRate(r.offeredAvg)}/s，峰值 ${fmtRate(r.offeredPeak)}/s，重试放大最高 ${r.ampMax.toFixed(2)}×`, `${fmtCount(r.requests)} requests, avg ${fmtRate(r.offeredAvg)}/s, peak ${fmtRate(r.offeredPeak)}/s, retry amplification up to ${r.ampMax.toFixed(2)}×`)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
