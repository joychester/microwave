// Learning-mode controller: runs a lesson's steps against the live store.
import { create } from 'zustand';
import type { Topology } from '../engine/types';
import { lessonById } from '../learn/lessons';
import { sweepNext, type LessonCtx, type Measure, type NodeMeasure } from '../learn/types';
import { mainService } from '../learn/helpers';
import { useStore } from './store';
import { useGame } from './game';
import { play } from './sound';
import { DURATIONS, useRuns } from './runs';
import { pooledPct } from './format';

const LS_PROGRESS = 'simbench.learn.v1';
const LS_BACKUP = 'simbench.learn.backup.v1';
const LS_WELCOME = 'simbench.welcome.v1';
/** The learner's own run length, put back when the lesson ends (lessons run long, so they use the maximum). */
const LS_DURATION = 'simbench.learn.duration.v1';
const LESSON_DURATION = DURATIONS[DURATIONS.length - 1];

function load<T>(k: string, d: T): T {
  try { const r = localStorage.getItem(k); return r ? (JSON.parse(r) as T) : d; } catch { return d; }
}
function save(k: string, v: unknown) {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ }
}

interface LearnState {
  /** A lesson is running (the workbench belongs to it). */
  active: boolean;
  /** The Learn hub (lessons + challenges) is open. */
  listOpen: boolean;
  tab: 'lessons' | 'challenges';
  /** First-visit welcome is showing. */
  welcome: boolean;
  lessonId: string | null;
  step: number;
  /** The current step's condition is met (do steps) and its feedback is showing. */
  stepDone: boolean;
  /** Sim second at which the current step's condition started holding. */
  since: number | null;
  /** Seconds the condition has held so far, for the progress line. */
  held: number;
  answers: Record<string, number>;
  meas: Record<string, Measure>;
  completed: Record<string, boolean>;
  backup: Topology | null;
  collapsed: boolean;

  openList: (tab?: 'lessons' | 'challenges') => void;
  setTab: (tab: 'lessons' | 'challenges') => void;
  /** Leave any lesson and open a challenge level's brief. */
  pickLevel: (id: string) => void;
  closeList: () => void;
  start: (id: string) => void;
  restart: () => void;
  next: () => void;
  skip: () => void;
  answer: (stepId: string, i: number) => void;
  /** Leave the lesson. `keep` leaves its topology on the workbench; otherwise the workbench from before comes back. */
  exit: (keep?: boolean) => void;
  dismissWelcome: () => void;
  setCollapsed: (v: boolean) => void;
}

export const useLearn = create<LearnState>((set, get) => ({
  active: false,
  listOpen: false,
  tab: 'lessons',
  welcome: false,
  lessonId: null,
  step: 0,
  stepDone: false,
  since: null,
  held: 0,
  answers: {},
  meas: {},
  completed: load(LS_PROGRESS, {} as Record<string, boolean>),
  backup: null,
  collapsed: false,

  openList: (tab) => set({ listOpen: true, welcome: false, ...(tab ? { tab } : {}) }),
  setTab: (tab) => set({ tab }),
  pickLevel: (id) => {
    if (get().active) get().exit(false); // put the learner's own workbench back first
    set({ listOpen: false });
    const g = useGame.getState();
    if (g.mode !== 'challenge') g.enterChallenge();
    useGame.getState().openLevel(id);
  },
  closeList: () => set({ listOpen: false }),
  start: (id) => {
    const lesson = lessonById(id);
    if (!lesson) return;
    const st = useStore.getState();
    if (useGame.getState().mode === 'challenge') useGame.getState().exitChallenge();
    let backup = get().backup;
    if (!get().active) {
      backup = useStore.getState().topology;
      save(LS_BACKUP, backup);
      save(LS_DURATION, useRuns.getState().duration);
      useRuns.getState().setDuration(LESSON_DURATION);
    }
    st.pause();
    st.setScenario(null);
    st.setTopology(lesson.make(st.lang), { reset: true });
    st.setSpeed(lesson.speed ?? 5);
    st.select(null);
    set({ active: true, listOpen: false, welcome: false, lessonId: id, step: 0, stepDone: false, since: null, held: 0, answers: {}, meas: {}, backup, collapsed: false });
    save(LS_WELCOME, true);
    evaluate();
  },
  restart: () => { const id = get().lessonId; if (id) get().start(id); },
  next: () => {
    const lesson = lessonById(get().lessonId);
    if (!lesson) return;
    const step = Math.min(get().step + 1, lesson.steps.length - 1);
    set({ step, stepDone: false, since: null, held: 0 });
    if (step === lesson.steps.length - 1) {
      const completed = { ...get().completed, [lesson.id]: true };
      save(LS_PROGRESS, completed);
      set({ completed });
      play('win');
    }
    evaluate();
  },
  skip: () => get().next(),
  answer: (stepId, i) => {
    set({ answers: { ...get().answers, [stepId]: i } });
    play('click');
    get().next();
  },
  exit: (keep = false) => {
    const b = get().backup;
    set({ active: false, lessonId: null, step: 0, stepDone: false, since: null, held: 0, backup: null, listOpen: false });
    save(LS_BACKUP, null);
    restoreDuration();
    const st = useStore.getState();
    st.pause();
    if (!keep && b) st.setTopology(b, { reset: true });
  },
  dismissWelcome: () => { save(LS_WELCOME, true); set({ welcome: false }); },
  setCollapsed: (v) => set({ collapsed: v }),
}));

export function learnActive(): boolean {
  return useLearn.getState().active;
}

export function lessonCtx(): LessonCtx {
  const s = useStore.getState();
  const l = useLearn.getState();
  return {
    lang: s.lang, topo: s.topology, selection: s.selection, running: s.running,
    now: s.latest?.t ?? 0, failures: s.failures, latest: s.latest, dockOpen: s.dockOpen, dockTab: s.dockTab,
    speed: s.speed, duration: useRuns.getState().duration, meas: l.meas, answers: l.answers,
  };
}

/** Averages over the snapshots after `from` (sim seconds). */
function measure(from: number): Measure {
  const s = useStore.getState();
  const snaps = s.history.filter((x) => x.t > from);
  const c = lessonCtx();
  const svc = mainService(c);
  const n = Math.max(1, snaps.length);
  let req = 0, ok = 0, done = 0, latSum = 0, cpu = 0;
  const nodes: Record<string, NodeMeasure & { latW: number }> = {};
  const causes: Record<string, number> = {};
  for (const x of snaps) {
    const d = x.sys.ok + x.sys.fail;
    req += x.sys.req; ok += x.sys.ok; done += d; latSum += x.sys.mean * d;
    if (svc) cpu += x.nodes[svc.id]?.cpu ?? 0;
    for (const [id, ns] of Object.entries(x.nodes)) {
      const a = (nodes[id] ??= { util: 0, cpu: 0, lat: 0, conns: 0, latW: 0 });
      a.util += ns.util; a.cpu += ns.cpu; a.conns += ns.extra.conns ?? 0;
      // latency weighted by completions, ignoring seconds with none
      const w = ns.ok + ns.err;
      if (ns.mean !== undefined && isFinite(ns.mean) && w > 0) { a.lat += ns.mean * w; a.latW += w; }
    }
    for (const [k, v] of Object.entries(x.sys.causes)) causes[k] = (causes[k] ?? 0) + v;
  }
  const perNode: Record<string, NodeMeasure> = {};
  for (const [id, a] of Object.entries(nodes)) perNode[id] = { util: a.util / n, cpu: a.cpu / n, lat: a.latW > 0 ? a.lat / a.latW : 0, conns: a.conns / n };
  for (const k of Object.keys(causes)) causes[k] /= n;
  // p95 of every request in the window, not an average of per-second p95s
  const pooled = pooledPct(snaps.map((x) => x.sys.hist));
  const p95 = pooled ? pooled.p95 : snaps.reduce((a, x) => a + x.sys.p95, 0) / n;
  return { rps: req / n, avg: done > 0 ? latSum / done : 0, p95, avail: done > 0 ? ok / done : 1, cpu: cpu / n, instances: Number(svc?.params.instances ?? 0), nodes: perNode, causes };
}

/** Checks the current step against the store; called on every relevant change. */
function evaluate() {
  const l = useLearn.getState();
  if (!l.active || l.stepDone) return;
  const lesson = lessonById(l.lessonId);
  const step = lesson?.steps[l.step];
  if (!step || step.kind !== 'do') return;
  const c = lessonCtx();
  const sw = step.sweep;
  const target = sw ? sweepNext(sw, l.meas) : undefined;
  if (sw && target === undefined) {
    useLearn.setState({ stepDone: true });
    return;
  }
  const ok = step.check(c) && (!sw || sw.value(c) === target);
  if (!ok) {
    if (l.since !== null || l.held) useLearn.setState({ since: null, held: 0 });
    return;
  }
  if (!step.hold) {
    useLearn.setState({ stepDone: true });
    play('recover');
    return;
  }
  const now = c.latest?.t ?? 0;
  let since = l.since;
  // Start counting from the next second; a reset (time going backwards) starts over.
  if (since === null || now < since) {
    useLearn.setState({ since: now, held: 0 });
    return;
  }
  const held = now - since;
  if (held >= step.hold) {
    const key = sw ? `${sw.key}${target}` : step.measure;
    const meas = key ? { ...l.meas, [key]: measure(since + (step.settle ?? 0)) } : l.meas;
    if (sw && sweepNext(sw, meas) !== undefined) {
      // this setting is measured; wait for the next one
      useLearn.setState({ meas, since: null, held: 0 });
      play('click');
      return;
    }
    useLearn.setState({ stepDone: true, held: step.hold, meas });
    play('recover');
  } else if (held !== l.held) {
    useLearn.setState({ held });
  }
}

useStore.subscribe((s, prev) => {
  if (!useLearn.getState().active) return;
  if (s.latest !== prev.latest || s.topology !== prev.topology || s.selection !== prev.selection || s.failures !== prev.failures || s.dockTab !== prev.dockTab || s.dockOpen !== prev.dockOpen || s.speed !== prev.speed) evaluate();
});

function restoreDuration() {
  const d = load<number | null>(LS_DURATION, null);
  if (d !== null && DURATIONS.includes(d)) useRuns.getState().setDuration(d);
  save(LS_DURATION, null);
}

// A lesson interrupted by a reload: put the learner's own workbench and run length back.
restoreDuration();
const pending = load<Topology | null>(LS_BACKUP, null);
if (pending && Array.isArray(pending.nodes)) {
  save(LS_BACKUP, null);
  useStore.getState().setTopology(pending, { reset: true });
}
// First visit: offer lesson 1.
if (!load(LS_WELCOME, false) && !pending) useLearn.setState({ welcome: true });

// the run length lives in the runs store; a lesson step can ask for it (lesson 1)
useRuns.subscribe((r, prev) => { if (r.duration !== prev.duration) evaluate(); });
