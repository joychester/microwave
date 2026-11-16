// Scoring rules, shared by the browser game and the headless balance tests.
import type { Snapshot } from '../engine/types';
import { expectedRequests, type Level } from './levels';

export interface RunState {
  seconds: number;
  requests: number;
  failures: number;
  allowed: number; // error budget in failed requests
  hp: number; // 0..1 remaining error budget
  slowSeconds: number; // seconds whose p99 broke the latency SLO
  costSum: number; // Σ $/h per second, for the average
  lastLag: number;
  over: boolean;
  lostReason?: 'budget' | null;
}

export interface RunResult {
  won: boolean;
  stars: 0 | 1 | 2 | 3;
  score: number;
  reliability: number; // 0..1 (remaining error budget)
  latencyShare: number; // 0..1 seconds within p99 SLO
  avgCost: number;
  costOk: boolean;
  lagOk: boolean;
  reason?: 'errors' | 'cost' | 'lag';
  parts: { reliability: number; latency: number; cost: number };
}

export function initRun(level: Level): RunState {
  const allowed = Math.max(20, (1 - level.slo.avail) * expectedRequests(level) * level.errorBudgetFactor);
  return { seconds: 0, requests: 0, failures: 0, allowed, hp: 1, slowSeconds: 0, costSum: 0, lastLag: 0, over: false };
}

export function stepRun(level: Level, run: RunState, snap: Snapshot, costPerHour: number): RunState {
  if (run.over) return run;
  const r = { ...run };
  r.seconds += 1;
  r.requests += snap.sys.req;
  r.failures += snap.sys.fail;
  r.hp = Math.max(0, 1 - r.failures / r.allowed);
  if (snap.sys.req > 0 && snap.sys.p99 > level.slo.p99) r.slowSeconds += 1;
  r.costSum += costPerHour;
  if (level.lagGoal) r.lastLag = snap.nodes[level.lagGoal.nodeId]?.extra.lag ?? 0;
  if (r.hp <= 0) { r.over = true; r.lostReason = 'budget'; }
  if (r.seconds >= level.duration) r.over = true;
  return r;
}

export function finalize(level: Level, run: RunState): RunResult {
  const reliability = run.hp;
  const latencyShare = run.seconds > 0 ? 1 - run.slowSeconds / run.seconds : 0;
  const avgCost = run.seconds > 0 ? run.costSum / run.seconds : 0;
  const costOk = avgCost <= level.budget + 1e-9;
  const lagOk = !level.lagGoal || run.lastLag <= level.lagGoal.max;
  const finished = run.seconds >= level.duration && run.hp > 0;
  const won = finished && costOk && lagOk;
  let reason: RunResult['reason'];
  if (!finished) reason = 'errors';
  else if (!costOk) reason = 'cost';
  else if (!lagOk) reason = 'lag';
  const costScore = Math.max(0, Math.min(1, ((level.budget - avgCost) / level.budget) * 2.5));
  const parts = {
    reliability: Math.round(500 * reliability),
    latency: Math.round(300 * latencyShare),
    cost: Math.round(200 * costScore),
  };
  const score = won ? parts.reliability + parts.latency + parts.cost : Math.round((parts.reliability + parts.latency) * 0.3);
  let stars: RunResult['stars'] = 0;
  if (won) {
    stars = 1;
    if (latencyShare >= 0.9) stars = 2;
    if (stars === 2 && avgCost <= level.budget * 0.8) stars = 3;
  }
  return { won, stars, score, reliability, latencyShare, avgCost, costOk, lagOk, reason, parts };
}
