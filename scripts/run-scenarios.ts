// Headless scenario runner: sanity-checks the engine and prints a time series summary.
//   npx tsx scripts/run-scenarios.ts [scenarioId]
import { Simulator } from '../src/engine/sim';
import { analyze } from '../src/engine/analysis';
import { SCENARIOS, TOPOLOGY_PRESETS } from '../src/engine/presets';
import type { Snapshot } from '../src/engine/types';

const only = process.argv[2];
const runFor = Number(process.argv[3] ?? 200);

function summarize(snaps: Snapshot[], ids: string[]) {
  for (let i = 0; i < snaps.length; i += 10) {
    const w = snaps.slice(i, i + 10);
    const req = w.reduce((s, x) => s + x.sys.req, 0);
    const ok = w.reduce((s, x) => s + x.sys.ok, 0);
    const p99 = Math.max(...w.map((x) => x.sys.p99));
    const amp = w.reduce((s, x) => s + x.sys.amplification, 0) / w.length;
    const last = w[w.length - 1];
    const parts = ids.map((id) => {
      const n = last.nodes[id];
      if (!n) return '';
      const ex = n.extra.lag !== undefined ? ` lag${n.extra.lag}` : n.extra.hitRatio !== undefined ? ` hit${(n.extra.hitRatio * 100).toFixed(0)}` : n.extra.conns !== undefined ? ` c${n.extra.conns}` : '';
      return `${id}:u${(n.util * 100).toFixed(0)}/cpu${(n.cpu * 100).toFixed(0)} q${n.queue} i${n.instances}${ex} e${n.err}`;
    });
    const causes = Object.entries(last.sys.causes).map(([k, v]) => `${k}=${v}`).join(',');
    console.log(`t=${String(w[0].t).padStart(4)} rps=${(req / w.length).toFixed(0).padStart(5)} avail=${(ok / Math.max(1, req) * 100).toFixed(2).padStart(6)}% p99=${p99.toFixed(0).padStart(6)}ms amp=${amp.toFixed(2)} | ${parts.join(' ')} ${causes}`);
  }
}

const topoMake = () => TOPOLOGY_PRESETS[0].make('en');
const a = analyze(topoMake());
console.log('=== analysis ===');
for (const n of a.nodes) console.log(`${n.name.padEnd(12)} λ=${n.lambda.toFixed(0).padStart(5)} util=${(n.util * 100).toFixed(0)}% (${n.utilKind.en}) R=${n.latency.toFixed(1)}ms ${n.note?.en ?? ''}`);
console.log(`bottleneck=${a.bottleneck?.name} maxRps=${a.maxRps.toFixed(0)} e2e=${a.e2eLatency.toFixed(1)}ms`);

const ids = ['gw', 'product', 'order', 'redis', 'pg', 'kafka', 'fulfill'];
for (const sc of [{ id: 'baseline', label: 'baseline', failure: null as null | (typeof SCENARIOS)[0]['failure'] }, ...SCENARIOS]) {
  if (only && sc.id !== only) continue;
  const sim = new Simulator(topoMake(), 11);
  const t0 = Date.now();
  sim.advance(60_000);
  if (sc.failure) sim.inject({ ...sc.failure, id: 'f1' });
  sim.advance(runFor * 1000);
  const ms = Date.now() - t0;
  console.log(`\n=== ${typeof sc.label === 'string' ? sc.label : sc.label.en} (${ms}ms wall for ${runFor}s sim) ===`);
  summarize(sim.drainSnapshots(), ids);
  for (const e of sim.drainEvents().slice(0, 25)) console.log(`  [${e.t.toFixed(0)}s] ${e.text.en}`);
}
