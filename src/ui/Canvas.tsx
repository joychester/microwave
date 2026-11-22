import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { play } from './sound';
import {
  Background, BackgroundVariant, BaseEdge, Controls, EdgeLabelRenderer, Handle, Position, ReactFlow,
  getBezierPath, useNodesState, useReactFlow,
  type Connection, type Edge, type EdgeProps, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { NODE_SPECS } from '../engine/specs';
import { newEdge, newNode } from '../engine/presets';
import type { EdgeCfg, Lang, NodeCfg, NodeType } from '../engine/types';
import { useStore } from './store';
import { Glyph } from './Glyph';
import { NodeShape } from './NodeShape';
import { CardDelete, CardName, CardQuick } from './CardEdit';
import { CardProbe } from './CardProbe';
import { levelById, useGame } from './game';
import { useLearn } from './learn';
import { describeProgram, evalProgram, isProgram } from '../engine/traffic';
import { useLang, useT, type T } from './i18n';
import { fmtAvail, fmtCount, fmtLatency, fmtPct, fmtRate, nodeHealth, sloPct, utilLabel, windowNode, windowSys } from './format';

type SimNodeT = Node<{ cfg: NodeCfg }, 'sim'>;
type FlowEdgeT = Edge<{ cfg: EdgeCfg; fromType: NodeType; share?: number }, 'flow'>;

// ---------------------------------------------------------------- node
const SimNode = memo(function SimNode({ id, data, selected }: NodeProps<SimNodeT>) {
  const t = useT();
  const lang = useLang();
  const cfg = data.cfg;
  const spec = NODE_SPECS[cfg.type];
  const s = useStore((st) => st.latest?.nodes[id] ?? null);
  const prevLag = useStore((st) => (st.history.length > 5 ? st.history[st.history.length - 6].nodes[id]?.extra.lag : undefined));
  const isBottleneck = useStore((st) => st.bottleneckId === id);
  const faulted = useStore((st) => st.failures.some((f) => f.nodeId === id && (f.end < 0 || f.end > st.simTime)));
  // the numbers on the card are over the last 5 s, like the top bar and the inspector
  const history = useStore((st) => st.history);
  const win = useMemo(() => windowNode(history, id, 5), [history, id]);
  const sysAvail = useMemo(() => (cfg.type === 'client' ? windowSys(history, 5)?.avail ?? null : null), [history, cfg.type]);
  const health = nodeHealth(cfg.type, s, prevLag);
  const total = win ? win.ok + win.err : 0;
  const errRate = total > 0 ? win!.err / total : 0;
  const ul = s ? utilLabel(cfg.type, s, lang) : null;
  const comma = lang === 'en' ? ', ' : '，';
  const running = useStore((st) => st.running);

  // ---- game-feel effects: floating numbers, crash burst, recovery ring
  const [floaters, setFloaters] = useState<{ id: number; text: string; kind: 'dmg' | 'heal' }[]>([]);
  const [boom, setBoom] = useState(0);
  const [healRing, setHealRing] = useState(0);
  const prev = useRef<{ inst: number; down: number; health: string } | null>(null);
  useEffect(() => {
    if (!s) { prev.current = null; return; }
    const inst = s.instances + (s.extra.starting ?? 0);
    const down = s.extra.down ?? 0;
    const p = prev.current;
    const add: { id: number; text: string; kind: 'dmg' | 'heal' }[] = [];
    const now = Date.now() + Math.random();
    if (running && s.err >= 3 && cfg.type !== 'client') add.push({ id: now, text: `−${fmtRate(s.err)}`, kind: 'dmg' });
    if (p && (cfg.type === 'service' || cfg.type === 'gateway')) {
      if (inst > p.inst) add.push({ id: now + 1, text: t(`+${inst - p.inst} 实例`, `+${inst - p.inst} inst.`), kind: 'heal' });
      if (down > p.down) { setBoom(now); play('crash'); }
    }
    if (p && p.health === 'crit' && (health === 'ok' || health === 'warn')) setHealRing(now);
    prev.current = { inst, down, health };
    if (add.length) {
      setFloaters((f) => [...f, ...add].slice(-4));
      setTimeout(() => setFloaters((f) => f.filter((x) => !add.some((a) => a.id === x.id))), 1500);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s]);
  const hp = cfg.type === 'client' ? sysAvail : s && s.ok + s.err > 0 ? s.ok / (s.ok + s.err) : null;

  const pct = useStore((st) => sloPct(st.topology));
  // Instance count edited while paused: the last live sample still has the old count until the
  // simulation runs again, so show the configured count (not with autoscaling, where the live
  // count legitimately differs from the configured one).
  const cfgInst = Number(cfg.params.instances);
  const liveTotal = s ? s.instances + (s.extra.starting ?? 0) + (s.extra.down ?? 0) : null;
  const pendingInst = (cfg.type === 'service' || cfg.type === 'gateway') && !!s && !running && !cfg.params.asEnabled && liveTotal !== cfgInst;
  let instances = '';
  if (cfg.type === 'service' || cfg.type === 'gateway') {
    const n = pendingInst ? cfgInst : s?.instances ?? cfgInst;
    instances = t(`${n} 实例`, `${n} instance${n === 1 ? '' : 's'}`);
  } else if (cfg.type === 'cache') instances = t(`${cfg.params.shards} 分片`, `${cfg.params.shards} shards`);
  else if (cfg.type === 'database') instances = Number(cfg.params.replicas) > 0 ? t(`主库 + ${cfg.params.replicas} 副本`, `primary + ${cfg.params.replicas} replicas`) : t('单主库', 'single primary');
  else if (cfg.type === 'queue') instances = t(`${cfg.params.partitions} 分区`, `${cfg.params.partitions} partitions`);
  else if (cfg.type === 'external') instances = Number(cfg.params.quotaRps) > 0 ? t(`配额 ${fmtRate(Number(cfg.params.quotaRps))}/s`, `quota ${fmtRate(Number(cfg.params.quotaRps))}/s`) : t('不限配额', 'no quota');

  const stats: { k: string; v: string; tone?: 'crit' | 'warn' }[] = [];
  if (cfg.type === 'client') {
    const planned = isProgram(cfg.params.traffic) ? evalProgram(cfg.params.traffic, 0) : Number(cfg.params.rps);
    stats.push({ k: t('发出', 'Sent'), v: win ? `${fmtRate(win.arr)}/s` : `${fmtRate(planned)}/s` });
    stats.push({ k: pct, v: win ? fmtLatency(win[pct] ?? win.p99) : '—', tone: win && (win[pct] ?? win.p99) > Number(cfg.params.sloP99) ? 'crit' : undefined });
    stats.push({ k: t('可用性', 'Avail.'), v: sysAvail !== null ? fmtAvail(sysAvail) : '—', tone: sysAvail !== null && sysAvail < Number(cfg.params.sloAvail) ? 'crit' : undefined });
  } else if (cfg.type === 'queue') {
    stats.push({ k: t('写入', 'In'), v: s ? `${fmtRate(s.ok)}/s` : '—' });
    stats.push({ k: t('消费', 'Out'), v: s ? `${fmtRate(s.extra.consumed ?? 0)}/s` : '—' });
    stats.push({ k: t('积压', 'Lag'), v: s ? fmtCount(s.extra.lag ?? 0) : '—', tone: health === 'crit' ? 'crit' : health === 'warn' ? 'warn' : undefined });
  } else {
    stats.push({ k: t('流量', 'Traffic'), v: win ? `${fmtRate(win.arr)}/s` : '—' });
    stats.push({ k: pct, v: win ? fmtLatency(win[pct] ?? win.p99) : '—' });
    stats.push({ k: t('错误', 'Errors'), v: s ? (total > 0 ? fmtPct(errRate, errRate < 0.1 && errRate > 0 ? 1 : 0) : '0%') : '—', tone: errRate > 0.05 ? 'crit' : errRate > 0.005 ? 'warn' : undefined });
  }

  let foot = '';
  if (cfg.type === 'client' && isProgram(cfg.params.traffic)) foot = describeProgram(cfg.params.traffic, lang);
  if (s) {
    if (cfg.type === 'cache' && isFinite(s.extra.hitRatio)) foot = t(`命中率 ${fmtPct(s.extra.hitRatio)}`, `${fmtPct(s.extra.hitRatio)} hit ratio`) + (s.extra.fill !== undefined ? t(`，已装满 ${fmtPct(s.extra.fill)}`, `, ${fmtPct(s.extra.fill)} full`) : '');
    if (cfg.type === 'database') foot = t(`连接 ${s.extra.conns} / ${s.extra.maxConns}`, `${s.extra.conns} / ${s.extra.maxConns} connections`);
    if (cfg.type === 'external') {
      const q = s.causes.quota_exceeded ?? 0;
      foot = q > 0 ? t(`${fmtRate(q)}/s 被限流（429）`, `${fmtRate(q)}/s throttled (429)`) : t(`配额用了 ${fmtPct(s.util)}`, `${fmtPct(s.util)} of quota used`);
    }
    if ((cfg.type === 'service' || cfg.type === 'gateway') && (s.extra.starting || s.extra.down)) {
      foot = [s.extra.starting ? t(`${s.extra.starting} 个启动中`, `${s.extra.starting} starting`) : '', s.extra.down ? t(`${s.extra.down} 个宕机`, `${s.extra.down} down`) : ''].filter(Boolean).join(comma);
    } else if ((cfg.type === 'service' || cfg.type === 'gateway') && s.queue > 0) foot = t(`排队 ${fmtCount(s.queue)}`, `${fmtCount(s.queue)} queued`);
    if (cfg.type === 'queue') foot = t(`${s.extra.consumers} 个有效消费者`, `${s.extra.consumers} active consumers`);
    if (s.wasted > 0 && cfg.type !== 'client') foot = `${foot ? `${foot}${comma}` : ''}${t(`${fmtRate(s.wasted)}/s 白做`, `${fmtRate(s.wasted)}/s wasted`)}`;
  }

  // instance pods (services / gateways): ready, starting, down
  let pods: ('up' | 'start' | 'down')[] = [];
  if (cfg.type === 'service' || cfg.type === 'gateway') {
    const ready = pendingInst || !s ? cfgInst : s.instances;
    const starting = pendingInst ? 0 : s?.extra.starting ?? 0;
    const down = pendingInst ? 0 : s?.extra.down ?? 0;
    pods = [...Array(ready).fill('up'), ...Array(starting).fill('start'), ...Array(down).fill('down')];
  }
  const MAX_PODS = 14;
  const replicas = cfg.type === 'service' ? Math.max(1, pendingInst ? cfgInst : s?.instances ?? cfgInst) : 1;

  return (
    <NodeShape type={cfg.type} replicas={replicas} partitions={Number(cfg.params.partitions ?? 12)} className={`sn sn-h--${health}${selected ? ' is-sel' : ''}${running && health === 'crit' ? ' is-shaking' : ''}`}>
      {hp !== null && (
        <div className={`sn-hp${hp < 0.5 ? ' is-low' : hp < 0.95 ? ' is-mid' : ''}`} aria-hidden="true"><i style={{ width: `${Math.max(2, hp * 100)}%` }} /></div>
      )}
      {floaters.map((f) => <span key={f.id} className={`floater floater--${f.kind}`} aria-hidden="true">{f.text}</span>)}
      {boom > 0 && <span key={boom} className="boom" aria-hidden="true">{Array.from({ length: 10 }, (_, i) => <i key={i} style={{ transform: `rotate(${i * 36}deg)` }} />)}</span>}
      {healRing > 0 && <span key={healRing} className="heal-ring" aria-hidden="true" />}
      {cfg.type !== 'client' && <Handle type="target" position={Position.Left} className="sn-handle" />}
      <CardQuick cfg={cfg} />
      <CardProbe cfg={cfg} />
      <CardDelete cfg={cfg} />
      <div className="sn-head">
        <span className="sn-glyph"><Glyph type={cfg.type} /></span>
        <div className="sn-title">
          <CardName cfg={cfg} />
          <div className="sn-kind">{spec.short}{instances && <>{comma}{instances}</>}</div>
        </div>
        {faulted ? <span className="sn-tag sn-tag--fault">{t('故障中', 'Fault')}</span> : isBottleneck ? <span className="sn-tag">{t('瓶颈', 'Bottleneck')}</span> : null}
      </div>
      <dl className="sn-stats">
        {stats.map((x) => (
          <div key={x.k} className={x.tone ? `is-${x.tone}` : ''}><dt>{x.k}</dt><dd>{x.v}</dd></div>
        ))}
      </dl>
      {ul && (
        <div className="sn-util" title={t(`${ul.kind}利用率`, `${ul.kind} utilization`)}>
          <div className="sn-util-track"><div className="sn-util-fill" style={{ width: `${Math.min(100, ul.value * 100)}%` }} /></div>
          <span>{ul.kind} {fmtPct(ul.value)}</span>
        </div>
      )}
      {pods.length > 0 && (
        <div className="sn-pods" title={t('实例：运行中 / 启动中 / 宕机', 'Instances: running / starting / down')}>
          {pods.slice(0, MAX_PODS).map((st, i) => <i key={i} className={`pod pod--${st}`} />)}
          {pods.length > MAX_PODS && <span>+{pods.length - MAX_PODS}</span>}
        </div>
      )}
      {foot && <div className="sn-foot">{foot}</div>}
      {cfg.type !== 'database' && cfg.type !== 'external' && <Handle type="source" position={Position.Right} className="sn-handle" />}
    </NodeShape>
  );
});

// ---------------------------------------------------------------- edge
// Edge width follows traffic volume: its share of the busiest edge seen in this run, raised to 0.65.
// A plain ratio would leave tens of calls/s as hairlines next to thousands; a log scale (the
// earlier choice) flattened everything above a few hundred calls/s to nearly the same width. The
// exact rate stays on the label.
const W_MIN = 1.2, W_MAX = 10, W_EXP = 0.65, PEAK_FLOOR = 50;
function flowWidth(rate: number, peak: number): number {
  if (rate <= 0.05) return 1.2;
  const ref = Math.max(peak, PEAK_FLOOR);
  return W_MIN + (W_MAX - W_MIN) * Math.pow(Math.min(1, rate / ref), W_EXP);
}
// Arrowheads come in sizes that stay in proportion to the line. The line stops short of
// the target by `inset` and the arrow tip reaches it, so a thick line never pokes out past the tip.
const ARROWS = [
  { upTo: 2.6, size: 12 },
  { upTo: 4, size: 15 },
  { upTo: 5.6, size: 18 },
  { upTo: 7.2, size: 22 },
  { upTo: 8.8, size: 26 },
  { upTo: Infinity, size: 29 },
];
const ARROW_INSET = 0.55;
function arrowFor(width: number) {
  const i = ARROWS.findIndex((a) => width <= a.upTo);
  return { id: `sb-arrow-${i}`, inset: ARROWS[i].size * ARROW_INSET };
}
function ArrowDefs({ color }: { color: string }) {
  return (
    <svg className="fe-defs" width="0" height="0" aria-hidden="true">
      <defs>
        {ARROWS.map((a, i) => (
          <marker key={i} id={`sb-arrow-${i}`} viewBox="0 0 10 10" refX={10 - 10 * ARROW_INSET} refY="5"
            markerWidth={a.size} markerHeight={a.size} markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill={color} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

const FlowEdge = memo(function FlowEdge(props: EdgeProps<FlowEdgeT>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data } = props;
  const t = useT();
  const s = useStore((st) => st.latest?.edges[id] ?? null);
  const rate = useStore((st) => st.edgeRate[id] ?? 0);
  const peak = useStore((st) => st.edgePeak);
  const running = useStore((st) => st.running);
  const select = useStore((st) => st.select);
  const calls = s?.calls ?? 0;
  const retryShare = calls > 0 ? s!.retries / calls : 0;
  const failShare = calls > 0 ? s!.fails / calls : 0;
  const cbOpen = s?.cb === 1;
  const cbHalf = s?.cb === 2;
  let state = calls > 0 ? 'ok' : 'idle';
  if (failShare > 0.005 || retryShare > 0.03) state = 'warn';
  if (failShare > 0.05 || cbOpen) state = 'crit';
  const width = flowWidth(rate, peak);
  const arrow = arrowFor(width);
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX: targetX - arrow.inset, targetY, sourcePosition, targetPosition });
  const dur = 1.2;
  const p = data!.cfg.params;
  const match = data!.fromType === 'gateway' && String(p.match ?? '') ? String(p.match) : '';
  const async = !!p.async;

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={`url(#${arrow.id})`} className={`fe fe--${state}${selected ? ' is-sel' : ''}${async ? ' fe--async' : ''}`} style={{ strokeWidth: width }} interactionWidth={20} />
      {calls > 0 && (
        <path d={path} className={`fe-flow fe-flow--${state}${running ? '' : ' is-paused'}`} style={{ strokeWidth: Math.max(1.2, width - 0.6), animationDuration: `${dur}s` }} />
      )}
      {calls > 0 && <Particles path={path} calls={calls} failShare={failShare} retryShare={retryShare} running={running} />}
      <EdgeLabelRenderer>
        <div
          className={`fe-label fe-label--${state}${selected ? ' is-sel' : ''}`}
          data-edge={id}
          style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
          onClick={(e) => { e.stopPropagation(); select({ kind: 'edge', id }); }}
        >
          {match && <span className="fe-chip fe-chip--path">{match}</span>}
          {data!.share !== undefined && <span className="fe-chip fe-chip--share" title={t('分流比例', 'Traffic share')}>{Math.round(data!.share * 100)}%</span>}
          {calls > 0 && <span className="fe-rate">{fmtRate(calls)}/s</span>}
          {retryShare > 0.01 && <span className="fe-chip fe-chip--warn">{t('重试', 'retry')} {fmtPct(retryShare)}</span>}
          {cbOpen && <span className="fe-chip fe-chip--crit">{t('熔断', 'open')}</span>}
          {cbHalf && <span className="fe-chip fe-chip--warn">{t('半开', 'half-open')}</span>}
          {!calls && !match && async && <span className="fe-chip">{t('异步', 'async')}</span>}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

// Requests as particles flying along the edge: green = ok, red = failed, amber flying back = retry.
const Particles = memo(function Particles({ path, calls, failShare, retryShare, running }: { path: string; calls: number; failShare: number; retryShare: number; running: boolean }) {
  // Particles show that traffic is moving and how it fares (ok / failed / retried); volume is the line width's job.
  const n = 3;
  const fails = failShare > 0.02 ? Math.max(1, Math.round(n * failShare)) : 0;
  const retries = retryShare > 0.03 ? Math.max(1, Math.round(n * retryShare)) : 0;
  const dur = 1.8;
  const items: { kind: 'ok' | 'fail' | 'retry'; delay: number }[] = [];
  for (let i = 0; i < n; i++) items.push({ kind: i < fails ? 'fail' : 'ok', delay: -(i / n) * dur });
  for (let i = 0; i < retries; i++) items.push({ kind: 'retry', delay: -((i + 0.5) / retries) * dur });
  return (
    <EdgeLabelRenderer>
      {items.map((it, i) => (
        <i key={i} className={`pt pt--${it.kind}${running ? '' : ' is-paused'}`}
          style={{ offsetPath: `path('${path}')`, animationDuration: `${it.kind === 'retry' ? dur * 1.2 : dur}s`, animationDelay: `${it.delay}s` }} />
      ))}
    </EdgeLabelRenderer>
  );
});

const nodeTypes = { sim: SimNode };
const edgeTypes = { flow: FlowEdge };

function validateConnection(from: NodeCfg, to: NodeCfg, edges: EdgeCfg[], t: T): string | null {
  if (from.id === to.id) return t('不能连到自己', 'A node can’t call itself');
  if (to.type === 'client') return t('流量源只能作为起点', 'A traffic source can only be a starting point');
  if (from.type === 'database') return t('数据库没有下游调用', 'Databases don’t call anything downstream');
  if (from.type === 'external') return t('外部依赖在你的系统之外，不会调用你的组件', 'A third-party API is outside your system; it doesn’t call your components');
  if (edges.some((e) => e.from === from.id && e.to === to.id)) return t('这两个节点之间已经有连线', 'These two nodes are already connected');
  const outs = edges.filter((e) => e.from === from.id).length;
  void outs;
  if (from.type === 'lb' && to.type !== 'service' && to.type !== 'gateway') return t('LB 后面应该接微服务或 Gateway', 'Put a service or a Gateway behind a load balancer');
  if (from.type === 'queue' && to.type !== 'service') return t('消费者必须是微服务', 'The consumer must be a service');
  return null;
}

export function Canvas() {
  const t = useT();
  const lang: Lang = useLang();
  const theme = useStore((s) => s.theme);
  const topology = useStore((s) => s.topology);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const updateNode = useStore((s) => s.updateNode);
  const addNode = useStore((s) => s.addNode);
  const addEdge = useStore((s) => s.addEdge);
  const removeNodes = useStore((s) => s.removeNodes);
  const removeEdges = useStore((s) => s.removeEdges);
  const showToast = useStore((s) => s.showToast);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const gameMode = useGame((g) => g.mode);
  const level = levelById(useGame((g) => g.levelId));
  const challengeLevel = gameMode === 'challenge' ? level : null;
  const lockedSet = new Set(challengeLevel?.lockedNodes ?? []);
  const lockedKey = [...lockedSet].join('|');

  const [nodes, setNodes, onNodesChange] = useNodesState<SimNodeT>([]);

  useEffect(() => {
    setNodes((prev) => topology.nodes.map((cfg) => {
      const p = prev.find((n) => n.id === cfg.id);
      return {
        ...(p ?? {}),
        id: cfg.id,
        type: 'sim' as const,
        position: p && p.dragging ? p.position : { x: cfg.x, y: cfg.y },
        data: { cfg },
        deletable: !lockedSet.has(cfg.id),
        selected: selection?.kind === 'node' && selection.id === cfg.id,
      };
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topology.nodes, selection, setNodes, lockedKey]);

  // refit when a different topology is loaded
  const loadSeq = useStore((s) => s.loadSeq);
  const inChallenge = useGame((g) => g.mode === 'challenge');
  const learning = useLearn((l) => l.active);
  // in a lesson, also refit as the learner adds nodes, leaving room for the guide card on the left
  const nodeCount = useStore((s) => (useLearn.getState().active ? s.topology.nodes.length : 0));
  useEffect(() => {
    const h = setTimeout(() => fitView(inChallenge
      ? { padding: { top: '190px', bottom: '24px', left: '24px', right: '24px' }, duration: 300 }
      : learning
        ? { padding: { top: '60px', bottom: '60px', left: '420px', right: '60px' }, maxZoom: 0.9, duration: 300 }
        : { padding: 0.06, duration: 300 }), 60);
    return () => clearTimeout(h);
  }, [loadSeq, fitView, inChallenge, learning, nodeCount]);

  const markerColor = theme === 'dark' ? '#7d8a97' : '#8593a0';
  const edges: FlowEdgeT[] = useMemo(() => {
    const types = new Map(topology.nodes.map((n) => [n.id, n.type]));
    // traffic share for edges that split exclusively
    const shares = new Map<string, number>();
    const byFrom = new Map<string, EdgeCfg[]>();
    for (const e of topology.edges) { if (!byFrom.has(e.from)) byFrom.set(e.from, []); byFrom.get(e.from)!.push(e); }
    const w = (e: EdgeCfg) => Math.max(0, Number(e.params.weight ?? 100));
    const assign = (set: EdgeCfg[]) => {
      if (set.length < 2) return;
      const tot = set.reduce((s, e) => s + w(e), 0);
      for (const e of set) shares.set(e.id, tot > 0 ? w(e) / tot : 1 / set.length);
    };
    for (const [from, outs] of byFrom) {
      const ft = types.get(from);
      if (ft === 'client' || ft === 'lb') assign(outs);
      else if (ft === 'gateway') {
        const byMatch = new Map<string, EdgeCfg[]>();
        for (const e of outs) { const m = String(e.params.match ?? ''); if (!byMatch.has(m)) byMatch.set(m, []); byMatch.get(m)!.push(e); }
        for (const set of byMatch.values()) assign(set);
      } else if (ft === 'service' || ft === 'cache') {
        const byOrder = new Map<number, EdgeCfg[]>();
        for (const e of outs) if (e.params.choice) { const o = Number(e.params.order ?? 0); if (!byOrder.has(o)) byOrder.set(o, []); byOrder.get(o)!.push(e); }
        for (const set of byOrder.values()) assign(set);
      }
    }
    return topology.edges.map((e) => ({
      id: e.id, source: e.from, target: e.to, type: 'flow' as const,
      selected: selection?.kind === 'edge' && selection.id === e.id,
      deletable: !lockedSet.has(e.from),
      data: { cfg: e, fromType: types.get(e.from)!, share: shares.get(e.id) },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topology.edges, topology.nodes, selection, lockedKey]);

  const onConnect = useCallback((c: Connection) => {
    const tp = useStore.getState().topology;
    const from = tp.nodes.find((n) => n.id === c.source);
    const to = tp.nodes.find((n) => n.id === c.target);
    if (!from || !to) return;
    const err = validateConnection(from, to, tp.edges, t);
    if (err) { showToast(err, 'warn'); return; }
    addEdge(newEdge(from, to, tp.edges));
  }, [addEdge, showToast, t]);

  const onDrop = useCallback((ev: React.DragEvent) => {
    ev.preventDefault();
    const type = ev.dataTransfer.getData('application/simbench') as NodeType;
    if (!type || !NODE_SPECS[type]) return;
    if (challengeLevel && !challengeLevel.allowedComponents.includes(type)) return;
    const pos = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
    const n = newNode(type, Math.round(pos.x - 100), Math.round(pos.y - 50), useStore.getState().topology.nodes, lang);
    const d = challengeLevel?.newNodeDefaults[type];
    if (d) n.params = { ...n.params, ...d };
    addNode(n);
  }, [addNode, screenToFlowPosition, lang, challengeLevel]);

  return (
    <div className="canvas" onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }} onDrop={onDrop}>
      <ArrowDefs color={markerColor} />
      <ReactFlow<SimNodeT, FlowEdgeT>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={theme}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onNodeClick={(_, n) => select({ kind: 'node', id: n.id })}
        onEdgeClick={(_, e) => select({ kind: 'edge', id: e.id })}
        onPaneClick={() => select(null)}
        onNodeDragStop={(_, _n, moved) => moved.forEach((m) => updateNode(m.id, { x: Math.round(m.position.x), y: Math.round(m.position.y) }))}
        onDelete={({ nodes: ns, edges: es }) => {
          // React Flow also reports the edges of deleted nodes; let removeNodes take those, so its
          // Undo brings the connections back with the components
          const gone = new Set(ns.map((n) => n.id));
          const loose = es.filter((e) => !gone.has(e.source) && !gone.has(e.target)).map((e) => e.id);
          if (loose.length) removeEdges(loose);
          if (ns.length) removeNodes(ns.map((n) => n.id));
        }}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
        fitViewOptions={{ padding: 0.06 }}
        minZoom={0.25}
        maxZoom={1.8}
        connectionRadius={28}
        defaultEdgeOptions={{ type: 'flow' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} color={theme === 'dark' ? '#2b333c' : '#c3ccd5'} />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
      {topology.nodes.length <= 1 && (
        <div className="canvas-empty">
          <p>{t('从左侧把组件拖到画布上。', 'Drag components from the left onto the canvas.')}</p>
          <p>{t('从节点右侧的圆点拖到另一个节点，就建立了一次调用。', 'Drag from a node’s right-hand dot to another node to add a call.')}</p>
        </div>
      )}
    </div>
  );
}
