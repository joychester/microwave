// Capacity tab: run the simulation-based limit search and read its result.
import { useState } from 'react';
import { useStore } from './store';
import { useGame } from './game';
import { useLimit, type LimitResult } from './limit';
import { useLang, useT } from './i18n';
import { fmtAvail, fmtLatency, fmtPct, fmtRate } from './format';

const HOLDS = [30, 60, 120, 300];

export function LimitPanel() {
  const t = useT();
  const L = useLimit();
  const challenge = useGame((g) => g.mode === 'challenge');
  const [detail, setDetail] = useState<LimitResult | null>(null);
  const last = L.results[0];
  if (challenge) return null;
  const running = L.phase !== 'idle';
  const step = L.steps[L.steps.length - 1];

  return (
    <div className="lim">
      <h4>{t('用仿真找上限', 'Find the limit by simulation')}</h4>
      {!running && (
        <>
          <div className="lim-form">
            <label>
              <span>{t('判定标准', 'Criterion')}</span>
              <select value={L.criterion} onChange={(e) => L.setCriterion(e.target.value as 'util' | 'slo')}>
                <option value="util">{t('利用率上限', 'Utilization cap')}</option>
                <option value="slo">{t('守住 SLO', 'Hold the SLO')}</option>
              </select>
            </label>
            {L.criterion === 'util' && (
              <label>
                <span>{t('不超过', 'At most')}</span>
                <select value={Math.round(L.threshold * 100)} onChange={(e) => L.setThreshold(Number(e.target.value) / 100)}>
                  {[50, 60, 70, 80, 90].map((v) => <option key={v} value={v}>{v}%</option>)}
                </select>
              </label>
            )}
            <label>
              <span>{t('在上限保持', 'Hold at the limit')}</span>
              <select value={L.holdSeconds} onChange={(e) => L.setHoldSeconds(Number(e.target.value))}>
                {HOLDS.map((v) => <option key={v} value={v}>{v < 60 ? `${v}s` : t(`${v / 60} 分钟`, `${v / 60} min`)}</option>)}
              </select>
            </label>
          </div>
          <button type="button" className="btn btn--primary" onClick={L.start}>{t('开始找上限', 'Find the limit')}</button>
          <p className="lim-hint">{t(
            '从当前流量开始，所有流量源按比例逐档加压，找到上限后在该负载下保持一段时间确认，然后自动停止。会先重置仿真。',
            'Starts from today’s traffic and scales every source up step by step. Once the limit is found, it holds that load for a while to confirm it, then stops. Resets the simulation first.',
          )}</p>
        </>
      )}
      {running && (
        <div className="lim-progress" aria-live="polite">
          <p>
            {L.phase === 'hold'
              ? t(`已找到上限，正在保持 ${L.scale.toFixed(2)}× 负载 ${L.holdSeconds} 秒确认…`, `Limit found; holding ${L.scale.toFixed(2)}× load for ${L.holdSeconds} s to confirm…`)
              : t(`第 ${L.steps.length + 1} 档：今天流量的 ${L.scale.toFixed(2)}×`, `Step ${L.steps.length + 1}: ${L.scale.toFixed(2)}× today’s traffic`)}
          </p>
          {step && <p className="lim-sub">{t(
            `上一档 ${fmtRate(step.offered)}/s，最高利用率 ${fmtPct(step.peakUtil)}（${step.bottleneck}）${step.pass ? '，通过' : '，超出'}`,
            `Last step ${fmtRate(step.offered)}/s, peak utilization ${fmtPct(step.peakUtil)} (${step.bottleneck}), ${step.pass ? 'passed' : 'over'}`,
          )}</p>}
          <button type="button" className="btn" onClick={L.stop}>{t('停止', 'Stop')}</button>
        </div>
      )}
      {!running && last && <ResultCard r={last} onOpen={() => setDetail(last)} />}
      {detail && <LimitDetail r={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function headline(r: LimitResult, t: ReturnType<typeof useT>) {
  const crit = r.criterion === 'util' ? t(`利用率 ≤ ${fmtPct(r.threshold)}`, `utilization ≤ ${fmtPct(r.threshold)}`) : t('守住 SLO', 'SLO held');
  if (r.note === 'stopped') return t('已手动停止，没有得出上限', 'Stopped before a limit was found');
  if (r.limitScale === null) return t(`加到 50× 仍未触及上限（${crit}）`, `No limit up to 50× (${crit})`);
  return t(`最多约 ${fmtRate(r.limitRps)}/s，是今天的 ${r.limitScale.toFixed(2)}×（${crit}）`, `Up to about ${fmtRate(r.limitRps)}/s, ${r.limitScale.toFixed(2)}× today (${crit})`);
}

function limitedText(r: LimitResult, t: ReturnType<typeof useT>) {
  const b = r.limitedBy;
  if (!b) return '';
  return b.reason === 'backlog'
    ? t(`限制因素：${b.name}，再加压消费就跟不上，积压持续增长`, `Limited by ${b.name}: one more step and its consumers fall behind, so the backlog keeps growing`)
    : b.reason === 'util'
      ? t(`限制因素：${b.name}，再加压利用率就超过标准`, `Limited by ${b.name}: one more step pushes its utilization over the cap`)
      : t(`限制因素：再加压 SLO 就被打破，当时最忙的是 ${b.name}`, `Limited by the SLO: one more step breaks it; busiest then was ${b.name}`);
}

function ResultCard({ r, onOpen }: { r: LimitResult; onOpen: () => void }) {
  const t = useT();
  const top = r.ranking[0];
  return (
    <div className="lim-result">
      <p className="lim-head">{headline(r, t)}</p>
      {r.limitedBy && <p className="lim-sub lim-why">{limitedText(r, t)}</p>}
      {top && <p className="lim-sub">{t(`上限负载下最忙：${top.name}（${fmtPct(top.util)}）`, `Busiest at the limit: ${top.name} (${fmtPct(top.util)})`)}{r.ranking[1] ? t(`，其次 ${r.ranking[1].name}（${fmtPct(r.ranking[1].util)}）`, `, then ${r.ranking[1].name} (${fmtPct(r.ranking[1].util)})`) : ''}</p>}
      {r.note === 'below-today' && <p className="lim-warn">{t('今天的流量已经超过这个标准', 'Today’s traffic is already above this criterion')}</p>}
      <button type="button" className="link" onClick={onOpen}>{t('查看详情和导出', 'Details and export')}</button>
    </div>
  );
}

function LimitDetail({ r, onClose }: { r: LimitResult; onClose: () => void }) {
  const t = useT();
  const lang = useLang();
  const showToast = useStore((s) => s.showToast);
  const md = () => [
    `# SimBench ${t('上限测试', 'limit test')} #${r.id}`, '',
    `- ${t('拓扑', 'Topology')}: ${r.topology}`,
    `- ${t('判定标准', 'Criterion')}: ${r.criterion === 'util' ? t(`所有组件利用率 ≤ ${fmtPct(r.threshold)}`, `every component at or below ${fmtPct(r.threshold)} utilization`) : t('守住 SLO', 'hold the SLO')}`,
    `- ${t('结果', 'Result')}: ${headline(r, t)}`,
    `- ${t('今天的流量', 'Today’s traffic')}: ${fmtRate(r.baseRps)}/s`,
    ...(r.limitedBy ? [`- ${limitedText(r, t)}`] : []),
    ...(r.limitScale !== null && r.note !== 'stopped' ? [
      `- ${t(`在上限保持 ${r.holdSeconds} 秒`, `Held at the limit for ${r.holdSeconds} s`)}: ${t('可用性', 'availability')} ${fmtAvail(r.hold.avail)}, ${r.hold.pct} ${fmtLatency(r.hold.lat)} (${t('最差 1 秒', 'worst second')} ${fmtLatency(r.hold.latMax)}), ${t('最高利用率', 'peak utilization')} ${fmtPct(r.hold.peakUtil)}`,
    ] : []),
    '', `## ${t('上限负载下各组件利用率', 'Utilization at the limit')}`, '',
    ...(r.ranking.length ? r.ranking.map((x, i) => `${i + 1}. ${x.name}: ${fmtPct(x.util)}`) : ['—']),
    '', `## ${t('加压过程', 'Steps')}`, '',
    `| # | ${t('倍数', 'Scale')} | ${t('入口流量', 'Entry rate')} | ${t('最高利用率', 'Peak util.')} | ${t('最忙的组件', 'Busiest')} | SLO | ${t('结果', 'Result')} |`,
    '|---|---|---|---|---|---|---|',
    ...r.steps.map((s, i) => `| ${i + 1} | ${s.scale.toFixed(2)}× | ${fmtRate(s.offered)}/s | ${fmtPct(s.peakUtil)} | ${s.bottleneck} | ${s.sloOk ? t('守住', 'held') : t('打破', 'broken')} | ${s.pass ? t('通过', 'pass') : s.reason === 'backlog' ? t('积压增长', 'backlog grows') : s.reason === 'slo' ? t('SLO 打破', 'SLO broken') : t('超出', 'over')} |`),
    '',
  ].join('\n');
  const exportMd = () => {
    const name = `${r.topology.replace(/[\s/\\]+/g, '-')}-limit${r.id}.md`;
    const text = md();
    let framed = true;
    try { framed = window.self !== window.top; } catch { /* treat as framed */ }
    if (!framed) {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
      const a = document.createElement('a'); a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(t(`已导出 ${name}`, `Exported ${name}`));
    } else {
      navigator.clipboard.writeText(text).then(
        () => showToast(t('这里不能下载文件，已复制到剪贴板', 'Downloads are blocked here; copied to the clipboard instead')),
        () => showToast(t('浏览器不允许下载或写剪贴板', 'The browser blocked both download and clipboard'), 'warn'),
      );
    }
  };
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal modal--wide lim-modal" role="dialog" aria-modal="true" aria-label={t('上限测试结果', 'Limit test result')} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t(`上限测试 #${r.id}：${r.topology}`, `Limit test #${r.id}: ${r.topology}`)}</span>
          <button type="button" className="icon-btn" aria-label={t('关闭', 'Close')} onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="cal-body">
          <p className="lim-head">{headline(r, t)}</p>
          {r.limitedBy && <p className="lim-sub lim-why">{limitedText(r, t)}</p>}
          <p className="cal-lead">
            {t(`今天的流量 ${fmtRate(r.baseRps)}/s。`, `Today’s traffic: ${fmtRate(r.baseRps)}/s. `)}
            {r.limitScale !== null && r.note !== 'stopped' && t(
              `在上限保持 ${r.holdSeconds} 秒：可用性 ${fmtAvail(r.hold.avail)}，${r.hold.pct} ${fmtLatency(r.hold.lat)}（最差 1 秒 ${fmtLatency(r.hold.latMax)}），最高利用率 ${fmtPct(r.hold.peakUtil)}。`,
              `Held at the limit for ${r.holdSeconds} s: availability ${fmtAvail(r.hold.avail)}, ${r.hold.pct} ${fmtLatency(r.hold.lat)} (worst second ${fmtLatency(r.hold.latMax)}), peak utilization ${fmtPct(r.hold.peakUtil)}.`,
            )}
          </p>
          {r.ranking.length > 0 && (
            <>
              <h4 className="lim-h">{t('上限负载下各组件利用率', 'Utilization at the limit')}</h4>
              <ol className="lim-rank">{r.ranking.map((x) => <li key={x.id}><span>{x.name}</span><b>{fmtPct(x.util)}</b></li>)}</ol>
            </>
          )}
          <h4 className="lim-h">{t('加压过程', 'Steps')}</h4>
          <div className="cap-table-wrap cal-table">
            <table className="cap-table">
              <thead><tr><th>#</th><th className="r">{t('倍数', 'Scale')}</th><th className="r">{t('入口流量', 'Entry rate')}</th><th className="r">{t('最高利用率', 'Peak util.')}</th><th>{t('最忙的组件', 'Busiest')}</th><th>SLO</th><th>{t('结果', 'Result')}</th></tr></thead>
              <tbody>
                {r.steps.map((s, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td><td className="r">{s.scale.toFixed(2)}×</td><td className="r">{fmtRate(s.offered)}/s</td><td className="r">{fmtPct(s.peakUtil)}</td>
                    <td>{s.bottleneck}</td><td>{s.sloOk ? t('守住', 'held') : t('打破', 'broken')}</td>
                    <td className={s.pass ? '' : 'cal-bad'}>{s.pass ? t('通过', 'pass') : s.reason === 'backlog' ? t('积压增长', 'backlog grows') : s.reason === 'slo' ? t('SLO 打破', 'SLO broken') : t('超出', 'over')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="cal-foot">
            <span className="cal-count">{lang === 'en' ? new Date(r.finishedAt).toLocaleString('en-US') : new Date(r.finishedAt).toLocaleString('zh-CN')}</span>
            <button type="button" className="btn" onClick={exportMd}>{t('导出 Markdown', 'Export Markdown')}</button>
            <button type="button" className="btn btn--primary" onClick={onClose}>{t('关闭', 'Close')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
