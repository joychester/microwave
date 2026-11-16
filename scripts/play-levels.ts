// Headless balance check: plays each level with "do nothing" and with a reasonable fix.
//   npx tsx scripts/play-levels.ts [levelId]
import { Simulator } from '../src/engine/sim';
import { costPerHour } from '../src/engine/cost';
import { edgeDefaultsFor, defaultParams, NODE_SPECS } from '../src/engine/specs';
import type { Topology } from '../src/engine/types';
import { LEVELS, planFaults, trafficAt, type Level } from '../src/game/levels';
import { finalize, initRun, stepRun } from '../src/game/rules';

type Fix = (t: Topology) => void;
const node = (t: Topology, id: string) => t.nodes.find((n) => n.id === id)!;
const edge = (t: Topology, from: string, to: string) => t.edges.find((e) => e.from === from && e.to === to)!;

const FIXES: Record<string, Fix> = {
  'scale-out': (t) => { node(t, 'api').params.instances = 5; },
  'db-relief': (t) => {
    t.nodes.push({ id: 'cache', type: 'cache', name: 'Redis', x: 800, y: 200, params: { ...defaultParams(NODE_SPECS.cache.params), hitRatio: 0.9, shards: 4 } });
    const old = edge(t, 'api', 'db');
    t.edges = t.edges.filter((e) => e !== old);
    t.edges.push({ id: 'api->cache', from: 'api', to: 'cache', params: { ...edgeDefaultsFor('service', 'cache'), callsPerRequest: old.params.callsPerRequest, poolSize: 20 } });
    t.edges.push({ id: 'cache->db', from: 'cache', to: 'db', params: { ...edgeDefaultsFor('cache', 'database') } });
  },
  'retry-storm': (t) => {
    Object.assign(edge(t, 'order', 'product').params, { cbEnabled: true, cbFallback: 'success', maxAttempts: 1, cbOpen: 10 });
    Object.assign(node(t, 'product').params, { queueTimeout: 250 });
  },
  'black-friday': (t) => {
    Object.assign(node(t, 'product').params, { instances: 6, asEnabled: true, asMin: 6, asMax: 14, asTarget: 0.6, asColdStart: 20 });
    Object.assign(node(t, 'order').params, { instances: 4, asEnabled: true, asMin: 4, asMax: 8, asTarget: 0.6 });
    Object.assign(node(t, 'fulfill').params, { instances: 7 });
    Object.assign(node(t, 'pg').params, { workers: 14 });
    Object.assign(node(t, 'kafka').params, { partitions: 16, consumers: 16 });
  },
  chaos: (t) => {
    Object.assign(node(t, 'product').params, { instances: 7, queueTimeout: 300 });
    Object.assign(node(t, 'order').params, { instances: 4 });
    Object.assign(node(t, 'fulfill').params, { instances: 5 });
    Object.assign(node(t, 'pg').params, { workers: 12 });
    Object.assign(node(t, 'lb-order').params, { algorithm: 'least_conn', hcInterval: 3, hcThreshold: 2 });
    Object.assign(node(t, 'lb-product').params, { algorithm: 'least_conn', hcInterval: 3, hcThreshold: 2 });
    Object.assign(edge(t, 'order', 'product').params, { cbEnabled: true, cbFallback: 'success', maxAttempts: 2, retryBudget: 0.1 });
  },
};

function play(level: Level, fix?: Fix, seed = 1) {
  const topo = level.make('en');
  fix?.(topo);
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const faults = planFaults(level, rand);
  const sim = new Simulator(topo, 3);
  let run = initRun(level);
  const client = topo.nodes.find((n) => n.type === 'client')!;
  for (let t = 0; t < level.duration && !run.over; t++) {
    client.params = { ...client.params, rps: trafficAt(level, t + 0.5) };
    sim.sync(topo);
    for (const f of faults) if (f.at === t) sim.inject({ ...f.spec, id: `f${t}` });
    sim.advance((t + 1) * 1000);
    for (const snap of sim.drainSnapshots()) run = stepRun(level, run, snap, costPerHour(topo, snap.nodes).total);
  }
  const startCost = costPerHour(topo).total;
  return { res: finalize(level, run), run, startCost };
}

for (const level of LEVELS) {
  if (process.argv[2] && process.argv[2] !== level.id) continue;
  const seeds = level.chaos ? [1, 7, 42] : [1];
  for (const [label, fix, seed] of seeds.flatMap((sd) => [['do nothing', undefined, sd], ['fixed', FIXES[level.id], sd]] as const)) {
    const t0 = Date.now();
    const { res, run, startCost } = play(level, fix, seed);
    console.log(
      `${level.id.padEnd(13)} ${label.padEnd(10)} ${res.won ? 'WON ' : 'LOST'} ${'★'.repeat(res.stars).padEnd(3)} score=${String(res.score).padStart(4)}` +
      ` t=${run.seconds}s hp=${(res.reliability * 100).toFixed(0)}% lat=${(res.latencyShare * 100).toFixed(0)}% cost=$${res.avgCost.toFixed(2)} (start $${startCost.toFixed(2)}, budget $${level.budget})` +
      `${level.lagGoal ? ` lag=${run.lastLag}` : ''} reason=${res.reason ?? '-'} (${Date.now() - t0}ms)`,
    );
  }
}
