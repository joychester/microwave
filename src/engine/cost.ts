// Running-cost model ($/hour). Roughly cloud-shaped, kept simple so trade-offs are legible.
import { NODE_SPECS, withDefaults } from './specs';
import { analyze } from './analysis';
import type { NodeSample, Topology } from './types';

export const PRICES = {
  serviceCore: 0.1, // per vCPU-hour
  gatewayInstance: 0.15,
  lb: 0.025,
  cacheShard: 0.12,
  dbBase: 0.4,
  dbWorker: 0.02, // per parallel execution slot (bigger instance)
  dbReplica: 0.4,
  queueBase: 0.1,
  queuePartition: 0.01,
};

export function costPerHour(topo: Topology, live?: Record<string, NodeSample>): { total: number; byNode: Record<string, number> } {
  const byNode: Record<string, number> = {};
  let total = 0;
  let est: Map<string, number> | undefined;
  for (const n of topo.nodes) {
    const p = withDefaults(NODE_SPECS[n.type].params, n.params);
    const s = live?.[n.id];
    const running = s ? s.instances + (s.extra.starting ?? 0) + (s.extra.down ?? 0) : Number(p.instances ?? 1);
    let c = 0;
    switch (n.type) {
      case 'service': c = running * Number(p.cpuCores) * PRICES.serviceCore; break;
      case 'gateway': c = running * PRICES.gatewayInstance; break;
      case 'lb': c = PRICES.lb; break;
      case 'cache': c = Number(p.shards) * PRICES.cacheShard; break;
      case 'database': c = PRICES.dbBase + Number(p.workers) * PRICES.dbWorker + Number(p.replicas) * PRICES.dbReplica; break;
      case 'queue': c = PRICES.queueBase + Number(p.partitions) * PRICES.queuePartition; break;
      case 'external': {
        // billed per call: live billed calls/s when running, otherwise the analytical arrival rate
        const per1k = Number(p.costPer1k ?? 0);
        if (per1k > 0) {
          const rps = s ? (s.extra.billed ?? 0) : (est ??= new Map(analyze(topo).nodes.map((e) => [e.id, e.lambda]))).get(n.id) ?? 0;
          c = (rps * 3600 / 1000) * per1k;
        }
        break;
      }
      default: c = 0;
    }
    byNode[n.id] = c;
    total += c;
  }
  return { total, byNode };
}

export function fmtCost(v: number): string {
  return `$${v.toFixed(v >= 100 ? 0 : 2)}`;
}
