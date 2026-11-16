// Simulation host: owns the Simulator, advances it in real time, and posts ticks.
// Runs inside a Web Worker (worker-entry.ts) or, as a fallback, on the main thread.
import { Simulator } from './sim';
import type { FailureSpec, Topology } from './types';

export type ToWorker =
  | { type: 'reset'; topo: Topology; seed?: number }
  | { type: 'sync'; topo: Topology }
  | { type: 'run' }
  | { type: 'pause' }
  | { type: 'speed'; value: number }
  | { type: 'inject'; spec: FailureSpec; at_s?: number }
  | { type: 'clearFailure'; id: string };

export function createHost(post: (m: unknown) => void, maxEvents = 600_000) {
let sim: Simulator | null = null;
let running = false;
let speed = 5;
let lastWall = performance.now();
let achieved = 0;
let pending: { spec: FailureSpec; at: number }[] = [];
let lastTopo: Topology | null = null;


function flush() {
  if (!sim) return;
  post({
    type: 'tick',
    now: sim.now,
    running,
    achieved,
    snaps: sim.drainSnapshots(),
    events: sim.drainEvents(),
    failures: sim.activeFailures().map(({ id, nodeId, kind, params, duration_s, recovery_s, start, end }) => ({ id, nodeId, kind, params, duration_s, recovery_s, start, end: end === Infinity ? -1 : end })),
    pending: pending.map((p) => ({ id: p.spec.id, nodeId: p.spec.nodeId, kind: p.spec.kind, at: p.at })),
  });
}

function loop() {
  try { step(); } catch (err) { running = false; post({ type: 'error', message: String((err as Error)?.stack ?? err) }); }
  setTimeout(loop, 50);
}

function step() {
  const wall = performance.now();
  const dt = Math.min(250, wall - lastWall);
  lastWall = wall;
  if (sim && running) {
    const before = sim.now;
    const target = before + dt * speed;
    // never step past a scheduled injection
    const due = pending.filter((p) => p.at <= target).sort((a, b) => a.at - b.at)[0];
    const stepTo = due ? Math.max(before, due.at) : target;
    const t0 = performance.now();
    sim.advance(stepTo, maxEvents);
    if (due && sim.now >= due.at) {
      pending = pending.filter((p) => p !== due);
      sim.inject(due.spec);
    }
    const cost = performance.now() - t0;
    const simAdvanced = sim.now - before;
    const inst = dt > 0 ? simAdvanced / dt : 0;
    achieved = achieved * 0.8 + inst * 0.2;
    void cost;
  }
  flush();
}


function handle(m: ToWorker) {
  switch (m.type) {
    case 'reset':
      lastTopo = m.topo;
      sim = new Simulator(m.topo, m.seed ?? 7);
      pending = [];
      achieved = 0;
      flush();
      break;
    case 'sync':
      lastTopo = m.topo;
      if (!sim) sim = new Simulator(m.topo);
      else sim.sync(m.topo);
      break;
    case 'run':
      if (!sim && lastTopo) sim = new Simulator(lastTopo);
      running = true;
      lastWall = performance.now();
      break;
    case 'pause':
      running = false;
      break;
    case 'speed':
      speed = m.value;
      break;
    case 'inject':
      if (!sim) break;
      if (m.at_s !== undefined && m.at_s * 1000 > sim.now) pending.push({ spec: m.spec, at: m.at_s * 1000 });
      else sim.inject(m.spec);
      flush();
      break;
    case 'clearFailure':
      pending = pending.filter((p) => p.spec.id !== m.id);
      sim?.clearFailure(m.id);
      flush();
      break;
  }
}

setTimeout(loop, 50);
return (m: ToWorker) => {
  try { handle(m); } catch (err) { post({ type: 'error', message: String((err as Error)?.stack ?? err) }); }
};
}
