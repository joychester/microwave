// Challenge-mode controller. Lives beside the main store and reacts to its snapshots.
import { create } from 'zustand';
import { costPerHour } from '../engine/cost';
import type { Topology } from '../engine/types';
import { LEVELS, planFaults, trafficAt, type Level, type LevelFault } from '../game/levels';
import { finalize, initRun, stepRun, type RunResult, type RunState } from '../game/rules';
import { useStore } from './store';
import { play, setSoundEnabled } from './sound';

export type Phase = 'select' | 'brief' | 'deploy' | 'countdown' | 'playing' | 'over';

interface Progress { stars: number; best: number }

interface GameState {
  mode: 'sandbox' | 'challenge';
  phase: Phase;
  levelId: string | null;
  faults: LevelFault[];
  run: RunState | null;
  result: RunResult | null;
  countdown: number;
  progress: Record<string, Progress>;
  costNow: number;
  sound: boolean;
  backup: Topology | null;
  newBest: boolean;

  enterChallenge: () => void;
  exitChallenge: () => void;
  showSelect: () => void;
  openLevel: (id: string) => void;
  startDeploy: (fresh?: boolean) => void;
  startPlay: () => void;
  toggleSound: () => void;
}

const LS_PROGRESS = 'simbench.progress.v1';
const LS_SOUND = 'simbench.sound.v1';
function load<T>(k: string, d: T): T {
  try { const r = localStorage.getItem(k); return r ? (JSON.parse(r) as T) : d; } catch { return d; }
}
function save(k: string, v: unknown) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ }
}

export function levelById(id: string | null): Level | null {
  return LEVELS.find((l) => l.id === id) ?? null;
}

export function isUnlocked(id: string, progress: Record<string, Progress>): boolean {
  const i = LEVELS.findIndex((l) => l.id === id);
  if (i <= 0) return true;
  return (progress[LEVELS[i - 1].id]?.stars ?? 0) > 0;
}

let countdownTimer: ReturnType<typeof setInterval> | null = null;

export const useGame = create<GameState>((set, get) => ({
  mode: 'sandbox',
  phase: 'select',
  levelId: null,
  faults: [],
  run: null,
  result: null,
  countdown: 0,
  progress: load(LS_PROGRESS, {}),
  costNow: 0,
  sound: load(LS_SOUND, false),
  backup: null,
  newBest: false,

  enterChallenge: () => {
    const st = useStore.getState();
    st.pause();
    set({ mode: 'challenge', phase: 'select', backup: get().backup ?? st.topology, levelId: null, run: null, result: null });
    st.setScenario(null);
    st.select(null);
  },
  exitChallenge: () => {
    if (countdownTimer) clearInterval(countdownTimer);
    const st = useStore.getState();
    const b = get().backup;
    set({ mode: 'sandbox', levelId: null, run: null, result: null, backup: null, phase: 'select' });
    if (b) st.setTopology(b, { reset: true });
    else st.reset();
  },
  showSelect: () => {
    useStore.getState().pause();
    set({ phase: 'select', run: null, result: null });
  },
  openLevel: (id) => set({ levelId: id, phase: 'brief', run: null, result: null }),
  startDeploy: (fresh = true) => {
    const level = levelById(get().levelId);
    if (!level) return;
    const st = useStore.getState();
    if (fresh) {
      const topo = level.make(st.lang);
      const client = topo.nodes.find((n) => n.type === 'client');
      if (client) client.params = { ...client.params, rps: trafficAt(level, 0), sloAvail: level.slo.avail, sloP99: level.slo.p99, sloPct: 'p99', pattern: 'constant' };
      st.setTopology(topo, { reset: true });
    } else {
      st.reset();
    }
    set({ phase: 'deploy', run: null, result: null, faults: [], newBest: false });
  },
  startPlay: () => {
    const level = levelById(get().levelId);
    if (!level) return;
    set({ phase: 'countdown', countdown: 3 });
    play('tick');
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      const c = get().countdown - 1;
      if (c > 0) { set({ countdown: c }); play('tick'); return; }
      clearInterval(countdownTimer!);
      countdownTimer = null;
      play('go');
      const st = useStore.getState();
      if (st.speed > 2) st.setSpeed(2);
      const client = st.topology.nodes.find((n) => n.type === 'client');
      if (client) st.updateNodeParams(client.id, { rps: trafficAt(level, 0.5) });
      st.reset();
      const faults = planFaults(level);
      // wait for the reset + sync to land before scheduling
      setTimeout(() => {
        faults.forEach((f, i) => st.inject({ ...f.spec, id: `lvl-${i}-${f.at}` }, f.at));
        set({ phase: 'playing', countdown: 0, faults, run: initRun(level), result: null });
        st.run();
      }, 120);
    }, 800);
  },
  toggleSound: () => {
    const on = !get().sound;
    setSoundEnabled(on);
    save(LS_SOUND, on);
    set({ sound: on });
    if (on) play('click');
  },
}));

setSoundEnabled(useGame.getState().sound);

// ---------------------------------------------------------------- per-second game tick
useStore.subscribe((s, prev) => {
  if (s.history === prev.history) return;
  const g = useGame.getState();
  const level = levelById(g.levelId);
  // live cost is useful in both modes
  const cost = s.latest ? costPerHour(s.topology, s.latest.nodes).total : costPerHour(s.topology).total;
  if (Math.abs(cost - g.costNow) > 1e-6) useGame.setState({ costNow: cost });
  if (g.mode !== 'challenge' || g.phase !== 'playing' || !level || !g.run) return;

  // newly arrived snapshots (history is capped, so track by sim second)
  const newSnaps = [];
  for (let i = s.history.length - 1; i >= 0 && s.history[i].t > g.run.seconds; i--) newSnaps.unshift(s.history[i]);
  let run = g.run;
  for (const snap of newSnaps) run = stepRun(level, run, snap, costPerHour(s.topology, snap.nodes).total);

  // drive the traffic curve one second ahead
  const t = s.simTime / 1000;
  const client = s.topology.nodes.find((n) => n.type === 'client');
  if (client) {
    const want = Math.round(trafficAt(level, t + 0.5));
    if (Math.abs(Number(client.params.rps) - want) >= 1) s.updateNodeParams(client.id, { rps: want });
  }

  if (run.over) {
    s.pause();
    const result = finalize(level, run);
    const prevBest = g.progress[level.id];
    const progress = { ...g.progress };
    const newBest = !prevBest || result.score > prevBest.best;
    if (result.won) progress[level.id] = { stars: Math.max(prevBest?.stars ?? 0, result.stars), best: Math.max(prevBest?.best ?? 0, result.score) };
    save(LS_PROGRESS, progress);
    useGame.setState({ run, result, phase: 'over', progress, newBest: result.won && newBest });
    play(result.won ? 'win' : 'lose');
    return;
  }
  useGame.setState({ run });
});

// ---------------------------------------------------------------- sound hooks for engine events
useStore.subscribe((s, prev) => {
  if (s.events === prev.events || s.events.length === 0) return;
  const lastPrev = prev.events[prev.events.length - 1];
  const idx = lastPrev ? s.events.lastIndexOf(lastPrev) : -1;
  const fresh = s.events.slice(idx + 1);
  for (const e of fresh) {
    switch (e.code) {
      case 'fault_start': play('alarm'); break;
      case 'cb_open': play('breaker'); break;
      case 'scale_up': play('scaleUp'); break;
      case 'scale_down': play('scaleDown'); break;
      case 'conn_limit': play('warn'); break;
      case 'fault_end': play('recover'); break;
    }
  }
});
