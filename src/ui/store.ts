import { create } from 'zustand';
import SimWorker from '../engine/worker?worker&inline';
import { createHost, type ToWorker } from '../engine/host';
import { referenceTopology, translateTopology } from '../engine/presets';
import type { EdgeCfg, FailureSpec, Lang, NodeCfg, Params, SimEvent, Snapshot, Topology } from '../engine/types';

export interface FailureView {
  id: string; nodeId: string; kind: string; params: Record<string, number>;
  duration_s: number; recovery_s: number; start: number; end: number; // end -1 = open
}
export interface PendingView { id: string; nodeId: string; kind: string; at: number }

export type Selection = { kind: 'node' | 'edge'; id: string } | null;
export type DockTab = 'charts' | 'capacity' | 'events' | 'report';

const HISTORY = 900;
const LS_KEY = 'simbench.topology.v1';
const LS_PREFS = 'simbench.prefs.v1';
export type Theme = 'light' | 'dark';

interface Prefs { lang: Lang; theme: Theme; flowWidth: boolean }
function loadPrefs(): Prefs {
  let lang: Lang = 'en';
  let theme: Theme = 'light';
  let flowWidth = true;
  try { if (/^zh/i.test(navigator.language)) lang = 'zh'; } catch { /* ignore */ }
  try { if (window.matchMedia('(prefers-color-scheme: dark)').matches) theme = 'dark'; } catch { /* ignore */ }
  try {
    const raw = localStorage.getItem(LS_PREFS);
    if (raw) {
      const p = JSON.parse(raw);
      if (p.lang === 'zh' || p.lang === 'en') lang = p.lang;
      if (p.theme === 'light' || p.theme === 'dark') theme = p.theme;
      if (typeof p.flowWidth === 'boolean') flowWidth = p.flowWidth;
    }
  } catch { /* storage unavailable */ }
  return { lang, theme, flowWidth };
}
function savePrefs(p: Prefs) {
  try { localStorage.setItem(LS_PREFS, JSON.stringify(p)); } catch { /* ignore */ }
}
const PREFS = loadPrefs();

function loadTopology(): Topology {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const t = JSON.parse(raw) as Topology;
      if (t && Array.isArray(t.nodes) && Array.isArray(t.edges)) return t;
    }
  } catch { /* storage unavailable */ }
  return referenceTopology(PREFS.lang);
}

function saveTopology(t: Topology) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(t)); } catch { /* ignore */ }
}

interface State {
  topology: Topology;
  selection: Selection;
  running: boolean;
  speed: number;
  simTime: number; // ms
  achieved: number;
  history: Snapshot[];
  latest: Snapshot | null;
  events: SimEvent[];
  unseenEvents: number;
  failures: FailureView[];
  pending: PendingView[];
  dockTab: DockTab;
  dockOpen: boolean;
  toast: { text: string; tone: 'info' | 'warn'; id: number } | null;
  activeScenario: string | null;
  bottleneckId: string | null;
  lang: Lang;
  theme: Theme;
  loadSeq: number;
  /** Edge widths follow traffic volume. */
  flowWidth: boolean;
  /** Per-edge calls/s, smoothed over ~3 s. */
  edgeRate: Record<string, number>;
  /** Highest smoothed edge rate seen in this run: the reference for edge widths. */
  edgePeak: number;

  setFlowWidth: (on: boolean) => void;
  /** Calibration dialog open. */
  calOpen: boolean;
  /** Topology before the last calibration was applied, for undo. Cleared when another topology loads. */
  calBackup: Topology | null;
  setCalOpen: (open: boolean, preset?: { text: string; source: string }) => void;
  /** CSV to open the calibration dialog with (e.g. built from fetched real metrics). */
  calPreset: { text: string; source: string } | null;
  applyCalibrated: (t: Topology) => void;
  undoCalibration: () => void;

  setLang: (l: Lang) => void;
  setTheme: (t: Theme) => void;
  setTopology: (t: Topology, opts?: { reset?: boolean }) => void;
  updateNode: (id: string, patch: Partial<NodeCfg>) => void;
  updateNodeParams: (id: string, params: Params) => void;
  updateEdgeParams: (id: string, params: Params) => void;
  addNode: (n: NodeCfg) => void;
  addEdge: (e: EdgeCfg) => void;
  removeNodes: (ids: string[]) => void;
  removeEdges: (ids: string[]) => void;
  select: (s: Selection) => void;
  run: () => void;
  pause: () => void;
  toggle: () => void;
  reset: () => void;
  setSpeed: (v: number) => void;
  /** Multiplier on every traffic source (capacity-limit search); back to 1 on reset. */
  loadScale: number;
  setLoadScale: (v: number) => void;
  inject: (spec: FailureSpec, at_s?: number) => void;
  clearFailure: (id: string) => void;
  setDock: (tab: DockTab | null) => void;
  showToast: (text: string, tone?: 'info' | 'warn') => void;
  setScenario: (id: string | null) => void;
}

// Prefer a Web Worker; fall back to the main thread when workers are unavailable
// (file:// pages, strict sandboxes). The fallback replays every message sent so far.
let gotTick = false;
const sent: ToWorker[] = [];
let mainHost: ((m: ToWorker) => void) | null = null;
let worker: Worker | null = null;
try { worker = new SimWorker(); } catch { worker = null; }
const send = (m: ToWorker) => {
  if (mainHost) { mainHost(m); return; }
  if (!gotTick) sent.push(m);
  worker?.postMessage(m);
};
function useMainThread() {
  if (mainHost) return;
  try { worker?.terminate(); } catch { /* ignore */ }
  worker = null;
  console.info('[microwave] Web Worker unavailable, running the simulator on the main thread');
  mainHost = createHost((m) => onHostMessage({ data: m } as MessageEvent), 40_000);
  for (const m of sent.splice(0)) mainHost(m);
}
if (!worker) setTimeout(useMainThread, 0);
else {
  worker.onerror = () => useMainThread();
  setTimeout(() => { if (!gotTick) useMainThread(); }, 1500);
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSync(t: Topology) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { send({ type: 'sync', topo: t }); saveTopology(t); }, 60);
}

export const useStore = create<State>((set, get) => ({
  topology: loadTopology(),
  selection: null,
  running: false,
  speed: 5,
  simTime: 0,
  achieved: 0,
  history: [],
  latest: null,
  events: [],
  unseenEvents: 0,
  failures: [],
  pending: [],
  dockTab: 'charts',
  dockOpen: true,
  toast: null,
  activeScenario: null,
  bottleneckId: null,
  lang: PREFS.lang,
  theme: PREFS.theme,
  loadSeq: 0,
  flowWidth: PREFS.flowWidth,
  edgeRate: {},
  edgePeak: 0,
  calOpen: false,
  calBackup: null,
  calPreset: null,
  setCalOpen: (open, preset) => set({ calOpen: open, calPreset: open ? preset ?? null : null }),
  applyCalibrated: (t) => {
    const prev = get().topology;
    get().setTopology(t, { reset: true });
    set({ calBackup: prev });
  },
  undoCalibration: () => {
    const b = get().calBackup;
    if (!b) return;
    get().setTopology(b, { reset: true });
  },

  setFlowWidth: (on) => {
    set({ flowWidth: on });
    savePrefs({ lang: get().lang, theme: get().theme, flowWidth: on });
  },

  setLang: (l) => {
    if (l === get().lang) return;
    const t = translateTopology(get().topology, l);
    set({ lang: l, topology: t });
    savePrefs({ lang: l, theme: get().theme, flowWidth: get().flowWidth });
    scheduleSync(t);
  },
  setTheme: (th) => {
    set({ theme: th });
    savePrefs({ lang: get().lang, theme: th, flowWidth: get().flowWidth });
  },
  setTopology: (t, opts) => {
    set({ topology: t, selection: null, loadSeq: get().loadSeq + 1, edgeRate: {}, edgePeak: 0, calBackup: null });
    saveTopology(t);
    if (opts?.reset) get().reset();
    else scheduleSync(t);
  },
  updateNode: (id, patch) => {
    const t = get().topology;
    const nt = { ...t, nodes: t.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) };
    set({ topology: nt });
    scheduleSync(nt);
  },
  updateNodeParams: (id, params) => {
    const t = get().topology;
    const nt = { ...t, nodes: t.nodes.map((n) => (n.id === id ? { ...n, params: { ...n.params, ...params } } : n)) };
    set({ topology: nt });
    scheduleSync(nt);
  },
  updateEdgeParams: (id, params) => {
    const t = get().topology;
    const nt = { ...t, edges: t.edges.map((e) => (e.id === id ? { ...e, params: { ...e.params, ...params } } : e)) };
    set({ topology: nt });
    scheduleSync(nt);
  },
  addNode: (n) => {
    const t = get().topology;
    const nt = { ...t, nodes: [...t.nodes, n] };
    set({ topology: nt, selection: { kind: 'node', id: n.id } });
    scheduleSync(nt);
  },
  addEdge: (e) => {
    const t = get().topology;
    const nt = { ...t, edges: [...t.edges, e] };
    set({ topology: nt, selection: { kind: 'edge', id: e.id } });
    scheduleSync(nt);
  },
  removeNodes: (ids) => {
    const t = get().topology;
    const s = new Set(ids);
    const nt = { ...t, nodes: t.nodes.filter((n) => !s.has(n.id)), edges: t.edges.filter((e) => !s.has(e.from) && !s.has(e.to)) };
    const sel = get().selection;
    set({ topology: nt, selection: sel && s.has(sel.id) ? null : sel });
    scheduleSync(nt);
  },
  removeEdges: (ids) => {
    const t = get().topology;
    const s = new Set(ids);
    const nt = { ...t, edges: t.edges.filter((e) => !s.has(e.id)) };
    const sel = get().selection;
    set({ topology: nt, selection: sel && s.has(sel.id) ? null : sel });
    scheduleSync(nt);
  },
  select: (s) => set({ selection: s }),
  run: () => { send({ type: 'run' }); set({ running: true }); },
  pause: () => { send({ type: 'pause' }); set({ running: false }); },
  toggle: () => (get().running ? get().pause() : get().run()),
  reset: () => {
    send({ type: 'pause' });
    send({ type: 'reset', topo: get().topology });
    set({ running: false, simTime: 0, history: [], latest: null, events: [], unseenEvents: 0, failures: [], pending: [], activeScenario: null, bottleneckId: null, edgeRate: {}, edgePeak: 0, loadScale: 1 });
  },
  setSpeed: (v) => { send({ type: 'speed', value: v }); set({ speed: v }); },
  loadScale: 1,
  setLoadScale: (v) => { send({ type: 'loadScale', value: v }); set({ loadScale: v }); },
  inject: (spec, at_s) => send({ type: 'inject', spec, at_s }),
  clearFailure: (id) => send({ type: 'clearFailure', id }),
  setDock: (tab) => {
    if (tab === null) set({ dockOpen: !get().dockOpen });
    else set({ dockTab: tab, dockOpen: true, unseenEvents: tab === 'events' ? 0 : get().unseenEvents });
  },
  showToast: (text, tone = 'info') => {
    const id = Date.now();
    set({ toast: { text, tone, id } });
    setTimeout(() => { if (get().toast?.id === id) set({ toast: null }); }, 3200);
  },
  setScenario: (id) => set({ activeScenario: id }),
}));

const EDGE_EMA = 1 - Math.exp(-1 / 3);
let lastFp = '';
function onHostMessage(ev: MessageEvent) {
  const m = ev.data;
  if (m.type === 'tick') { gotTick = true; sent.length = 0; }
  if (m.type === 'error') { console.error('[sim worker]', m.message); useStore.getState().showToast(useStore.getState().lang === 'en' ? 'The simulator hit an error and paused. See the browser console.' : '仿真引擎出错，已暂停。详情见浏览器控制台', 'warn'); useStore.setState({ running: false }); return; }
  if (m.type !== 'tick') return;
  const st = useStore.getState();
  const patch: Partial<State> = {};
  if (m.now !== st.simTime) { patch.simTime = m.now; patch.achieved = m.achieved; }
  const fp = JSON.stringify(m.failures) + JSON.stringify(m.pending);
  if (fp !== lastFp) { lastFp = fp; patch.failures = m.failures; patch.pending = m.pending; }
  if (m.snaps.length) {
    const h = st.history.concat(m.snaps);
    patch.history = h.length > HISTORY ? h.slice(h.length - HISTORY) : h;
    const latest = m.snaps[m.snaps.length - 1] as Snapshot;
    patch.latest = latest;
    // Smooth each edge's calls/s (EMA, ~3 s) so widths don't flicker with Poisson noise,
    // and track the run's peak as a stable reference: one edge spiking never thins the others.
    const rate: Record<string, number> = { ...st.edgeRate };
    let peak = st.edgePeak;
    for (const snap of m.snaps as Snapshot[]) {
      for (const [eid, es] of Object.entries(snap.edges)) {
        const prev = rate[eid];
        const v = prev === undefined ? es.calls : prev + EDGE_EMA * (es.calls - prev);
        rate[eid] = v;
        if (v > peak) peak = v;
      }
    }
    patch.edgeRate = rate;
    patch.edgePeak = peak;
    let best: string | null = null;
    let bv = 0.6;
    for (const n of st.topology.nodes) {
      if (n.type === 'client' || n.type === 'lb' || n.type === 'queue') continue;
      const s = latest.nodes[n.id];
      if (!s) continue;
      const v = Math.max(s.util, s.cpu);
      if (v > bv) { bv = v; best = n.id; }
    }
    patch.bottleneckId = best;
  }
  if (m.events.length) {
    const e = st.events.concat(m.events);
    patch.events = e.length > 400 ? e.slice(e.length - 400) : e;
    if (!(st.dockOpen && st.dockTab === 'events')) patch.unseenEvents = st.unseenEvents + m.events.length;
  }
  if (Object.keys(patch).length) useStore.setState(patch);
}
if (worker) worker.onmessage = onHostMessage;

// boot
send({ type: 'reset', topo: useStore.getState().topology });
send({ type: 'speed', value: useStore.getState().speed });
