// Capacity-limit search: scale every traffic source up step by step on the live simulation until the
// criterion breaks, narrow down to the limit, hold the load there for a while to confirm it, then stop.
//
// Criteria
//   util  every component's utilization (threads / CPU / connections / quota, whichever is highest)
//         stays at or below a threshold (default 70%) — leaves headroom, so the system is never pushed
//         into overload while searching
//   slo   the SLO holds (availability and latency at the SLO percentile)
//
// Each step: settle (queues and caches adjust), then measure. Utilization grows almost linearly with
// load, so once a passing and a failing step bracket the threshold, the limit is interpolated
// between them; the SLO criterion is not linear, so it bisects instead.
import { create } from 'zustand';
import type { Snapshot, Topology } from '../engine/types';
import { useStore } from './store';
import { useGame } from './game';
import { play } from './sound';
import { useRuns } from './runs';

export type Criterion = 'util' | 'slo';

export interface LimitStep {
  scale: number;
  offered: number; // measured entry rate, requests/s
  peakUtil: number; // highest component utilization (window average)
  bottleneck: string; // name of that component
  sloOk: boolean;
  pass: boolean;
  /** why a failing step failed */
  reason?: 'util' | 'backlog' | 'slo';
}

export interface LimitResult {
  id: number;
  topology: string;
  criterion: Criterion;
  threshold: number;
  holdSeconds: number;
  /** null when no limit was found below the maximum scale */
  limitScale: number | null;
  limitRps: number;
  baseRps: number;
  steps: LimitStep[];
  /** Busiest components while holding at the limit, highest first. */
  ranking: { id: string; name: string; util: number }[];
  /** What stopped the next step up: the component and why. */
  limitedBy?: { name: string; reason: 'util' | 'backlog' | 'slo' };
  hold: { avail: number; latAvg: number; latMax: number; pct: 'p95' | 'p99'; peakUtil: number };
  note?: 'below-today' | 'max-scale' | 'stopped';
  finishedAt: string;
}

type Phase = 'idle' | 'step' | 'hold';

interface Window {
  start: number; // sim second the step began
  utilSum: Record<string, number>;
  n: number;
  offeredSum: number;
  badStreak: number;
  sloBroken: boolean;
  okSum: number; doneSum: number; latW: number; latMax: number;
  /** message queues: backlog at the first and last measured second, and messages in */
  lag: Record<string, { first: number; last: number; inSum: number }>;
}

interface LimitState {
  phase: Phase;
  criterion: Criterion;
  threshold: number;
  holdSeconds: number;
  scale: number;
  steps: LimitStep[];
  results: LimitResult[];
  seq: number;
  holdTries: number;
  lastT: number;
  win: Window | null;
  setCriterion: (c: Criterion) => void;
  setThreshold: (v: number) => void;
  setHoldSeconds: (v: number) => void;
  start: () => void;
  stop: () => void;
}

const SETTLE = 15; // s
const MEASURE = 15; // s
const GROW = 1.25;
const MAX_SCALE = 50;
const MAX_STEPS = 24;

const newWin = (start: number): Window => ({ start, utilSum: {}, n: 0, offeredSum: 0, badStreak: 0, sloBroken: false, okSum: 0, doneSum: 0, latW: 0, latMax: 0, lag: {} });

export const useLimit = create<LimitState>((set, get) => ({
  phase: 'idle',
  criterion: 'util',
  threshold: 0.7,
  holdSeconds: 60,
  scale: 1,
  steps: [],
  results: [],
  seq: 0,
  holdTries: 0,
  lastT: 0,
  win: null,
  setCriterion: (c) => set({ criterion: c }),
  setThreshold: (v) => set({ threshold: Math.min(0.95, Math.max(0.3, v)) }),
  setHoldSeconds: (v) => set({ holdSeconds: v }),
  start: () => {
    const st = useStore.getState();
    st.reset();
    st.setSpeed(20);
    st.setLoadScale(1);
    set({ phase: 'step', scale: 1, steps: [], holdTries: 0, lastT: 0, win: newWin(0) });
    setTimeout(() => useStore.getState().run(), 60);
  },
  stop: () => finish('stopped'),
}));

/** Utilization that can saturate, per component: threads, CPU, connections, shards or provider quota. */
function utilOf(topo: Topology, s: Snapshot): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of topo.nodes) {
    if (n.type === 'client' || n.type === 'lb' || n.type === 'queue') continue;
    const ns = s.nodes[n.id];
    if (!ns) continue;
    out[n.id] = Math.max(ns.util, ns.cpu);
  }
  return out;
}

function sloOf(topo: Topology) {
  const c = topo.nodes.find((n) => n.type === 'client');
  return {
    avail: Number(c?.params.sloAvail ?? 0.999),
    lat: Number(c?.params.sloP99 ?? 500),
    pct: (c?.params.sloPct === 'p99' ? 'p99' : 'p95') as 'p95' | 'p99',
  };
}

/** A queue whose backlog keeps growing has consumers past 100%, whatever their threads show. */
function backlogGrowing(w: Window, topo: Topology): string | null {
  for (const [id, q] of Object.entries(w.lag)) {
    if (q.last - q.first > Math.max(100, 0.1 * q.inSum)) return topo.nodes.find((n) => n.id === id)?.name ?? id;
  }
  return null;
}

function summarize(w: Window, topo: Topology) {
  const avg = Object.entries(w.utilSum).map(([id, v]) => ({ id, name: topo.nodes.find((n) => n.id === id)?.name ?? id, util: v / Math.max(1, w.n) }))
    .sort((a, b) => b.util - a.util);
  return { ranking: avg, peak: avg[0]?.util ?? 0, bottleneck: avg[0]?.name ?? '—', offered: w.offeredSum / Math.max(1, w.n) };
}

function setScale(v: number) {
  useLimit.setState({ scale: v });
  useStore.getState().setLoadScale(v);
}

function finish(note?: LimitResult['note'], hold?: { w: Window; topo: Topology }) {
  const L = useLimit.getState();
  if (L.phase === 'idle') return;
  const st = useStore.getState();
  st.pause();
  const topo = st.topology;
  const slo = sloOf(topo);
  const base = L.steps.find((s) => Math.abs(s.scale - 1) < 1e-9)?.offered ?? L.steps[0]?.offered ?? 0;
  let result: LimitResult;
  const id = L.seq + 1;
  if (hold) {
    const sm = summarize(hold.w, topo);
    result = {
      id, topology: topo.name, criterion: L.criterion, threshold: L.threshold, holdSeconds: L.holdSeconds,
      limitScale: L.scale, limitRps: sm.offered, baseRps: base, steps: L.steps, ranking: sm.ranking.slice(0, 5),
      hold: { avail: hold.w.doneSum > 0 ? hold.w.okSum / hold.w.doneSum : 1, latAvg: hold.w.n > 0 ? hold.w.latW / hold.w.n : 0, latMax: hold.w.latMax, pct: slo.pct, peakUtil: sm.peak },
      note: L.scale < 1 ? 'below-today' : undefined,
      limitedBy: (() => { const hi = L.steps.filter((s) => !s.pass && s.scale > L.scale).sort((a, b) => a.scale - b.scale)[0]; return hi?.reason ? { name: hi.bottleneck, reason: hi.reason } : undefined; })(),
      finishedAt: new Date().toISOString(),
    };
  } else {
    const lastPass = [...L.steps].reverse().find((s) => s.pass);
    result = {
      id, topology: topo.name, criterion: L.criterion, threshold: L.threshold, holdSeconds: L.holdSeconds,
      limitScale: note === 'max-scale' ? null : lastPass?.scale ?? null, limitRps: lastPass?.offered ?? 0, baseRps: base, steps: L.steps,
      ranking: [], hold: { avail: 0, latAvg: 0, latMax: 0, pct: slo.pct, peakUtil: 0 }, note, finishedAt: new Date().toISOString(),
    };
  }
  useLimit.setState({ phase: 'idle', win: null, results: [result, ...L.results].slice(0, 5), seq: id });
  // a timed run started later begins after the search, not from second 0
  useRuns.setState({ acc: null, baseT: L.lastT });
  setScale(1);
  st.setDock('capacity');
  st.showToast(st.lang === 'en'
    ? (note === 'stopped' ? 'Limit search stopped' : 'Limit search finished')
    : (note === 'stopped' ? '找上限已停止' : '找上限完成'));
  if (note !== 'stopped') play('win');
}

function endStep(L: LimitState, w: Window, topo: Topology, t: number) {
  const sm = summarize(w, topo);
  const sloOk = !w.sloBroken;
  const backlog = backlogGrowing(w, topo);
  const pass = (L.criterion === 'util' ? sm.peak <= L.threshold : sloOk) && !backlog;
  const reason: LimitStep['reason'] = pass ? undefined : backlog ? 'backlog' : L.criterion === 'util' ? 'util' : 'slo';
  const step: LimitStep = { scale: L.scale, offered: sm.offered, peakUtil: backlog ? Math.max(sm.peak, 1) : sm.peak, bottleneck: backlog ?? sm.bottleneck, sloOk, pass, reason };
  const steps = [...L.steps, step];
  useLimit.setState({ steps });
  const lo = [...steps].filter((s) => s.pass).sort((a, b) => b.scale - a.scale)[0];
  const hi = [...steps].filter((s) => !s.pass).sort((a, b) => a.scale - b.scale)[0];
  let next: number | null = null;
  let hold: number | null = null;
  if (lo && hi && lo.scale < hi.scale) {
    if (L.criterion === 'util') {
      const f = hi.peakUtil > lo.peakUtil ? (L.threshold - lo.peakUtil) / (hi.peakUtil - lo.peakUtil) : 0;
      hold = lo.scale + Math.min(1, Math.max(0, f)) * (hi.scale - lo.scale);
    } else if ((hi.scale - lo.scale) / lo.scale <= 0.05) hold = lo.scale;
    else next = (lo.scale + hi.scale) / 2;
  } else if (pass) next = L.scale * GROW;
  else next = L.scale / GROW;

  if (steps.length >= MAX_STEPS && hold === null) { finish(lo ? undefined : 'max-scale'); return; }
  if (next !== null && next > MAX_SCALE) { finish('max-scale'); return; }
  if (next !== null && next < 0.05) { finish('below-today'); return; }
  if (hold !== null) {
    setScale(Math.round(hold * 1000) / 1000);
    useLimit.setState({ phase: 'hold', holdTries: 0, win: newWin(t) });
  } else if (next !== null) {
    setScale(Math.round(next * 1000) / 1000);
    useLimit.setState({ win: newWin(t) });
  }
}

function endHold(L: LimitState, w: Window, topo: Topology, t: number) {
  const sm = summarize(w, topo);
  const backlog = backlogGrowing(w, topo) !== null;
  const tooHigh = (L.criterion === 'util' ? sm.peak > L.threshold + 0.03 : w.sloBroken) || backlog;
  if (tooHigh && L.holdTries < 3) {
    // the interpolated point was a little optimistic: back off and hold again
    const factor = backlog ? 0.9 : L.criterion === 'util' ? Math.min(0.99, Math.max(0.85, L.threshold / Math.max(sm.peak, 1e-6))) : 0.95;
    setScale(Math.round(L.scale * factor * 1000) / 1000);
    useLimit.setState({ holdTries: L.holdTries + 1, win: newWin(t) });
    return;
  }
  finish(undefined, { w, topo });
}

useStore.subscribe((s, prev) => {
  const L = useLimit.getState();
  if (L.phase === 'idle' || !L.win) return;
  if (useGame.getState().mode === 'challenge') { finish('stopped'); return; }
  if (s.history === prev.history || s.history.length === 0) return;
  const topo = s.topology;
  const slo = sloOf(topo);
  const fresh = s.history.filter((h) => h.t > L.lastT);
  for (const snap of fresh) {
    const cur = useLimit.getState();
    if (cur.phase === 'idle' || !cur.win) return;
    useLimit.setState({ lastT: snap.t });
    const w = cur.win;
    const age = snap.t - w.start;
    if (age <= SETTLE) continue;
    const u = utilOf(topo, snap);
    for (const [id, v] of Object.entries(u)) w.utilSum[id] = (w.utilSum[id] ?? 0) + v;
    w.n += 1;
    w.offeredSum += snap.sys.offered;
    const done = snap.sys.ok + snap.sys.fail;
    const avail = done > 0 ? snap.sys.ok / done : 1;
    const lat = snap.sys[slo.pct];
    const good = avail >= slo.avail && (snap.sys.req === 0 || lat <= slo.lat);
    w.badStreak = good ? 0 : w.badStreak + 1;
    if (w.badStreak >= 3) w.sloBroken = true;
    for (const n of topo.nodes) {
      if (n.type !== 'queue' || !snap.nodes[n.id]) continue;
      const lag = snap.nodes[n.id].extra.lag ?? 0;
      const q = (w.lag[n.id] ??= { first: lag, last: lag, inSum: 0 });
      q.last = lag; q.inSum += snap.nodes[n.id].arr;
    }
    w.okSum += snap.sys.ok; w.doneSum += done; w.latW += lat; w.latMax = Math.max(w.latMax, lat);
    if (cur.phase === 'step' && age >= SETTLE + MEASURE) endStep(cur, w, topo, snap.t);
    else if (cur.phase === 'hold' && age >= SETTLE + cur.holdSeconds) endHold(cur, w, topo, snap.t);
  }
});

/** True while a search is driving the simulation (timed runs stay out of its way). */
export const limitActive = () => useLimit.getState().phase !== 'idle';
