import { useMemo, useState } from 'react';
import { analyze } from '../engine/analysis';
import { CAUSE_LABELS } from '../engine/sim';
import type { Topology } from '../engine/types';
import { useStore, type DockTab } from './store';
import { TimeChart } from './TimeChart';
import { useChrome, useSeries } from './theme';
import { useLang, useT } from './i18n';
import { fmtClock, fmtLatency, fmtPct, fmtRate, sloPct } from './format';
import { NumberInput } from './ParamField';
import { Glyph } from './Glyph';
import { ReportPanel } from './Report';
import { useRuns } from './runs';
import { LimitPanel } from './LimitPanel';

export function Dock() {
  const t = useT();
  const tab = useStore((s) => s.dockTab);
  const open = useStore((s) => s.dockOpen);
  const setDock = useStore((s) => s.setDock);
  const unseen = useStore((s) => s.unseenEvents);
  const tabs: { id: DockTab; label: string }[] = [
    { id: 'charts', label: t('系统指标', 'Metrics') },
    { id: 'capacity', label: t('容量分析', 'Capacity') },
    { id: 'events', label: t('事件', 'Events') },
    { id: 'report', label: t('报告', 'Report') },
  ];
  const reportCount = useRuns((r) => r.reports.length);
  return (
    <section className={`dock${open ? '' : ' is-collapsed'}`} aria-label={t('分析面板', 'Analysis panel')}>
      <div className="dock-tabs" role="tablist">
        {tabs.map((tb) => (
          <button key={tb.id} type="button" role="tab" data-learn={`dock-${tb.id}`} aria-selected={open && tab === tb.id} className={open && tab === tb.id ? 'is-on' : ''} onClick={() => setDock(tb.id)}>
            {tb.label}
            {tb.id === 'events' && unseen > 0 && <span className="badge">{unseen > 99 ? '99+' : unseen}</span>}
            {tb.id === 'report' && reportCount > 0 && <span className="badge badge--neutral">{reportCount}</span>}
          </button>
        ))}
        <button type="button" className="dock-toggle" aria-label={open ? t('收起面板', 'Collapse panel') : t('展开面板', 'Expand panel')} onClick={() => setDock(null)}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ transform: open ? 'none' : 'rotate(180deg)' }}><path d="M3 5l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
      </div>
      {open && (
        <div className="dock-body">
          {tab === 'charts' && <SystemCharts />}
          {tab === 'capacity' && <Capacity />}
          {tab === 'events' && <Events />}
          {tab === 'report' && <ReportPanel />}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- charts
function SystemCharts() {
  const t = useT();
  const lang = useLang();
  const series = useSeries();
  const chrome = useChrome();
  const chartH = typeof window !== 'undefined' && window.innerHeight <= 860 ? 96 : 128;
  const history = useStore((s) => s.history);
  const topology = useStore((s) => s.topology);
  const recent = useMemo(() => history.slice(-300), [history]);
  const x = useMemo(() => recent.map((s) => s.t), [recent]);
  const client = topology.nodes.find((n) => n.type === 'client');
  const sloP99 = Number(client?.params.sloP99 ?? 500);
  const pct = sloPct(topology);

  const lat = useMemo(() => [
    { key: 'p50', label: 'p50', color: series[0], values: recent.map((s) => s.sys.p50 || null) },
    { key: 'avg', label: t('平均', 'avg'), color: series[2], values: recent.map((s) => s.sys.mean || null) },
    { key: pct, label: pct, color: series[1], values: recent.map((s) => s.sys[pct] || null) },
    { key: 'slo', label: 'SLO', color: chrome.neutral, dash: [4, 4], width: 1.5, values: recent.map(() => sloP99) },
  ], [recent, sloP99, pct, series, chrome, t]);

  const reqs = useMemo(() => [
    { key: 'ok', label: t('成功', 'OK'), color: series[0], values: recent.map((s) => s.sys.ok) },
    { key: 'fail', label: t('失败', 'Failed'), color: series[1], values: recent.map((s) => s.sys.fail) },
    { key: 'offered', label: t('发出（不含重试）', 'Sent (no retries)'), color: chrome.neutral, dash: [4, 4], width: 1.5, values: recent.map((s) => s.sys.offered) },
  ], [recent, series, chrome, t]);

  // Utilisation: series identity follows topology order; show the 6 busiest
  const utilNodes = useMemo(() => {
    const cands = topology.nodes.filter((n) => n.type === 'service' || n.type === 'gateway' || n.type === 'cache' || n.type === 'database');
    const peak = (id: string) => Math.max(0, ...recent.slice(-60).map((s) => { const v = s.nodes[id]; return v ? Math.max(v.util, v.cpu) : 0; }));
    const top = new Set(cands.slice().sort((a, b) => peak(b.id) - peak(a.id)).slice(0, 6).map((n) => n.id));
    return cands.filter((n) => top.has(n.id));
  }, [topology.nodes, recent]);
  const util = useMemo(() => utilNodes.map((n, i) => ({
    key: n.id, label: n.name, color: series[i % series.length],
    values: recent.map((s) => { const v = s.nodes[n.id]; return v ? Math.max(v.util, v.cpu) * 100 : null; }),
  })), [utilNodes, recent, series]);

  const causeKeys = useMemo(() => {
    const tot: Record<string, number> = {};
    for (const s of recent) for (const [k, v] of Object.entries(s.sys.causes)) tot[k] = (tot[k] ?? 0) + v;
    return Object.entries(tot).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k).sort();
  }, [recent]);
  const causes = useMemo(() => causeKeys.map((k, i) => ({
    key: k, label: CAUSE_LABELS[k]?.[lang] ?? k, color: series[i % series.length], values: recent.map((s) => s.sys.causes[k] ?? 0),
  })), [causeKeys, recent, series, lang]);

  const amp = useMemo(() => [
    { key: 'amp', label: t('重试放大', 'Retry amplification'), color: series[0], values: recent.map((s) => s.sys.amplification) },
  ], [recent, series, t]);

  return (
    <div className="charts">
      <TimeChart title={t('端到端延迟（每秒）', 'End-to-end latency (per second)')} x={x} series={lat} unit="ms" height={chartH} />
      <TimeChart title={t('用户请求结果', 'User request outcomes')} x={x} series={reqs} unit="/s" height={chartH} />
      <TimeChart title={t('资源利用率（取线程、CPU 中较高者）', 'Utilization (higher of threads and CPU)')} x={x} series={util} unit="%" yMin={0} yMax={100} height={chartH} />
      {causes.length > 0
        ? <TimeChart title={t('用户请求失败原因', 'Why user requests fail')} x={x} series={causes} unit="/s" height={chartH} />
        : <TimeChart title={t('重试放大系数（所有调用尝试 ÷ 首次调用）', 'Retry amplification (all attempts ÷ first attempts)')} x={x} series={amp} unit="x" yMin={1} height={chartH} />}
    </div>
  );
}

// ---------------------------------------------------------------- capacity
function Capacity() {
  const t = useT();
  const lang = useLang();
  const topology = useStore((s) => s.topology);
  const setTopology = useStore((s) => s.setTopology);
  const latest = useStore((s) => s.latest);
  const showToast = useStore((s) => s.showToast);
  const select = useStore((s) => s.select);
  const simTime = useStore((s) => s.simTime);
  const tNow = Math.floor(simTime / 1000);
  const base = useMemo(() => analyze(topology, undefined, 0.7, tNow), [topology, tNow]);
  const [target, setTarget] = useState<number | null>(null);
  const [targetUtil, setTargetUtil] = useState(0.7);
  const tRps = target ?? Math.round(base.totalRps * 2);
  const plan = useMemo(() => analyze(topology, tRps, targetUtil, tNow), [topology, tRps, targetUtil, tNow]);
  const rows = base.nodes.filter((n) => n.type !== 'client' && n.type !== 'lb').sort((a, b) => b.util - a.util);
  const planById = new Map(plan.nodes.map((n) => [n.id, n]));

  const changes = rows.flatMap((r) => {
    const p = planById.get(r.id)?.plan?.[0];
    if (!p || p.needed === p.current) return [];
    return [{ id: r.id, key: p.param, to: p.needed }];
  });

  const apply = () => {
    const tp: Topology = {
      ...topology,
      nodes: topology.nodes.map((n) => {
        const c = changes.filter((x) => x.id === n.id);
        if (!c.length) return n;
        return { ...n, params: { ...n.params, ...Object.fromEntries(c.map((x) => [x.key, x.to])) } };
      }),
    };
    const client = tp.nodes.find((n) => n.type === 'client');
    if (client && base.totalRps > 0) client.params = { ...client.params, rps: tRps };
    setTopology(tp);
    showToast(t(`已应用：${changes.length} 处容量调整，入口流量设为 ${fmtRate(tRps)}/s。运行仿真验证结果`, `Applied ${changes.length} capacity change${changes.length === 1 ? '' : 's'} and set traffic to ${fmtRate(tRps)}/s. Run the simulation to verify`));
  };

  const b = base.bottleneck;
  const maxR = isFinite(base.maxRps) ? `${fmtRate(base.maxRps)}/s` : '—';
  return (
    <div className="cap">
      <div className="cap-summary">
        {b ? (
          lang === 'en' ? (
            <p className="cap-lead">
              With the current setup, <button type="button" className="link" onClick={() => select({ kind: 'node', id: b.id })}>{b.name}</button> is
              the first bottleneck: its {b.utilKind.en} reaches 100% at <strong>{maxR}</strong> of incoming traffic.
              At today’s {fmtRate(base.totalRps)}/s it runs at {fmtPct(b.util)}, and estimated mean end-to-end latency is {fmtLatency(base.e2eLatency)}.
            </p>
          ) : (
            <p className="cap-lead">
              按当前配置，入口流量到 <strong>{maxR}</strong> 时，
              <button type="button" className="link" onClick={() => select({ kind: 'node', id: b.id })}>{b.name}</button>
              的{b.utilKind.zh}达到 100%，是第一个瓶颈。当前 {fmtRate(base.totalRps)}/s 下它的利用率为 {fmtPct(b.util)}，估算端到端平均延迟 {fmtLatency(base.e2eLatency)}。
            </p>
          )
        ) : <p className="cap-lead">{t('添加流量源和服务后，这里会给出解析估算。', 'Add a traffic source and services to see estimates here.')}</p>}
        <div className="cap-planner">
          <label><span>{t('目标流量', 'Target traffic')}</span><NumberInput value={tRps} min={1} max={1_000_000} step={50} unit="/s" onCommit={(v) => setTarget(Math.round(v))} /></label>
          <label><span>{t('目标利用率', 'Target utilization')}</span><NumberInput value={targetUtil} min={0.1} max={0.95} step={0.05} scale={100} unit="%" onCommit={setTargetUtil} /></label>
          <button type="button" className="btn btn--primary" disabled={changes.length === 0} onClick={apply}>{t('应用规划', 'Apply plan')}</button>
        </div>
        <LimitPanel />
      </div>
      <div className="cap-table-wrap">
        <table className="cap-table">
          <thead>
            <tr>
              <th scope="col">{t('组件', 'Component')}</th>
              <th scope="col" className="r">{t('到达率', 'Arrivals')}</th>
              <th scope="col">{t('估算利用率', 'Est. utilization')}</th>
              <th scope="col" className="r">{t('实测', 'Measured')}</th>
              <th scope="col" className="r">{t('估算延迟', 'Est. latency')}</th>
              <th scope="col">{t(`目标 ${fmtRate(tRps)}/s 需要`, `Needed at ${fmtRate(tRps)}/s`)}</th>
              <th scope="col">{t('提示', 'Notes')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const live = latest?.nodes[r.id];
              const liveUtil = live ? Math.max(live.util, live.cpu) : null;
              const p = planById.get(r.id)?.plan?.[0];
              const pct = Math.min(1, r.util);
              const tone = r.util >= 0.9 ? 'crit' : r.util >= 0.7 ? 'warn' : 'ok';
              const note = planById.get(r.id)?.note ?? r.note;
              return (
                <tr key={r.id} onClick={() => select({ kind: 'node', id: r.id })}>
                  <th scope="row"><span className="cap-node"><Glyph type={r.type} size={16} />{r.name}</span></th>
                  <td className="r">{fmtRate(r.lambda)}/s</td>
                  <td>
                    <span className="cap-bar"><span className={`cap-bar-fill cap-bar-fill--${tone}`} style={{ width: `${pct * 100}%` }} /></span>
                    <span className="cap-util">{fmtPct(r.util)} <small>{r.utilKind[lang]}</small></span>
                  </td>
                  <td className="r">{liveUtil !== null && r.type !== 'queue' ? fmtPct(liveUtil) : '—'}</td>
                  <td className="r">{fmtLatency(r.latency)}</td>
                  <td>{p ? <>{p.label[lang]} {p.current}{p.needed !== p.current ? <b className={p.needed > p.current ? 'up' : 'down'}> → {p.needed}</b> : t('，够用', ', enough')}</> : '—'}</td>
                  <td className="cap-note">{note?.[lang] ?? ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="cap-foot">
          {t(
            '解析模型：强制流定律推出各组件到达率，M/G/c（Erlang C + Allen-Cunneen）估算排队，数据库叠加 USL。不含重试与故障，结果是稳态参考，用仿真验证动态行为。',
            'Analytical model: the forced flow law gives each component’s arrival rate, M/G/c (Erlang C + Allen-Cunneen) estimates queueing, and USL is applied to the database. Retries and faults are excluded, so treat this as a steady-state reference and use the simulation for dynamics.',
          )}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- events
function Events() {
  const t = useT();
  const lang = useLang();
  const events = useStore((s) => s.events);
  const select = useStore((s) => s.select);
  const list = events.slice().reverse();
  if (list.length === 0) return <p className="empty-note">{t('熔断、扩缩容、故障注入、连接数超限，以及运行中你改的配置，都会出现在这里。', 'Circuit breakers, autoscaling, injected faults, connection-limit hits and your own edits during a run show up here.')}</p>;
  const levelLabel = (l: string) => (l === 'change' ? t('变更', 'Change') : l === 'crit' ? t('严重', 'Critical') : l === 'warn' ? t('注意', 'Warning') : t('信息', 'Info'));
  return (
    <ol className="events">
      {list.map((e, i) => (
        <li key={`${e.t}-${i}`} className={`ev ev--${e.level}`}>
          <time>{fmtClock(e.t * 1000)}</time>
          <span className="ev-dot" aria-hidden="true" />
          <span className="ev-level">{levelLabel(e.level)}</span>
          {e.nodeId ? <button type="button" className="ev-text link" onClick={() => select({ kind: 'node', id: e.nodeId! })}>{e.text[lang]}</button>
            : e.edgeId ? <button type="button" className="ev-text link" onClick={() => select({ kind: 'edge', id: e.edgeId! })}>{e.text[lang]}</button>
            : <span className="ev-text">{e.text[lang]}</span>}
        </li>
      ))}
    </ol>
  );
}
