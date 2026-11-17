import { useMemo, useState } from 'react';
import { EDGE_SPECS, GROUP_LABELS, NODE_SPECS, withDefaults, type FailureKindSpec, type GroupId, type ParamSpec } from '../engine/specs';
import { CAUSE_LABELS } from '../engine/sim';
import type { EdgeCfg, NodeCfg, Params } from '../engine/types';
import { useStore } from './store';
import { Glyph } from './Glyph';
import { ParamField, NumberInput } from './ParamField';
import { TimeChart } from './TimeChart';
import { useSeries } from './theme';
import { useLang, useT } from './i18n';
import { fmtAvail, fmtCount, fmtLatency, fmtPct, fmtRate, windowNode } from './format';
import { cacheShape, cheHitRatio, topKeyShare } from '../engine/cachemodel';
import { levelById, useGame } from './game';
import { isParamLocked } from '../game/levels';
import { TrafficEditor } from './TrafficEditor';

function useLevel() {
  const mode = useGame((g) => g.mode);
  const id = useGame((g) => g.levelId);
  return mode === 'challenge' ? levelById(id) : null;
}

function groupSpecs(specs: ParamSpec[], params: Params) {
  const groups: { id: GroupId; items: ParamSpec[] }[] = [];
  for (const s of specs) {
    if (s.showIf && !s.showIf(params)) continue;
    let g = groups.find((x) => x.id === s.group);
    if (!g) { g = { id: s.group, items: [] }; groups.push(g); }
    g.items.push(s);
  }
  return groups;
}

function Section({ title, children, defaultOpen = true, aside }: { title: string; children: React.ReactNode; defaultOpen?: boolean; aside?: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`ins-sec${open ? ' is-open' : ''}`}>
      <button type="button" className="ins-sec-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
        <span>{title}</span>
        {aside}
      </button>
      {open && <div className="ins-sec-body">{children}</div>}
    </section>
  );
}

const TrashIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
);

export function Inspector() {
  const selection = useStore((s) => s.selection);
  const topology = useStore((s) => s.topology);
  if (selection?.kind === 'node') {
    const n = topology.nodes.find((x) => x.id === selection.id);
    if (n) return <NodeInspector key={n.id} node={n} />;
  }
  if (selection?.kind === 'edge') {
    const e = topology.edges.find((x) => x.id === selection.id);
    if (e) return <EdgeInspector key={e.id} edge={e} />;
  }
  return <Overview />;
}

// ---------------------------------------------------------------- node
function NodeInspector({ node }: { node: NodeCfg }) {
  const t = useT();
  const lang = useLang();
  const series = useSeries();
  const spec = NODE_SPECS[node.type];
  const updateParams = useStore((s) => s.updateNodeParams);
  const updateNode = useStore((s) => s.updateNode);
  const removeNodes = useStore((s) => s.removeNodes);
  const history = useStore((s) => s.history);
  const params = useMemo(() => withDefaults(spec.params, node.params), [spec, node.params]);
  const LEGACY_TRAFFIC = new Set(['rps', 'pattern', 'burstMult', 'burstEvery', 'burstDur', 'diurnalPeriod', 'diurnalTrough']);
  const groups = groupSpecs(spec.params.filter((s) => node.type !== 'client' || !LEGACY_TRAFFIC.has(s.key)), params);
  const live = windowNode(history, node.id, 3);
  const level = useLevel();
  const nodeLocked = !!level?.lockedNodes.includes(node.id);

  const recent = history.slice(-120);
  const x = useMemo(() => recent.map((s) => s.t), [recent]);
  const rateSeries = useMemo(() => {
    if (node.type === 'queue') {
      return [{ key: 'lag', label: t('积压', 'Lag'), color: series[0], values: recent.map((s) => s.nodes[node.id]?.extra.lag ?? null) }];
    }
    return [
      { key: 'ok', label: t('成功', 'OK'), color: series[0], values: recent.map((s) => s.nodes[node.id]?.ok ?? null) },
      { key: 'err', label: t('失败', 'Failed'), color: series[1], values: recent.map((s) => s.nodes[node.id]?.err ?? null) },
    ];
  }, [recent, node.id, node.type, series, t]);
  const latSeries = useMemo(() => [
    { key: 'p50', label: 'p50', color: series[0], values: recent.map((s) => s.nodes[node.id]?.p50 ?? null) },
    { key: 'p99', label: 'p99', color: series[1], values: recent.map((s) => s.nodes[node.id]?.p99 ?? null) },
  ], [recent, node.id, series]);

  return (
    <div className="ins">
      <header className="ins-head">
        <span className="ins-glyph"><Glyph type={node.type} size={22} /></span>
        <div className="ins-head-main">
          <input className="ins-name" aria-label={t('名称', 'Name')} value={node.name} disabled={nodeLocked} onChange={(e) => updateNode(node.id, { name: e.target.value })} />
          <p className="ins-sub">{spec.blurb[lang]}</p>
        </div>
        {!nodeLocked && <button type="button" className="icon-btn" title={t('删除组件', 'Delete component')} aria-label={t('删除组件', 'Delete component')} onClick={() => removeNodes([node.id])}><TrashIcon /></button>}
      </header>
      {nodeLocked && <p className="lock-note">{t('本关不能修改这个组件。', 'This component is locked in this level.')}</p>}

      {live && <LiveRow node={node} live={live} />}
      {node.type === 'cache' && params.hitMode === 'capacity' && <CacheModelBox params={params} live={live} />}
      {history.length > 2 && (
        <div className="ins-charts">
          <TimeChart compact title={node.type === 'queue' ? t('积压', 'Lag') : t('每秒请求', 'Requests/s')} x={x} series={rateSeries} unit={node.type === 'queue' ? '' : '/s'} height={92} />
          <TimeChart compact title={node.type === 'queue' ? t('消息延迟', 'Message latency') : t('延迟', 'Latency')} x={x} series={latSeries} unit="ms" height={92} />
        </div>
      )}

      {node.type === 'client' && (
        <Section title={t('流量模型', 'Traffic model')}>
          <TrafficEditor node={node} locked={nodeLocked} />
        </Section>
      )}

      {groups.map((g) => (
        <Section key={g.id} title={GROUP_LABELS[g.id][lang]} defaultOpen={g.id !== 'gc' && g.id !== 'autoscale' && g.id !== 'usl'}
          aside={g.id === 'autoscale' && params.asEnabled ? <span className="pill pill--on">{t('开', 'On')}</span> : undefined}>
          {g.items.map((s) => (
            <ParamField key={s.key} spec={s} value={params[s.key]} disabled={isParamLocked(level, node.id, node.type, s.key)} onChange={(v) => updateParams(node.id, { [s.key]: v })} />
          ))}
        </Section>
      ))}

      {spec.failures.length > 0 && !level && (
        <Section title={t('故障注入', 'Fault injection')}>
          {spec.failures.map((f) => <FailureRow key={f.kind} node={node} spec={f} />)}
        </Section>
      )}
    </div>
  );
}

function CacheModelBox({ params, live }: { params: Params; live: ReturnType<typeof windowNode> }) {
  const t = useT();
  const sh = cacheShape(params);
  const steady = cheHitRatio(sh.capacity, sh.keys, sh.zipf);
  const top = topKeyShare(sh.keys, sh.zipf);
  const half = cheHitRatio(sh.capacity / 2, sh.keys, sh.zipf);
  const dbl = cheHitRatio(sh.capacity * 2, sh.keys, sh.zipf);
  return (
    <div className="derived">
      <div className="derived-h">{t('按容量推算', 'Derived from capacity')}</div>
      <dl>
        <div><dt>{t('稳态命中率', 'Steady hit ratio')}</dt><dd>{fmtPct(steady, 1)}</dd></div>
        <div><dt>{t('总容量', 'Capacity')}</dt><dd>{fmtCount(sh.capacity)} / {fmtCount(sh.keys)}</dd></div>
        <div><dt>{t('最热 key 占比', 'Hottest key')}</dt><dd>{fmtPct(top, 1)}</dd></div>
        {live?.extra.fill !== undefined && <div><dt>{t('当前装满', 'Filled now')}</dt><dd>{fmtPct(live.extra.fill)}</dd></div>}
      </dl>
      <p>{t(`容量减半命中率约 ${fmtPct(half)}，翻倍约 ${fmtPct(dbl)}。`, `Half the capacity gives about ${fmtPct(half)}; double gives about ${fmtPct(dbl)}.`)}</p>
    </div>
  );
}

function LiveRow({ node, live }: { node: NodeCfg; live: NonNullable<ReturnType<typeof windowNode>> }) {
  const t = useT();
  const lang = useLang();
  const total = live.ok + live.err;
  const errRate = total > 0 ? live.err / total : 0;
  const causes = Object.entries(live.causes).sort((a, b) => b[1] - a[1]).slice(0, 3);
  let cells: [string, string][];
  if (node.type === 'queue') {
    cells = [[t('写入', 'In'), `${fmtRate(live.ok)}/s`], [t('消费', 'Out'), `${fmtRate(live.extra.consumed ?? 0)}/s`], [t('积压', 'Lag'), String(live.extra.lag ?? 0)], [t('死信', 'Dead letters'), `${fmtRate(live.extra.dlq ?? 0)}/s`]];
  } else if (node.type === 'client') {
    cells = [[t('发出', 'Sent'), `${fmtRate(live.arr)}/s`], ['p99', fmtLatency(live.p99)], [t('可用性', 'Availability'), fmtAvail(1 - errRate)], ['p50', fmtLatency(live.p50)]];
  } else {
    cells = [
      [t('到达', 'Arrivals'), `${fmtRate(live.arr)}/s`],
      ['p99', fmtLatency(live.p99)],
      [t('错误率', 'Error rate'), fmtPct(errRate, 1)],
      node.type === 'service' ? ['CPU', fmtPct(live.cpu)] : node.type === 'external' ? [t('配额使用', 'Quota used'), fmtPct(live.util)] : [t('利用率', 'Utilization'), fmtPct(live.util)],
    ];
  }
  const comma = lang === 'en' ? ', ' : '，';
  return (
    <div className="live">
      <dl className="live-grid">
        {cells.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      {causes.length > 0 && (
        <p className="live-causes">
          {t('失败原因：', 'Failures: ')}{causes.map(([c, n]) => `${CAUSE_LABELS[c]?.[lang] ?? c} ${fmtRate(n)}/s`).join(comma)}
        </p>
      )}
      {live.wasted > 0.5 && <p className="live-causes">{t(`每秒 ${fmtRate(live.wasted)} 个请求在调用方超时后才完成，属于白做的工作`, `${fmtRate(live.wasted)} requests/s finish after the caller already timed out: wasted work`)}</p>}
    </div>
  );
}

function FailureRow({ node, spec }: { node: NodeCfg; spec: FailureKindSpec }) {
  const t = useT();
  const lang = useLang();
  const inject = useStore((s) => s.inject);
  const clearFailure = useStore((s) => s.clearFailure);
  const running = useStore((s) => s.running);
  const showToast = useStore((s) => s.showToast);
  const simTime = useStore((s) => s.simTime);
  const failures = useStore((s) => s.failures);
  const active = failures.filter((f) => f.nodeId === node.id && f.kind === spec.kind && (f.end < 0 || f.end > simTime));
  const [vals, setVals] = useState<Record<string, number>>(() => Object.fromEntries(spec.params.map((p) => [p.key, p.default])));
  const [dur, setDur] = useState(spec.defaultDuration);
  const [rec, setRec] = useState(spec.defaultRecovery ?? 0);

  return (
    <div className="fr">
      <div className="fr-head">
        <div>
          <div className="fr-label">{spec.label[lang]}</div>
          <p className="pf-help">{spec.help[lang]}</p>
        </div>
        {active.length > 0 ? (
          <button type="button" className="btn btn--ghost" onClick={() => active.forEach((a) => clearFailure(a.id))}>{t('结束', 'End')}</button>
        ) : (
          <button type="button" className="btn btn--fault" onClick={() => {
            inject({ id: `f-${Date.now()}`, nodeId: node.id, kind: spec.kind, params: vals, duration_s: dur, recovery_s: rec });
            if (!running) showToast(t('已注入。点击运行查看效果', 'Injected. Press Run to see the effect'));
          }}>{t('注入', 'Inject')}</button>
        )}
      </div>
      {active.length > 0 ? (
        <p className="fr-active">
          {active.map((a) => (a.end < 0 ? t('进行中，需手动结束', 'Active until you end it') : t(`还剩 ${Math.max(0, Math.ceil((a.end - simTime) / 1000))}s`, `${Math.max(0, Math.ceil((a.end - simTime) / 1000))}s left`))).join(lang === 'en' ? '; ' : '；')}
        </p>
      ) : (
        <div className="fr-params">
          {spec.params.map((p) => (
            <label key={p.key}><span>{p.label[lang]}</span>
              <NumberInput value={vals[p.key]} min={p.min} max={p.max} step={p.step ?? 1} onCommit={(v) => setVals({ ...vals, [p.key]: v })} />
            </label>
          ))}
          <label><span>{t('持续', 'Duration')}</span><NumberInput value={dur} min={0} max={3600} unit="s" onCommit={setDur} /></label>
          {spec.defaultRecovery !== undefined && <label><span>{t('恢复', 'Recovery')}</span><NumberInput value={rec} min={0} max={3600} unit="s" onCommit={setRec} /></label>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- edge
function EdgeInspector({ edge }: { edge: EdgeCfg }) {
  const t = useT();
  const lang = useLang();
  const topology = useStore((s) => s.topology);
  const update = useStore((s) => s.updateEdgeParams);
  const removeEdges = useStore((s) => s.removeEdges);
  const history = useStore((s) => s.history);
  const from = topology.nodes.find((n) => n.id === edge.from);
  const to = topology.nodes.find((n) => n.id === edge.to);
  const params = useMemo(() => withDefaults(EDGE_SPECS, edge.params), [edge.params]);
  const siblings = topology.edges.filter((x) => x.from === edge.from);
  const showWeight = from?.type === 'client' || from?.type === 'lb' || from?.type === 'gateway' || !!params.choice;
  const groups = groupSpecs(EDGE_SPECS, params).map((g) => ({
    ...g,
    items: g.items.filter((s) => {
      if (s.key === 'match') return from?.type === 'gateway';
      if (s.key === 'weight') return showWeight && (siblings.length > 1 || !!params.choice);
      if (s.key === 'choice') return from?.type === 'service' || from?.type === 'cache';
      return true;
    }),
  })).filter((g) => {
    if (g.items.length === 0) return false;
    if (g.id === 'route') return true;
    if (g.id === 'pool') return (to?.type === 'database' || to?.type === 'cache') && from?.type === 'service';
    return true;
  }).map((g) => ({
    ...g,
    items: g.items.filter((s) => {
      if (from?.type !== 'service' && (s.key === 'order' || s.key === 'probability' || s.key === 'callsPerRequest')) return from?.type === 'cache' && s.key !== 'order';
      if (s.key === 'choice') return from?.type === 'service' || from?.type === 'cache';
      return true;
    }),
  })).filter((g) => g.items.length > 0);

  const w = history.slice(-3).map((s) => s.edges[edge.id]).filter(Boolean);
  const calls = w.reduce((s, x) => s + x.calls, 0) / Math.max(1, w.length);
  const retries = w.reduce((s, x) => s + x.retries, 0) / Math.max(1, w.length);
  const fails = w.reduce((s, x) => s + x.fails, 0) / Math.max(1, w.length);
  const cb = w.length ? w[w.length - 1].cb : 0;
  const poolWait = w.length ? Math.max(...w.map((x) => x.poolWaitP99)) : 0;
  const toStore = to?.type === 'database' || to?.type === 'cache';
  const level = useLevel();
  const edgeLocked = !!(level && from && level.lockedNodes.includes(from.id));

  const role = from?.type === 'client' ? t('用户请求入口。超时和重试即客户端行为。', 'User requests enter here. Timeout and retries are the client’s behavior.')
    : from?.type === 'gateway' ? t('Gateway 路由：路径以前缀开头的请求走这条边。', 'Gateway route: requests whose path starts with the prefix take this edge.')
    : from?.type === 'lb' ? t('LB 到实例的转发。每次重试会重新选择实例。', 'Load balancer to instances. Each retry picks an instance again.')
    : from?.type === 'cache' ? t('缓存未命中时的回源调用。', 'Origin call made on a cache miss.')
    : to?.type === 'external' ? t('调用第三方 API。对方慢了你的线程会一直等，超时最好设在它的 p99 附近；重试会消耗配额，必要时打开熔断和降级。', 'Call to a third-party API. When it slows down your threads wait on it, so set the timeout near its p99; retries spend quota, and a circuit breaker with a fallback limits the damage.')
    : from?.type === 'queue' ? t('消费者组：每条消息交给这个服务处理，失败按重试次数重试后进入死信。', 'Consumer group: each message is processed by this service; after the retries are used up it goes to the dead-letter queue.')
    : t('服务间调用。调用期间是否占用线程，由上游服务的设置决定。', 'Service-to-service call. Whether a thread is held during the call is set on the calling service.');

  return (
    <div className="ins">
      <header className="ins-head">
        <span className="ins-glyph">
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M3 11h14M13 6.5 17.5 11 13 15.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <div className="ins-head-main">
          <div className="ins-title">{from?.name} → {to?.name}</div>
          <p className="ins-sub">{role}</p>
        </div>
        {!edgeLocked && <button type="button" className="icon-btn" title={t('删除连线', 'Delete edge')} aria-label={t('删除连线', 'Delete edge')} onClick={() => removeEdges([edge.id])}><TrashIcon /></button>}
      </header>
      {edgeLocked && <p className="lock-note">{t('本关不能修改这条连线。', 'This edge is locked in this level.')}</p>}
      {w.length > 0 && (
        <div className="live">
          <dl className="live-grid">
            <div><dt>{t('调用', 'Calls')}</dt><dd>{fmtRate(calls)}/s</dd></div>
            <div><dt>{t('重试占比', 'Retries')}</dt><dd>{calls > 0 ? fmtPct(retries / calls) : '0%'}</dd></div>
            <div><dt>{t('失败占比', 'Failures')}</dt><dd>{calls > 0 ? fmtPct(fails / calls, 1) : '0%'}</dd></div>
            <div><dt>{toStore ? t('等连接 p99', 'Pool wait p99') : t('熔断器', 'Breaker')}</dt>
              <dd>{toStore ? fmtLatency(poolWait) : cb === 1 ? t('打开', 'Open') : cb === 2 ? t('半开', 'Half-open') : params.cbEnabled ? t('关闭', 'Closed') : t('未启用', 'Off')}</dd></div>
          </dl>
        </div>
      )}
      {groups.map((g) => (
        <Section key={g.id} title={GROUP_LABELS[g.id][lang]}>
          {g.items.map((s) => <ParamField key={s.key} spec={s} value={params[s.key]} disabled={edgeLocked} onChange={(v) => update(edge.id, { [s.key]: v })} />)}
        </Section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- nothing selected
function Overview() {
  const level = useLevel();
  if (level) return <LevelOverview />;
  return <SandboxOverview />;
}

function LevelOverview() {
  const t = useT();
  const lang = useLang();
  const level = useLevel()!;
  return (
    <div className="ins ins--overview">
      <header className="ins-head">
        <div className="ins-head-main">
          <div className="ins-title">{t(`第 ${level.num} 关：`, `Level ${level.num}: `)}{level.title[lang]}</div>
          <p className="ins-sub">{level.story[lang]}</p>
        </div>
      </header>
      <ol className="howto">
        {level.tips.map((tp, i) => <li key={i}>{tp[lang]}</li>)}
      </ol>
      <p className="lock-hint">{t('带锁图标的组件和参数在本关不能修改；灰掉的组件不能添加。', 'Components and settings with a lock can’t be changed in this level; greyed-out components can’t be added.')}</p>
    </div>
  );
}

function SandboxOverview() {
  const t = useT();
  const lang = useLang();
  const topology = useStore((s) => s.topology);
  const counts = topology.nodes.reduce<Record<string, number>>((m, n) => { m[n.type] = (m[n.type] ?? 0) + 1; return m; }, {});
  const parts = Object.entries(counts).map(([ty, c]) => {
    const label = NODE_SPECS[ty as keyof typeof NODE_SPECS].label;
    return lang === 'en' ? `${c} ${label.en.toLowerCase()}${c > 1 && !/s$/.test(label.en) ? 's' : ''}` : `${c} 个${label.zh}`;
  });
  const edges = lang === 'en' ? `${topology.edges.length} calls` : `${topology.edges.length} 条调用`;
  const cal = topology.calibration;
  return (
    <div className="ins ins--overview">
      <header className="ins-head">
        <div className="ins-head-main">
          <div className="ins-title">{topology.name}</div>
          <p className="ins-sub">{[...parts, edges].join(lang === 'en' ? ', ' : '，')}</p>
          {cal && (
            <p className="ins-sub ins-cal">
              {t(
                `已用 ${cal.source} 校准（${cal.components} 个组件，${cal.appliedAt.slice(0, 10)}）${cal.medianError !== undefined ? `，验证误差中位数 ${(cal.medianError * 100).toFixed(1)}%` : ''}`,
                `Calibrated from ${cal.source} (${cal.components} components, ${cal.appliedAt.slice(0, 10)})${cal.medianError !== undefined ? `, median verification error ${(cal.medianError * 100).toFixed(1)}%` : ''}`,
              )}
            </p>
          )}
        </div>
      </header>
      <ol className="howto">
        <li><b>{t('搭拓扑。', 'Build the topology.')}</b>{t('从左侧把组件拖到画布；从节点右侧的圆点拖到另一个节点，就是一次调用。', ' Drag components from the left onto the canvas. Drag from a node’s right-hand dot to another node to add a call.')}</li>
        <li><b>{t('调参数。', 'Tune parameters.')}</b>{t('点击节点或连线编辑参数。仿真运行时修改立即生效，可以边看边调。', ' Click a node or an edge to edit it. Changes apply instantly while the simulation runs.')}</li>
        <li><b>{t('注入故障。', 'Inject faults.')}</b>{t('选中节点后在“故障注入”里触发，或者直接从顶部选一个预置场景。', ' Use Fault injection on a selected node, or pick a scenario from the top bar.')}</li>
        <li><b>{t('看容量。', 'Check capacity.')}</b>{t('底部“容量分析”给出解析估算的瓶颈、最大吞吐和目标流量所需的资源。', ' The Capacity tab at the bottom estimates the bottleneck, the maximum throughput and what a target load needs.')}</li>
        <li><b>{t('对上生产。', 'Match production.')}</b>{t('右上角导入导出菜单里“用生产指标校准”，导入高峰小时的 QPS、响应时间、CPU 等，自动反推参数。', ' Use “Calibrate from metrics” in the import/export menu (top right) to load peak-hour QPS, response times and CPU; parameters are backsolved for you.')}</li>
      </ol>
      <dl className="keys">
        <div><dt><kbd>{t('空格', 'Space')}</kbd></dt><dd>{t('运行 / 暂停', 'Run / pause')}</dd></div>
        <div><dt><kbd>Delete</kbd></dt><dd>{t('删除选中的组件或连线', 'Delete the selected component or edge')}</dd></div>
        <div><dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>{t('在数字框中微调，按住 Shift 调 10 倍', 'Nudge a number; hold Shift for 10×')}</dd></div>
      </dl>
    </div>
  );
}
