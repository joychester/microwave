// Calibration round trip:
//   1. take the reference topology and change it into a hidden "production" (slower services,
//      different pods, a slower database, more traffic),
//   2. "measure" production by simulating it, the way you'd export metrics from a peak hour,
//   3. calibrate the untouched template against those measurements,
//   4. check that the simulator now reproduces the measurements, and that the hidden parameters
//      were recovered.
//   npx tsx scripts/check-calibration.ts
import { Simulator } from '../src/engine/sim';
import { referenceTopology } from '../src/engine/presets';
import { calibrate, parseCalibrationCsv, templateCsv, verifyCalibration } from '../src/engine/calibrate';
import { mean } from '../src/engine/dist';
import { defaultLayer } from '../src/engine/traffic';
import type { Dist, Topology } from '../src/engine/types';

const template = referenceTopology('en');
const truth: Topology = JSON.parse(JSON.stringify(template));
const node = (t: Topology, id: string) => t.nodes.find((n) => n.id === id)!;
const scale = (d: Dist, k: number): Dist => (d.dist === 'lognormal' ? { ...d, median: d.median * k, p99: d.p99 * k } : d);

node(truth, 'client').params.traffic = { base: defaultLayer('constant', { rps: 620 }), overlays: [] };
node(truth, 'product').params.serviceTime = scale(node(truth, 'product').params.serviceTime as Dist, 1.8);
node(truth, 'product').params.cpuFraction = 0.45;
node(truth, 'product').params.instances = 8;
node(truth, 'order').params.serviceTime = scale(node(truth, 'order').params.serviceTime as Dist, 0.7);
node(truth, 'order').params.instances = 4;
node(truth, 'order').params.cpuFraction = 0.5;
node(truth, 'pg').params.readTime = scale(node(truth, 'pg').params.readTime as Dist, 1.5);
node(truth, 'pg').params.writeTime = scale(node(truth, 'pg').params.writeTime as Dist, 1.5);
node(truth, 'redis').params.opLatency = scale(node(truth, 'redis').params.opLatency as Dist, 2);

// "measure production"
const sim = new Simulator(truth, 101);
sim.advance(15_000); sim.drainSnapshots();
sim.advance(90_000);
const snaps = sim.drainSnapshots();
const avg = (id: string, f: (s: (typeof snaps)[0]['nodes'][string]) => number) => snaps.reduce((a, s) => a + f(s.nodes[id]), 0) / snaps.length;
const meanLat = (id: string) => {
  const c = snaps.reduce((a, s) => a + s.nodes[id].ok + s.nodes[id].err, 0);
  return snaps.reduce((a, s) => a + (s.nodes[id].mean ?? 0) * (s.nodes[id].ok + s.nodes[id].err), 0) / c;
};
const P = (id: string) => node(truth, id).params;
const csv = [
  'name,type,qps,avg_ms,p99_ms,cpu_util,pods,cores_per_pod,threads_per_pod,db_pool_per_pod,max_connections,hit_ratio',
  `User traffic,client,${avg('client', (s) => s.arr).toFixed(0)}`,
  `API Gateway,gateway,${avg('gw', (s) => s.arr).toFixed(0)},${meanLat('gw').toFixed(1)}`,
  `Catalog service,service,${avg('product', (s) => s.arr).toFixed(0)},${meanLat('product').toFixed(1)},,${avg('product', (s) => s.cpu).toFixed(3)},${P('product').instances},${P('product').cpuCores ?? 2},,`,
  `Orders service,service,${avg('order', (s) => s.arr).toFixed(0)},${meanLat('order').toFixed(1)},,${avg('order', (s) => s.cpu).toFixed(3)},${P('order').instances},${P('order').cpuCores ?? 2},,`,
  `Postgres,database,${avg('pg', (s) => s.arr).toFixed(0)},${meanLat('pg').toFixed(2)}`,
  `Redis,cache,${avg('redis', (s) => s.arr).toFixed(0)},${mean(P('redis').opLatency as Dist).toFixed(3)}`,
].join('\n');
console.log('--- measured CSV ---\n' + csv);

const { rows, errors } = parseCalibrationCsv(csv);
if (errors.length) console.log('parse notes:', errors.map((e) => e.en));
const res = calibrate(template, rows, { source: 'check-calibration' });
console.log(`\nconverged=${res.converged} iterations=${res.iterations} unmatched=${res.unmatched.map((r) => r.name).join(',') || '-'}`);
console.log('--- changes ---');
for (const c of res.changes) console.log(`${c.nodeName.padEnd(16)} ${c.what.en.padEnd(24)} ${c.from} → ${c.to}`);
console.log('--- warnings ---');
for (const w of res.warnings) console.log(`${w.nodeName ?? ''}: ${w.text.en}`);

const v = verifyCalibration(res.topology, res.matches);
console.log('--- verification (simulated vs measured) ---');
for (const l of v.lines) console.log(`${l.nodeName.padEnd(16)} ${l.metric.padEnd(9)} measured=${l.measured.toFixed(3).padStart(9)} sim=${l.simulated.toFixed(3).padStart(9)} err=${(l.error * 100).toFixed(1)}%`);
console.log(`median error ${(v.medianError * 100).toFixed(1)}%, max ${(v.maxError * 100).toFixed(1)}%`);

const got = (id: string) => node(res.topology, id).params;
const recovered = [
  ['Catalog own time', mean(got('product').serviceTime as Dist), mean(P('product').serviceTime as Dist)],
  ['Catalog CPU share', Number(got('product').cpuFraction), 0.45],
  ['Orders own time', mean(got('order').serviceTime as Dist), mean(P('order').serviceTime as Dist)],
  ['Orders CPU share', Number(got('order').cpuFraction), 0.5],
  ['Postgres read', mean(got('pg').readTime as Dist), mean(P('pg').readTime as Dist)],
] as const;
console.log('--- recovered vs hidden truth ---');
let bad = 0;
for (const [label, a, b] of recovered) {
  const e = Math.abs(a - b) / b;
  if (e > 0.2) bad++;
  console.log(`${label.padEnd(18)} recovered=${a.toFixed(3).padStart(8)} truth=${b.toFixed(3).padStart(8)} err=${(e * 100).toFixed(1)}%`);
}
console.log('\n--- template CSV for the reference topology ---\n' + templateCsv(template));
const ok = v.medianError < 0.1 && bad === 0;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
