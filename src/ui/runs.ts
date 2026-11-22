// Timed sandbox runs and their reports. Statistics are accumulated per second,
// so a 30-minute report does not depend on the (capped) chart history.
import { addHist, histCount, histPct } from '../engine/hist';
import { create } from 'zustand';
import { costPerHour } from '../engine/cost';
import { NODE_SPECS } from '../engine/specs';
import { describeProgram, isProgram, programFromLegacy } from '../engine/traffic';
import type { Snapshot, Topology } from '../engine/types';
import { useStore } from './store';
import { useGame } from './game';
import { play } from './sound';
import { sloPct, type Pct } from './format';
import { limitActive } from './limit';

export const DURATIONS = [60, 120, 300, 600, 1800]; // seconds; capped at 30 minutes

interface NodeAcc {
  name: string; type: string; peakUtil: number; peakT: number;
  /** Worst single-second latency at the SLO percentile. */
  p99Max: number;
  /** Latency at the SLO percentile over every request of the run. */
  pctAll: number;
  err: number; arrMax: number;
}

export interface RunReport {
  id: number;
  name: string;
  t0: number; // sim second the run started after
  duration: number; // planned seconds
  seconds: number; // actually run
  topology: string;
  traffic: { name: string; model: string }[];
  requests: number;
  ok: number;
  fail: number;
  avail: number;
  /** Worst single-second latency at the SLO percentile. */
  p99Max: number;
  p99Avg: number;
  /** Latency at the SLO percentile over every request of the run (merged histograms). */
  pctAll: number;
  /** Request-weighted mean latency over the run (ms). */
  latAvg: number;
  sloSeconds: number; // seconds that met both SLOs
  offeredPeak: number;
  offeredAvg: number;
  knee: { t: number; rps: number; nodeId?: string; nodeName?: string } | null;
  firstSaturated: { t: number; nodeId: string; name: string; rps: number } | null;
  causes: Record<string, number>;
  nodes: Record<string, NodeAcc>;
  costAvg: number;
  lagMax: number;
  ampMax: number;
  slo: { avail: number; p99: number };
  /** Latency percentile the SLO and the latency figures use. Fields named p99* hold this percentile. */
  pct: Pct;
  /** Configuration when the run started, for comparing runs. */
  config: Topology;
  /** Parameters were edited while this run was going; the report reflects a mix of both. */
  editedMidRun: boolean;
}

interface Acc extends Omit<RunReport, 'id' | 'name' | 'avail' | 'p99Avg' | 'latAvg' | 'offeredAvg' | 'costAvg' | 'pctAll'> {
  hist: Map<number, number>; nodeHist: Record<string, Map<number, number>>;
  topoRef: Topology; topoSig: string; latWeighted: number; p99Sum: number; offeredSum: number; costSum: number; kneeStreak: number; satStreak: Record<string, number>;
}

/** Everything that affects a run, without canvas positions (dragging a node is not an edit). */
/** Node params that only say where to read real metrics (obsService, obsConn, obsMetrics); they don't change the model. */
const modelParams = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('obs')));

function configSig(t: Topology): string {
  return JSON.stringify([t.nodes.map((n) => [n.id, n.type, n.name, modelParams(n.params)]), t.edges]);
}

function newAcc(topo: Topology, duration: number, lang: 'zh' | 'en', t0: number): Acc {
  const client = topo.nodes.find((n) => n.type === 'client');
  return {
    t0, duration, seconds: 0, topology: topo.name,
    traffic: topo.nodes.filter((n) => n.type === 'client').map((n) => ({
      name: n.name, model: describeProgram(isProgram(n.params.traffic) ? n.params.traffic : programFromLegacy(n.params), lang),
    })),
    requests: 0, ok: 0, fail: 0, p99Max: 0, sloSeconds: 0, offeredPeak: 0,
    knee: null, firstSaturated: null, causes: {}, nodes: {}, lagMax: 0, ampMax: 1,
    slo: { avail: Number(client?.params.sloAvail ?? 0.999), p99: Number(client?.params.sloP99 ?? 500) },
    pct: sloPct(topo),
    config: JSON.parse(JSON.stringify(topo)), editedMidRun: false, topoRef: topo, topoSig: configSig(topo),
    latWeighted: 0, p99Sum: 0, offeredSum: 0, costSum: 0, kneeStreak: 0, satStreak: {},
    hist: new Map(), nodeHist: {},
  };
}

function addSnap(a: Acc, s: Snapshot, topo: Topology) {
  a.seconds += 1;
  if (topo !== a.topoRef) {
    a.topoRef = topo;
    const sig = configSig(topo);
    if (sig !== a.topoSig) { a.editedMidRun = true; a.topoSig = sig; }
  }
  const sys = s.sys;
  a.requests += sys.req; a.ok += sys.ok; a.fail += sys.fail;
  const lat = sys[a.pct];
  a.p99Max = Math.max(a.p99Max, lat); a.p99Sum += lat;
  addHist(a.hist, sys.hist);
  a.latWeighted += (sys.mean ?? sys.p50) * sys.req;
  a.offeredPeak = Math.max(a.offeredPeak, sys.offered); a.offeredSum += sys.offered;
  a.ampMax = Math.max(a.ampMax, sys.amplification);
  for (const [k, v] of Object.entries(sys.causes)) a.causes[k] = (a.causes[k] ?? 0) + v;
  const avail = sys.ok + sys.fail > 0 ? sys.ok / (sys.ok + sys.fail) : 1;
  const good = avail >= a.slo.avail && (sys.req === 0 || lat <= a.slo.p99);
  if (good) a.sloSeconds += 1;
  a.costSum += costPerHour(topo, s.nodes).total;

  // busiest node this second (for the knee annotation)
  let busiest: { id: string; v: number } | null = null;
  for (const n of topo.nodes) {
    const ns = s.nodes[n.id];
    if (!ns) continue;
    let acc = a.nodes[n.id];
    if (!acc) acc = a.nodes[n.id] = { name: n.name, type: n.type, peakUtil: 0, peakT: 0, p99Max: 0, pctAll: 0, err: 0, arrMax: 0 };
    if (n.type !== 'client') addHist(a.nodeHist[n.id] ??= new Map(), ns.hist);
    const u = n.type === 'client' || n.type === 'lb' || n.type === 'queue' ? 0 : Math.max(ns.util, ns.cpu);
    if (u > acc.peakUtil) { acc.peakUtil = u; acc.peakT = s.t; }
    acc.p99Max = Math.max(acc.p99Max, n.type === 'client' ? 0 : (ns[a.pct] ?? ns.p99));
    acc.err += n.type === 'client' ? 0 : ns.err;
    acc.arrMax = Math.max(acc.arrMax, ns.arr);
    if (n.type === 'queue') a.lagMax = Math.max(a.lagMax, ns.extra.lag ?? 0);
    if (u > (busiest?.v ?? 0)) busiest = { id: n.id, v: u };
    // first component to stay ≥ 95% busy for 3 s
    if (!a.firstSaturated && u >= 0.95) {
      a.satStreak[n.id] = (a.satStreak[n.id] ?? 0) + 1;
      if (a.satStreak[n.id] >= 3) a.firstSaturated = { t: s.t - 2, nodeId: n.id, name: n.name, rps: sys.offered };
    } else if (u < 0.95) a.satStreak[n.id] = 0;
  }
  // knee: first time the SLO is broken for 3 consecutive seconds
  if (!a.knee) {
    a.kneeStreak = good ? 0 : a.kneeStreak + 1;
    if (a.kneeStreak >= 3) {
      a.knee = { t: s.t - 2, rps: sys.offered, nodeId: busiest?.id, nodeName: busiest ? topo.nodes.find((n) => n.id === busiest!.id)?.name : undefined };
    }
  }
}

function finalize(a: Acc, id: number): RunReport {
  const done = a.ok + a.fail;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { topoRef, topoSig, latWeighted, p99Sum, offeredSum, costSum, kneeStreak, satStreak, hist, nodeHist, ...rest } = a;
  const q = a.pct === 'p99' ? 0.99 : 0.95;
  const nodes: Record<string, NodeAcc> = {};
  for (const [id, n] of Object.entries(a.nodes)) {
    const h = nodeHist[id];
    nodes[id] = { ...n, pctAll: h && histCount(h) > 0 ? histPct(h, q) : n.p99Max };
  }
  return {
    ...rest, nodes, id, name: `#${id}`,
    pctAll: histCount(hist) > 0 ? histPct(hist, q) : (a.seconds > 0 ? a.p99Sum / a.seconds : 0),
    avail: done > 0 ? a.ok / done : 1,
    p99Avg: a.seconds > 0 ? a.p99Sum / a.seconds : 0,
    latAvg: a.requests > 0 ? a.latWeighted / a.requests : 0,
    offeredAvg: a.seconds > 0 ? a.offeredSum / a.seconds : 0,
    costAvg: a.seconds > 0 ? a.costSum / a.seconds : 0,
  };
}

interface RunsState {
  duration: number;
  acc: Acc | null;
  reports: RunReport[];
  seq: number;
  baseT: number;
  setDuration: (s: number) => void;
  stopNow: () => void;
}

const LS = 'simbench.runs.v1';
function loadDuration(): number {
  try { const d = Number(localStorage.getItem(LS)); return DURATIONS.includes(d) ? d : 300; } catch { return 300; }
}

export const useRuns = create<RunsState>((set, get) => ({
  duration: loadDuration(),
  acc: null,
  reports: [],
  seq: 0,
  baseT: 0,
  setDuration: (s) => {
    set({ duration: s });
    try { localStorage.setItem(LS, String(s)); } catch { /* ignore */ }
    const a = get().acc;
    if (a) a.duration = s;
  },
  stopNow: () => complete(),
}));

function complete() {
  const st = useStore.getState();
  const r = useRuns.getState();
  st.pause();
  if (!r.acc || r.acc.seconds < 2) return;
  const id = r.seq + 1;
  const rep = finalize(r.acc, id);
  useRuns.setState({ reports: [rep, ...r.reports].slice(0, 10), seq: id, acc: null, baseT: r.acc.t0 + r.acc.seconds });
  st.setDock('report');
  st.showToast(st.lang === 'en' ? `Run ${rep.name} finished: report is ready` : `运行 ${rep.name} 已结束，报告已生成`);
  play('win');
}

useStore.subscribe((s, prev) => {
  if (useGame.getState().mode === 'challenge') return;
  if (limitActive()) return; // the capacity-limit search drives the simulation; it is not a timed run
  // reset → new run
  if (s.history.length === 0 && prev.history.length > 0) { useRuns.setState({ acc: null, baseT: 0 }); return; }
  if (s.history === prev.history || s.history.length === 0) return;
  let acc = useRuns.getState().acc;
  if (!acc) {
    acc = newAcc(s.topology, useRuns.getState().duration, s.lang, useRuns.getState().baseT);
    useRuns.setState({ acc });
  }
  const fresh = [];
  for (let i = s.history.length - 1; i >= 0 && s.history[i].t > acc.t0 + acc.seconds; i--) fresh.unshift(s.history[i]);
  for (const snap of fresh) {
    if (acc.seconds >= acc.duration) break;
    addSnap(acc, snap, s.topology);
  }
  if (acc.seconds >= acc.duration && s.running) complete();
});

export function nodeTypeLabel(type: string, lang: 'zh' | 'en') {
  return NODE_SPECS[type as keyof typeof NODE_SPECS]?.label[lang] ?? type;
}
