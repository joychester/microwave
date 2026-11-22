// What a fault looks like before you inject it: its level over time (for the curve) and a steady-state
// estimate of what it does to the component and the ones most affected around it. The estimate runs
// the capacity formulas (analysis.ts) on a copy of the topology with the fault applied, so it is
// instant but leaves out what only the simulation shows: retries, timeouts and the transient pile-up.

import { analyze } from '../engine/analysis';
import { NODE_SPECS, withDefaults } from '../engine/specs';
import { defaultLayer, evalProgram, isProgram } from '../engine/traffic';
import { L, type Dist, type NodeCfg, type Params, type Text, type Topology } from '../engine/types';

const scaleDist = (d: Dist, m: number): Dist =>
  d.dist === 'constant' ? { dist: 'constant', value: d.value * m }
    : d.dist === 'exponential' ? { dist: 'exponential', mean: d.mean * m }
      : { dist: 'lognormal', median: d.median * m, p99: d.p99 * m };

/** The fault's level as a short label for the curve: "×8", "−1 instance", "30%", or "" for on/off faults. */
export function faultLevel(kind: string, v: Record<string, number>): Text | null {
  if (v.multiplier !== undefined) return L(`×${fmtNum(v.multiplier)}`, `×${fmtNum(v.multiplier)}`);
  if (kind === 'instanceDown') return L(`−${v.count} 个实例`, `−${v.count} instance${v.count === 1 ? '' : 's'}`);
  if (kind === 'consumerCrash') return L(`−${v.count} 个消费者`, `−${v.count} consumer${v.count === 1 ? '' : 's'}`);
  if (kind === 'errorSpike') return L(`${pct(v.rate)} 出错`, `${pct(v.rate)} errors`);
  if (kind === 'hotKey') return L(`${pct(v.share)} 打到一个分片`, `${pct(v.share)} on one shard`);
  if (kind === 'quotaCut') return L(`配额剩 ${pct(v.share)}`, `${pct(v.share)} of quota left`);
  if (kind === 'lockContention') return L(`α = ${fmtNum(v.alpha)}`, `α = ${fmtNum(v.alpha)}`);
  return null;
}
const pct = (x: number) => `${Math.round(x * 100)}%`;
const fmtNum = (x: number) => String(+x.toFixed(2));

/** A copy of the topology with the fault's steady effect applied, or null when there's no formula for it. */
function withFault(topo: Topology, node: NodeCfg, kind: string, v: Record<string, number>, tSec: number): Topology | null {
  const p = withDefaults(NODE_SPECS[node.type].params, node.params);
  const set = (patch: Params): Topology => ({ ...topo, nodes: topo.nodes.map((n) => (n.id === node.id ? { ...n, params: { ...n.params, ...patch } } : n)) });
  const m = v.multiplier ?? 1;
  switch (`${node.type}:${kind}`) {
    case 'service:slow': return set({ serviceTime: scaleDist(p.serviceTime as Dist, m) });
    case 'database:slowQuery': return set({ readTime: scaleDist(p.readTime as Dist, m), writeTime: scaleDist(p.writeTime as Dist, m) });
    case 'external:slow': return set({ latency: scaleDist(p.latency as Dist, m) });
    case 'external:quotaCut': return set({ quotaRps: Number(p.quotaRps) * v.share });
    case 'service:instanceDown':
    case 'gateway:instanceDown': return set({ instances: Number(p.instances) - v.count });
    case 'queue:consumerCrash': return set({ consumers: Math.max(0, Number(p.consumers) - v.count) });
    case 'cache:flush': return set({ hitMode: 'ratio', hitRatio: 0 });
    case 'client:surge': {
      const now = isProgram(p.traffic) ? evalProgram(p.traffic, tSec) : Number(p.rps);
      return set({ traffic: { base: defaultLayer('constant', { rps: now * m }), overlays: [] } });
    }
    default: return null;
  }
}

export interface ImpactRow { id: string; name: string; utilKind: Text; util0: number; util1: number; lat0: number; lat1: number; self: boolean }
export interface Impact { rows: ImpactRow[]; down?: boolean }

/**
 * Before and after, for the faulted component and up to two others whose utilization rises the most
 * (callers that hold a thread while they wait, a database behind a flushed cache).
 */
export function estimateImpact(topo: Topology, nodeId: string, kind: string, v: Record<string, number>, tSec: number): Impact | null {
  const node = topo.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  if ((kind === 'instanceDown') && Number(withDefaults(NODE_SPECS[node.type].params, node.params).instances) - v.count < 1) return { rows: [], down: true };
  const after = withFault(topo, node, kind, v, tSec);
  if (!after) return null;
  const a0 = analyze(topo, undefined, 0.7, tSec), a1 = analyze(after, undefined, 0.7, tSec);
  const before = new Map(a0.nodes.map((e) => [e.id, e]));
  const rows: ImpactRow[] = [];
  for (const e1 of a1.nodes) {
    const e0 = before.get(e1.id);
    if (!e0 || e1.type === 'client') continue;
    rows.push({ id: e1.id, name: e1.name, utilKind: e1.utilKind, util0: e0.util, util1: e1.util, lat0: e0.latency, lat1: e1.latency, self: e1.id === nodeId });
  }
  // Overloaded on its own resources first (the database behind a flushed cache), then callers stuck
  // waiting on it (their utilization has no finite value), then the biggest rises.
  const rise = (r: ImpactRow) => (!isFinite(r.util1) ? 500 : r.util1 >= 1 ? 1000 + r.util1 : r.util1 - r.util0);
  const self = rows.filter((r) => r.self);
  const others = rows.filter((r) => !r.self && rise(r) > 0.05).sort((a, b) => rise(b) - rise(a)).slice(0, kind === 'surge' ? 3 : 2);
  return { rows: [...self, ...others] };
}
