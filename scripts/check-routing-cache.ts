// Checks weighted exclusive routing and the capacity-based cache warm-up.
import { Simulator } from '../src/engine/sim';
import { analyze } from '../src/engine/analysis';
import { defaultParams, edgeDefaultsFor, NODE_SPECS } from '../src/engine/specs';
import { referenceTopology } from '../src/engine/presets';
import type { EdgeCfg, NodeCfg, NodeType, Params, Topology } from '../src/engine/types';

const N = (id: string, type: NodeType, params: Params = {}): NodeCfg => ({ id, type, name: id, x: 0, y: 0, params: { ...defaultParams(NODE_SPECS[type].params), ...params } });
const E = (a: NodeCfg, b: NodeCfg, params: Params = {}): EdgeCfg => ({ id: `${a.id}->${b.id}`, from: a.id, to: b.id, params: { ...edgeDefaultsFor(a.type, b.type), ...params } });

// 1) LB canary 90/10, gateway tie 70/30, service choice 80/20
const c = N('c', 'client', { rps: 1000, mix: '/x:1' });
const gw = N('gw', 'gateway');
const lb = N('lb', 'lb');
const v1 = N('v1', 'service', { instances: 6 }), v2 = N('v2', 'service', { instances: 2 });
const a = N('a', 'service', { instances: 6 }), b = N('b', 'service', { instances: 6 });
const p = N('p', 'service', { instances: 4 }), q = N('q', 'service', { instances: 4 }), always = N('always', 'service', { instances: 4 });
const topo: Topology = {
  name: 't', nodes: [c, gw, lb, v1, v2, a, b, p, q, always],
  edges: [
    E(c, gw), E(gw, lb, { match: '/x', weight: 50 }), E(gw, a, { match: '/x', weight: 35 }), E(gw, b, { match: '/x', weight: 15 }),
    E(lb, v1, { weight: 90 }), E(lb, v2, { weight: 10 }),
    E(a, p, { choice: true, weight: 80 }), E(a, q, { choice: true, weight: 20 }), E(a, always, { order: 0 }),
  ],
};
const sim = new Simulator(topo, 3);
sim.advance(30_000);
const snaps = sim.drainSnapshots().slice(5);
const avg = (id: string) => snaps.reduce((s, x) => s + (x.nodes[id]?.arr ?? 0), 0) / snaps.length;
console.log('gw→ lb/a/b =', ['lb', 'a', 'b'].map((x) => avg(x).toFixed(0)).join(' / '), '(expect 500 / 350 / 150)');
console.log('lb→ v1/v2  =', avg('v1').toFixed(0), '/', avg('v2').toFixed(0), '(expect 450 / 50)');
console.log('a → p/q/always =', avg('p').toFixed(0), '/', avg('q').toFixed(0), '/', avg('always').toFixed(0), '(expect 280 / 70 / 350)');
const an = analyze(topo);
console.log('analysis λ:', ['lb', 'v1', 'v2', 'a', 'b', 'p', 'q', 'always'].map((id) => `${id}=${an.nodes.find((n) => n.id === id)!.lambda.toFixed(0)}`).join(' '));

// 2) cache warm-up after a flush, healthy DB vs weak DB (feedback loop)
for (const [label, pgWorkers] of [['healthy DB (8 workers)', 8], ['weak DB (4 workers)', 4]] as const) {
  const t = referenceTopology('en');
  const redis = t.nodes.find((n) => n.id === 'redis')!;
  Object.assign(redis.params, { hitMode: 'capacity' });
  Object.assign(t.nodes.find((n) => n.id === 'pg')!.params, { workers: pgWorkers });
  const s = new Simulator(t, 4);
  s.advance(30_000);
  s.inject({ id: 'f', nodeId: 'redis', kind: 'flush', params: {}, duration_s: 2, recovery_s: 0 });
  s.advance(300_000);
  const sn = s.drainSnapshots();
  const line = [25, 33, 40, 50, 70, 100, 150, 220, 300].map((tt) => {
    const x = sn.find((y) => y.t === tt)!;
    return `t${tt}:hit${(x.nodes.redis.extra.hitRatio * 100).toFixed(0)}/fill${(x.nodes.redis.extra.fill * 100).toFixed(0)}%/pg${(x.nodes.pg.util * 100).toFixed(0)}%/av${(x.sys.avail * 100).toFixed(0)}`;
  });
  console.log(label.padEnd(24), line.join('  '));
}
