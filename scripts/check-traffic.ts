// Sanity check for traffic models and multi-source superposition.
import { Simulator } from '../src/engine/sim';
import { MODELS, defaultLayer, evalProgram } from '../src/engine/traffic';
import { multiSourceTopology } from '../src/engine/presets';

for (const m of MODELS.filter((x) => x.role === 'base')) {
  const prog = { base: defaultLayer(m.kind), overlays: [] };
  const vals = [0, 30, 60, 120, 180, 240, 300].map((t) => Math.round(evalProgram(prog, t)));
  console.log(m.kind.padEnd(9), vals.join(' '));
}
for (const m of MODELS.filter((x) => x.role === 'overlay')) {
  const prog = { base: defaultLayer('constant', { rps: 400 }), overlays: [defaultLayer(m.kind)] };
  const vals = [0, 30, 60, 70, 80, 90, 100, 120, 150].map((t) => Math.round(evalProgram(prog, t)));
  console.log(('+' + m.kind).padEnd(9), vals.join(' '));
}
const topo = multiSourceTopology('en');
const sim = new Simulator(topo, 5);
sim.advance(300_000);
const snaps = sim.drainSnapshots();
for (const t of [10, 60, 119, 125, 140, 200, 280]) {
  const s = snaps.find((x) => x.t === t)!;
  const n = (id: string) => s.nodes[id];
  console.log(`t=${t} user=${n('client').arr} batch=${n('batch').arr} push=${n('push').arr} -> gw=${n('gw').arr} order=${n('order').arr} product=${n('product').arr} pg=${n('pg').arr} avail=${(s.sys.avail * 100).toFixed(1)}% p99=${s.sys.p99.toFixed(0)}`);
}
