import { useState } from 'react';
import { fmtCost } from '../engine/cost';
import { CAUSE_LABELS } from '../engine/sim';
import { useStore } from './store';
import { useRuns, type RunReport } from './runs';
import { useLang, useT } from './i18n';
import { fmtAvail, fmtClock, fmtCount, fmtLatency, fmtPct, fmtRate } from './format';
import { Glyph } from './Glyph';
import type { NodeType } from '../engine/types';
import { diffConfigs, type ConfigChange } from './configDiff';

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
  // chosen comparison per report id: another report id, or 0 for none
  const [cmpFor, setCmpFor] = useState<Record<number, number>>({});
  const [exportOpen, setExportOpen] = useState(false);
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
  // runs of the same workbench (same topology) can be compared; default is the run just before this one
  const candidates = reports.filter((x) => x.id !== r.id && x.topology === r.topology);
  const defaultCmp = candidates.find((x) => x.id < r.id)?.id ?? 0;
  const cmpId = cmpFor[r.id] ?? defaultCmp;
  const p: RunReport | undefined = candidates.find((x) => x.id === cmpId);
  const changes: ConfigChange[] = p && p.config && r.config ? diffConfigs(p.config, r.config, lang) : [];
  if (p && p.duration !== r.duration) changes.unshift({ where: t('运行', 'Run'), kind: 'changed', what: { zh: '运行时长', en: 'Run length' }, from: fmtClock(p.duration * 1000), to: fmtClock(r.duration * 1000) });
  const changeText = (c: ConfigChange) =>
    c.kind === 'added' ? t('新增', 'added') : c.kind === 'removed' ? t('删除', 'removed') : `${c.what?.[lang] ?? ''}: ${c.from} → ${c.to}`;
  const relT = (abs: number) => fmtClock(Math.max(0, abs - r.t0) * 1000);
  const pct = r.pct ?? 'p99';

  const buildTiles = (r: RunReport, p: RunReport | undefined): Tile[] => {
  const relT = (abs: number) => fmtClock(Math.max(0, abs - r.t0) * 1000);
  const pct = r.pct ?? 'p99';
  const tiles: Tile[] = [
    { k: t('可用性', 'Availability'), v: fmtAvail(r.avail), cur: r.avail * 100, prev: p ? p.avail * 100 : undefined, better: 'up', fmtDelta: (d) => `${d.toFixed(2)}pt`, tone: r.avail < r.slo.avail ? 'crit' : 'ok', note: `SLO ${fmtAvail(r.slo.avail)}` },
    { k: t('平均延迟', 'Avg latency'), v: fmtLatency(r.latAvg ?? 0), cur: r.latAvg ?? 0, prev: p?.latAvg, better: 'down', fmtDelta: fmtLatency, note: t('整次运行所有请求的平均值', 'Mean over every request in the run') },
    { k: t(`${pct} 延迟`, `${pct} latency`), v: fmtLatency(r.pctAll ?? r.p99Avg), cur: r.pctAll ?? r.p99Avg, prev: p ? (p.pctAll ?? p.p99Avg) : undefined, better: 'down', fmtDelta: fmtLatency, tone: (r.pctAll ?? r.p99Avg) > r.slo.p99 ? 'crit' : 'ok', note: t(`整次运行所有请求；最差 1 秒 ${fmtLatency(r.p99Max)}；SLO ${fmtLatency(r.slo.p99)}`, `Over every request in the run; worst second ${fmtLatency(r.p99Max)}; SLO ${fmtLatency(r.slo.p99)}`) },
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
  return tiles;
  };
  const tiles = buildTiles(r, p);

  const nodes = Object.entries(r.nodes).filter(([, n]) => n.type !== 'client').sort((a, b) => b[1].peakUtil - a[1].peakUtil);
  const causes = Object.entries(r.causes).sort((a, b) => b[1] - a[1]);

  const copy = async () => {
    const lines = [
      `# Microwave ${t('报告', 'report')} ${r.name}`,
      '',
      `- ${t('拓扑', 'Topology')}: ${r.topology}`,
      `- ${t('时长', 'Duration')}: ${fmtClock(r.seconds * 1000)}`,
      ...r.traffic.map((tr) => `- ${t('流量', 'Traffic')}: ${tr.name}: ${tr.model}`),
      `- ${t('请求', 'Requests')}: ${fmtCount(r.requests)}, ${t('峰值入口流量', 'peak entry rate')} ${fmtRate(r.offeredPeak)}/s`,
      '',
      ...tiles.map((x) => `- **${x.k}**: ${x.v}${x.note ? ` (${x.note})` : ''}`),
      ...(p ? ['', `## ${t(`配置变化：${p.name} → ${r.name}`, `What changed: ${p.name} → ${r.name}`)}`, '', ...(changes.length ? changes.map((c) => `- ${c.where}: ${changeText(c)}`) : [t('- 两轮配置相同', '- Same configuration')])] : []),
      '',
      `| ${t('组件', 'Component')} | ${t('峰值利用率', 'Peak util.')} | ${t('峰值时刻', 'At')} | ${pct} | ${t('失败', 'Failures')} |`,
      '|---|---|---|---|---|',
      ...nodes.map(([, n]) => `| ${n.name} | ${fmtPct(n.peakUtil)} | ${relT(n.peakT)} | ${fmtLatency(n.pctAll ?? n.p99Max)} | ${fmtCount(n.err)} |`),
    ];
    try { await navigator.clipboard.writeText(lines.join('\n')); showToast(t('报告已复制为 Markdown', 'Report copied as Markdown')); }
    catch { showToast(t('浏览器不允许写剪贴板', 'The browser blocked clipboard access'), 'warn'); }
  };

  // ---- export: this run alone (Markdown or raw JSON), or this run against the compared one (Markdown)
  const framed = (() => { try { return window.self !== window.top; } catch { return true; } })();
  const slug = r.topology.replace(/[\s/\\]+/g, '-');
  const save = async (text: string, name: string, type: string) => {
    setExportOpen(false);
    if (!framed) {
      const url = URL.createObjectURL(new Blob([text], { type }));
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(t(`已导出 ${name}`, `Exported ${name}`));
      return;
    }
    // inside an embedded page downloads are blocked: fall back to the clipboard
    try { await navigator.clipboard.writeText(text); showToast(t('这里不能下载文件，已复制到剪贴板', 'Downloads are blocked here; copied to the clipboard instead')); }
    catch { showToast(t('浏览器不允许下载或写剪贴板', 'The browser blocked both download and clipboard'), 'warn'); }
  };
  const nodeList = (x: RunReport) => Object.entries(x.nodes).filter(([, n]) => n.type !== 'client').sort((a, b) => b[1].peakUtil - a[1].peakUtil);
  const runMeta = (x: RunReport) => [
    `- ${t('拓扑', 'Topology')}: ${x.topology}`,
    `- ${t('时长', 'Duration')}: ${fmtClock(x.seconds * 1000)}`,
    ...x.traffic.map((tr) => `- ${t('流量', 'Traffic')}: ${tr.name}: ${tr.model}`),
    `- ${t('请求', 'Requests')}: ${fmtCount(x.requests)}, ${t('峰值入口流量', 'peak entry rate')} ${fmtRate(x.offeredPeak)}/s`,
    ...(x.editedMidRun ? [`- ${t('注意：运行中改过参数', 'Note: parameters were edited during this run')}`] : []),
  ];
  const mdSingle = () => {
    const xt = buildTiles(r, undefined);
    const rel = (abs: number) => fmtClock(Math.max(0, abs - r.t0) * 1000);
    return [
      `# Microwave ${t('报告', 'report')} ${r.name}`, '', ...runMeta(r), '',
      `## ${t('结果', 'Results')}`, '',
      ...xt.map((x) => `- **${x.k}**: ${x.v}${x.note ? ` (${x.note})` : ''}`), '',
      `## ${t('组件', 'Components')}`, '',
      `| ${t('组件', 'Component')} | ${t('峰值利用率', 'Peak util.')} | ${t('峰值时刻', 'At')} | ${pct} | ${t('失败', 'Failures')} | ${t('峰值到达', 'Peak arrivals')} |`,
      '|---|---|---|---|---|---|',
      ...nodeList(r).map(([, n]) => `| ${n.name} | ${fmtPct(n.peakUtil)} | ${rel(n.peakT)} | ${fmtLatency(n.pctAll ?? n.p99Max)} | ${fmtCount(n.err)} | ${fmtRate(n.arrMax)}/s |`), '',
      `## ${t('失败原因', 'Failure causes')}`, '',
      ...(causes.length ? causes.map(([c, n]) => `- ${CAUSE_LABELS[c]?.[lang] ?? c}: ${fmtCount(n)}`) : [`- ${t('没有失败的请求', 'No failed requests')}`]),
      '',
    ].join('\n');
  };
  const mdCompare = () => {
    if (!p) return '';
    const a = buildTiles(p, undefined), b = buildTiles(r, p);
    const change = (x: Tile) => {
      if (x.cur === undefined || x.prev === undefined || !x.better || !x.fmtDelta) return '—';
      const d = x.cur - x.prev;
      if (!isFinite(d) || Math.abs(d) < 1e-9) return t('不变', 'same');
      const good = x.better === 'up' ? d > 0 : d < 0;
      return `${d > 0 ? '▲' : '▼'} ${x.fmtDelta(Math.abs(d))} (${good ? t('更好', 'better') : t('更差', 'worse')})`;
    };
    const pn = new Map(nodeList(p));
    return [
      `# Microwave ${t('对比报告', 'comparison')}: ${p.name} → ${r.name}`, '',
      `### ${p.name}`, ...runMeta(p), '', `### ${r.name}`, ...runMeta(r), '',
      `## ${t('配置变化', 'What changed')}`, '',
      ...(changes.length ? changes.map((c) => `- ${c.where}: ${changeText(c)}`) : [`- ${t('两轮配置相同，结果差异来自随机波动', 'Same configuration; differences come from random variation')}`]), '',
      `## ${t('结果', 'Results')}`, '',
      `| ${t('指标', 'Metric')} | ${p.name} | ${r.name} | ${t('变化', 'Change')} |`, '|---|---|---|---|',
      ...b.map((x, i) => `| ${x.k} | ${a.find((y) => y.k === x.k)?.v ?? a[i]?.v ?? '—'} | ${x.v} | ${change(x)} |`), '',
      `## ${t('组件', 'Components')}`, '',
      `| ${t('组件', 'Component')} | ${t('峰值利用率', 'Peak util.')} ${p.name} | ${r.name} | ${pct} ${p.name} | ${r.name} | ${t('失败', 'Failures')} ${p.name} | ${r.name} |`,
      '|---|---|---|---|---|---|---|',
      ...nodeList(r).map(([id, n]) => {
        const o = pn.get(id);
        return `| ${n.name} | ${o ? fmtPct(o.peakUtil) : '—'} | ${fmtPct(n.peakUtil)} | ${o ? fmtLatency(o.pctAll ?? o.p99Max) : '—'} | ${fmtLatency(n.pctAll ?? n.p99Max)} | ${o ? fmtCount(o.err) : '—'} | ${fmtCount(n.err)} |`;
      }),
      '',
    ].join('\n');
  };
  const rawJson = () => JSON.stringify({ format: 'simbench-run-report', version: 1, exportedAt: new Date().toISOString(), report: r }, null, 2);

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
        {candidates.length > 0 ? (
          <label className="rp-cmp">
            <span>{t('对比', 'Compare with')}</span>
            <select value={p ? p.id : 0} onChange={(e) => setCmpFor({ ...cmpFor, [r.id]: Number(e.target.value) })}>
              {candidates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              <option value={0}>{t('不对比', 'None')}</option>
            </select>
          </label>
        ) : <span className="rp-cmp rp-cmp--none">{t('同一拓扑还没有其他轮次可对比', 'No other run of this topology to compare')}</span>}
        <span className="rp-actions">
          <button type="button" className="btn btn--ghost" onClick={copy}>{t('复制报告', 'Copy report')}</button>
          <div className="menu" onBlur={(e) => { if (exportOpen && !e.currentTarget.contains(e.relatedTarget as Node)) setExportOpen(false); }}>
            <button type="button" className="btn btn--ghost" aria-expanded={exportOpen} aria-haspopup="menu" onClick={() => setExportOpen(!exportOpen)}>
              {t('导出', 'Export')} <span aria-hidden="true">▾</span>
            </button>
            {exportOpen && (
              <div className="menu-pop menu-pop--end" role="menu">
                <button type="button" role="menuitem" className="menu-item" onClick={() => save(mdSingle(), `${slug}-${r.name.replace('#', 'run')}.md`, 'text/markdown')}>
                  {t(`本次报告 ${r.name}（Markdown）`, `This run ${r.name} (Markdown)`)}
                </button>
                <button type="button" role="menuitem" className="menu-item" onClick={() => save(rawJson(), `${slug}-${r.name.replace('#', 'run')}.json`, 'application/json')}>
                  {t(`本次原始数据 ${r.name}（JSON）`, `This run ${r.name}, raw data (JSON)`)}
                </button>
                <button type="button" role="menuitem" className="menu-item" disabled={!p} onClick={() => save(mdCompare(), `${slug}-${p?.name.replace('#', 'run')}-vs-${r.name.replace('#', 'run')}.md`, 'text/markdown')}>
                  {p ? t(`对比报告 ${p.name} → ${r.name}（Markdown）`, `Comparison ${p.name} → ${r.name} (Markdown)`) : t('对比报告（先选择要对比的轮次）', 'Comparison (choose a run to compare first)')}
                </button>
              </div>
            )}
          </div>
          <button type="button" className="btn btn--primary" onClick={() => { reset(); setTimeout(run, 60); }}>{t('再跑一次', 'Run again')}</button>
        </span>
      </div>
      <div className="rp-body">
        {p && (
          <section className="rp-diff" aria-label={t('两轮之间的配置变化', 'Configuration changes between the two runs')}>
            <h4>{t(`配置变化：${p.name} → ${r.name}`, `What changed: ${p.name} → ${r.name}`)}</h4>
            {changes.length === 0 ? (
              <p className="rp-none">{t('两轮的配置完全相同，结果差异来自随机波动。', 'Both runs used the same configuration; differences come from random variation.')}</p>
            ) : (
              <ul>
                {changes.map((c, i) => (
                  <li key={i} className={`rp-diff-${c.kind}`}>
                    <b>{c.where}</b>
                    {c.kind === 'changed' ? <><span className="rp-diff-what">{c.what?.[lang]}</span><span className="rp-diff-from">{c.from}</span><span aria-hidden="true">→</span><span className="rp-diff-to">{c.to}</span></> : <span className="rp-diff-tag">{changeText(c)}</span>}
                  </li>
                ))}
              </ul>
            )}
            {(r.editedMidRun || p.editedMidRun) && (
              <p className="rp-diff-note">{t(
                `${[r, p].filter((x) => x.editedMidRun).map((x) => x.name).join('、')} 在运行中改过参数；这里按开始时的配置比较，结果是改动前后混合的。`,
                `${[r, p].filter((x) => x.editedMidRun).map((x) => x.name).join(', ')} had parameters edited mid-run; this compares the starting configurations, and the results mix before and after the edit.`,
              )}</p>
            )}
          </section>
        )}
        {!p && r.editedMidRun && (
          <p className="rp-mid-note" role="note">{t(
            '注意：运行中改过参数。这份结果是改动前后几种配置混在一起的；要比较配置，每次运行只改一处。',
            'Note: parameters were edited during this run. These results mix the setups before and after the edit; to compare setups, change one thing per run.',
          )}</p>
        )}
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
                <th scope="col" className="r" title={t('整次运行所有经过该组件的请求', 'Over every request through the component in the run')}>{pct}</th>
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
                    <td className="r" title={t(`最差 1 秒 ${fmtLatency(n.p99Max)}`, `Worst second ${fmtLatency(n.p99Max)}`)}>{fmtLatency(n.pctAll ?? n.p99Max)}</td>
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
