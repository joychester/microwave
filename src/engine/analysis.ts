// Analytical (closed-form) layer: steady-state estimates in milliseconds of compute.
// Forced flow law -> per-node arrival rates; M/G/c (Erlang C + Allen-Cunneen) -> waits;
// USL for the database; utilisation law for capacity planning.
import { mean, scv } from './dist';
import { EDGE_SPECS, NODE_SPECS, withDefaults } from './specs';
import { L, type Dist, type NodeCfg, type Params, type Text, type Topology } from './types';
import { evalProgram, isProgram } from './traffic';
import { cacheShape, steadyHit, topKeyShare } from './cachemodel';

export interface NodeEstimate {
  id: string;
  name: string;
  type: NodeCfg['type'];
  lambda: number; // rps arriving at this node (no retries)
  util: number; // binding utilisation (max of worker / cpu / shard / consumer)
  utilKind: Text;
  cpu: number;
  latency: number; // mean response time ms incl. downstream
  note?: Text;
  // capacity planning
  plan?: { label: Text; param: string; current: number; needed: number; limit?: number }[];
}

export interface Analysis {
  totalRps: number;
  nodes: NodeEstimate[];
  bottleneck?: NodeEstimate;
  maxRps: number; // entry rps at which the bottleneck reaches 100%
  e2eLatency: number;
  targetUtil: number;
  scale: number;
}

function erlangC(c: number, a: number): number {
  if (a <= 0) return 0;
  if (a >= c) return 1;
  let b = 1;
  for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b);
  return b / (1 - (a / c) * (1 - b));
}

// M/G/c mean queueing delay (Allen-Cunneen), λ in 1/ms, s in ms
function mgcWait(lambdaPerMs: number, s: number, c: number, cs2: number): number {
  const a = lambdaPerMs * s;
  if (a >= c) return Infinity;
  const pw = erlangC(Math.max(1, Math.round(c)), a);
  return (pw / (c / s - lambdaPerMs)) * ((1 + cs2) / 2);
}

export function analyze(topo: Topology, targetRps?: number, targetUtil = 0.7, tSec = 0): Analysis {
  const nodes = new Map(topo.nodes.map((n) => [n.id, { cfg: n, p: withDefaults(NODE_SPECS[n.type].params, n.params) }]));
  const out = new Map<string, { to: string; p: Params }[]>();
  for (const e of topo.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push({ to: e.to, p: withDefaults(EDGE_SPECS, e.params) });
  }
  const lam = new Map<string, number>();
  const num = (p: Params, k: string) => Number(p[k]);
  const cacheHit = (p: Params) => steadyHit(p);
  type OutE = { to: string; p: Params };
  const weightShare = (e: OutE, set: OutE[]) => {
    if (set.length <= 1) return 1;
    const tot = set.reduce((s, x) => s + Math.max(0, num(x.p, 'weight')), 0);
    return tot > 0 ? Math.max(0, num(e.p, 'weight')) / tot : 1 / set.length;
  };
  const choiceShare = (e: OutE, outs: OutE[]) => {
    if (!e.p.choice) return 1;
    return weightShare(e, outs.filter((x) => x.p.choice && num(x.p, 'order') === num(e.p, 'order')));
  };

  // ---- 1. forced flow: propagate arrival rates
  const push = (id: string, rate: number, path: string, depth: number) => {
    if (depth > 30 || rate <= 0) return;
    const n = nodes.get(id);
    if (!n) return;
    lam.set(id, (lam.get(id) ?? 0) + rate);
    const outs = out.get(id) ?? [];
    const p = n.p;
    switch (n.cfg.type) {
      case 'gateway': {
        const routes = outs.filter((e) => path.startsWith(String(e.p.match ?? ''))).sort((a, b) => String(b.p.match).length - String(a.p.match).length);
        const best = routes.length ? String(routes[0].p.match).length : 0;
        const tied = routes.filter((r) => String(r.p.match).length === best);
        for (const e of tied) push(e.to, rate * weightShare(e, tied), path, depth + 1);
        break;
      }
      case 'lb':
        for (const e of outs) push(e.to, rate * weightShare(e, outs), path, depth + 1);
        break;
      case 'service':
        for (const e of outs) push(e.to, rate * choiceShare(e, outs) * num(e.p, 'probability') * Math.max(1, num(e.p, 'callsPerRequest')), path, depth + 1);
        break;
      case 'cache':
        for (const e of outs) push(e.to, rate * (1 - cacheHit(p)) * choiceShare(e, outs) * num(e.p, 'probability') * Math.max(1, num(e.p, 'callsPerRequest')), path, depth + 1);
        break;
      case 'queue':
        for (const e of outs) push(e.to, rate, '/consume', depth + 1);
        break;
    }
  };
  let totalRps = 0;
  for (const n of nodes.values()) {
    if (n.cfg.type !== 'client') continue;
    const rps = isProgram(n.p.traffic) ? evalProgram(n.p.traffic, tSec) : num(n.p, 'rps');
    totalRps += rps;
    lam.set(n.cfg.id, rps);
    const clientOuts = out.get(n.cfg.id) ?? [];
    if (!clientOuts.length) continue;
    const mix = String(n.p.mix ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const [path, w] = s.split(':');
      return { path: path.trim() || '/', w: Number(w ?? 1) || 0 };
    });
    const tw = mix.reduce((s, m) => s + m.w, 0) || 1;
    for (const e of clientOuts) {
      const share = weightShare(e, clientOuts);
      if (mix.length === 0) push(e.to, rps * share, '/', 1);
      for (const m of mix) push(e.to, (rps * share * m.w) / tw, m.path, 1);
    }
  }

  // ---- 2. response times & utilisation (memoised recursion)
  const est = new Map<string, NodeEstimate>();
  const visiting = new Set<string>();
  const net = (p: Params) => mean(p.network as Dist);

  const downstream = (id: string, factor: number): number => {
    const outs = (out.get(id) ?? []).slice().sort((a, b) => num(a.p, 'order') - num(b.p, 'order'));
    let total = 0;
    let cur = NaN;
    let groupMax = 0;
    for (const e of outs) {
      if (e.p.async) continue;
      if (num(e.p, 'order') !== cur) { total += groupMax; groupMax = 0; cur = num(e.p, 'order'); }
      const share = e.p.choice ? (() => {
        const set = outs.filter((x) => x.p.choice && num(x.p, 'order') === num(e.p, 'order'));
        const tot = set.reduce((sum, x) => sum + Math.max(0, num(x.p, 'weight')), 0);
        return tot > 0 ? Math.max(0, num(e.p, 'weight')) / tot : 1 / set.length;
      })() : 1;
      const r = share * num(e.p, 'probability') * Math.max(1, num(e.p, 'callsPerRequest')) * (net(e.p) + latencyOf(e.to));
      groupMax = e.p.choice ? groupMax + r : Math.max(groupMax, r);
    }
    return (total + groupMax) * factor;
  };

  const latencyOf = (id: string): number => {
    const ex = est.get(id);
    if (ex) return ex.latency;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const n = nodes.get(id);
    if (!n) return 0;
    const p = n.p;
    const l = lam.get(id) ?? 0;
    const lms = l / 1000;
    const e: NodeEstimate = { id, name: n.cfg.name, type: n.cfg.type, lambda: l, util: 0, utilKind: L('', ''), cpu: 0, latency: 0 };
    switch (n.cfg.type) {
      case 'client': {
        const os = out.get(id) ?? [];
        e.latency = os.reduce((sum, o) => sum + weightShare(o, os) * (net(o.p) + latencyOf(o.to)), 0);
        e.utilKind = L('—', '—');
        break;
      }
      case 'lb': {
        const os = out.get(id) ?? [];
        e.latency = mean(p.latency as Dist) + os.reduce((sum, o) => sum + weightShare(o, os) * (net(o.p) + latencyOf(o.to)), 0);
        e.utilKind = L('—', '—');
        break;
      }
      case 'service':
      case 'gateway': {
        const inst = Math.max(1, num(p, 'instances'));
        const w = Math.max(1, num(p, 'workers'));
        const sDist = (n.cfg.type === 'service' ? p.serviceTime : p.latency) as Dist;
        let S = mean(sDist);
        if (n.cfg.type === 'gateway') S += mean(p.authLatency as Dist);
        let D = 0;
        if (n.cfg.type === 'gateway') {
          // weighted by route share is approximated by the busiest route
          const outs = out.get(id) ?? [];
          for (const o of outs) D = Math.max(D, net(o.p) + latencyOf(o.to));
        } else D = downstream(id, 1);
        const hold = n.cfg.type === 'gateway' || p.holdWorker ? S + D : S;
        const perInst = lms / inst;
        const wq = mgcWait(perInst, hold, w, scv(sDist));
        e.util = (perInst * hold) / w;
        e.utilKind = L('线程池', 'threads');
        if (n.cfg.type === 'service') {
          const f = num(p, 'cpuFraction');
          e.cpu = (lms * S * f) / (num(p, 'cpuCores') * inst);
          if (e.cpu > e.util) { e.util = e.cpu; e.utilKind = L('CPU', 'CPU'); }
        }
        e.latency = (isFinite(wq) ? wq : Infinity) + S + D;
        const capFor = (scale: number) => {
          const byWorkers = Math.ceil((lms * scale * hold) / (w * targetUtil));
          const byCpu = n.cfg.type === 'service' ? Math.ceil((lms * scale * S * num(p, 'cpuFraction')) / (num(p, 'cpuCores') * targetUtil)) : 0;
          return Math.max(1, byWorkers, byCpu);
        };
        e.plan = [{ label: L('实例数', 'Instances'), param: 'instances', current: inst, needed: capFor(1) }];
        (e as NodeEstimate & { capFor?: (s: number) => number }).capFor = capFor;
        break;
      }
      case 'cache': {
        const shards = Math.max(1, num(p, 'shards'));
        const S = mean(p.opLatency as Dist);
        const sh = cacheShape(p);
        const hot = p.hitMode === 'capacity' ? Math.max(num(p, 'hotKeyShare'), topKeyShare(sh.keys, sh.zipf)) : num(p, 'hotKeyShare');
        const miss = 1 - cacheHit(p);
        const ops = lms * (1 + (p.populate ? miss : 0));
        const hottest = ops * (hot + (1 - hot) / shards);
        const rho = hottest * S;
        const wq = rho < 1 ? (rho / (1 - rho)) * S * ((1 + scv(p.opLatency as Dist)) / 2) : Infinity;
        e.util = rho;
        e.utilKind = hot > 0 ? L('最热分片', 'hottest shard') : L('分片', 'shards');
        e.latency = wq + S + miss * downstream(id, 1);
        const denom = targetUtil - ops * hot * S;
        e.plan = [{ label: L('分片数', 'Shards'), param: 'shards', current: shards, needed: denom > 0 ? Math.max(1, Math.ceil((ops * (1 - hot) * S) / denom)) : shards }];
        if (hot > 0 && ops * hot * S >= targetUtil) e.note = L('热点 key 单分片已超出目标利用率，加分片无效，需要拆 key 或本地缓存', 'The hot key alone exceeds the target on one shard. More shards won’t help; split the key or add a local cache');
        break;
      }
      case 'database': {
        const w = Math.max(1, num(p, 'workers'));
        const rr = num(p, 'readRatio');
        const reps = Math.max(0, num(p, 'replicas'));
        const routing = String(p.readRouting);
        const Sr = mean(p.readTime as Dist), Sw = mean(p.writeTime as Dist);
        let primReads = rr, repReads = 0;
        if (reps > 0 && routing === 'replicas') { primReads = 0; repReads = rr / reps; }
        if (reps > 0 && routing === 'mixed') { primReads = rr / (reps + 1); repReads = rr / (reps + 1); }
        const lp = lms * (primReads + (1 - rr));
        const Sp = lp > 0 ? (lms * (primReads * Sr + (1 - rr) * Sw)) / lp : Sr;
        // USL inflation, fixed point on concurrency N = λS
        const alpha = num(p, 'uslAlpha'), beta = num(p, 'uslBeta');
        let Seff = Sp;
        for (let k = 0; k < 20; k++) {
          const N = Math.max(1, Math.min(w, lp * Seff));
          Seff = Sp * (1 + alpha * (N - 1) + beta * N * (N - 1));
        }
        e.util = (lp * Seff) / w;
        e.utilKind = L('主库并发', 'primary concurrency');
        const wq = mgcWait(lp, Seff, w, scv(p.writeTime as Dist));
        let repUtil = 0;
        if (repReads > 0) repUtil = (lms * repReads * Sr) / w;
        if (repUtil > e.util) { e.util = repUtil; e.utilKind = L('副本并发', 'replica concurrency'); }
        e.latency = (isFinite(wq) ? wq : Infinity) + (rr * Sr + (1 - rr) * Sw) * (Seff / Math.max(Sp, 1e-9));
        const nStar = beta > 0 ? Math.sqrt((1 - alpha) / beta) : Infinity;
        if (isFinite(nStar) && nStar < w) e.note = L(`USL 吞吐峰值在并发 ≈ ${nStar.toFixed(0)}，并行执行数调到 ${w} 反而更慢`, `USL throughput peaks near ${nStar.toFixed(0)} concurrent queries; running ${w} in parallel is slower`);
        // connection demand
        let connDemand = 0;
        for (const t of topo.edges) {
          if (t.to !== id) continue;
          const from = nodes.get(t.from);
          if (!from || from.cfg.type !== 'service') continue;
          const ep = withDefaults(EDGE_SPECS, t.params);
          connDemand += Math.max(1, num(from.p, 'instances')) * num(ep, 'poolSize');
        }
        if (connDemand > num(p, 'maxConnections')) e.note = L(`调用方连接池总和 ${connDemand} 超过最大连接数 ${num(p, 'maxConnections')}，扩容调用方时会被拒绝`, `Callers’ pools add up to ${connDemand}, above the ${num(p, 'maxConnections')} connection limit; scaling callers out will hit refusals`);
        e.plan = [{ label: L('主库并行数', 'Parallel executions'), param: 'workers', current: w, needed: Math.max(1, Math.ceil((lp * Seff) / targetUtil)) }];
        break;
      }
      case 'external': {
        // a black box: no queueing on our side; what binds is the provider's allowance
        const S = mean(p.latency as Dist);
        const q = num(p, 'quotaRps'), cap = num(p, 'maxConcurrent');
        const byRate = q > 0 ? l / q : 0;
        const byConc = cap > 0 ? (lms * S) / cap : 0;
        e.latency = S;
        e.util = Math.max(byRate, byConc);
        e.utilKind = byConc > byRate ? L('并发配额', 'concurrency quota') : L('速率配额', 'rate quota');
        if (byConc > byRate) e.plan = [{ label: L('并发上限', 'Concurrent limit'), param: 'maxConcurrent', current: cap, needed: Math.max(1, Math.ceil((lms * S) / targetUtil)) }];
        else if (q > 0) e.plan = [{ label: L('配额（rps）', 'Quota (rps)'), param: 'quotaRps', current: q, needed: Math.max(1, Math.ceil(l / targetUtil)) }];
        if (e.plan) e.note = L('配额由对方决定，提高它意味着升级套餐或改合同；否则要在调用方限流、加缓存或排队削峰', 'The provider sets this quota. Raising it means a bigger plan or contract; otherwise throttle callers, cache responses or queue the work');
        break;
      }
      case 'queue': {
        e.latency = mean(p.produceLatency as Dist);
        const outs = out.get(id) ?? [];
        const eff = Math.min(num(p, 'consumers'), num(p, 'partitions'));
        let worst = 0;
        let proc = 0;
        for (const o of outs) {
          proc = Math.max(proc, net(o.p) + latencyOf(o.to));
        }
        if (proc > 0) worst = (lms * proc) / Math.max(1, eff);
        e.util = worst;
        e.utilKind = L('消费能力', 'consumer capacity');
        const need = proc > 0 ? Math.ceil((lms * proc) / targetUtil) : 1;
        e.plan = [{ label: L('消费者数', 'Consumers'), param: 'consumers', current: num(p, 'consumers'), needed: need, limit: num(p, 'partitions') }];
        break;
      }
    }
    visiting.delete(id);
    est.set(id, e);
    return e.latency;
  };

  for (const id of nodes.keys()) latencyOf(id);
  const list = [...est.values()].filter((e) => e.type !== 'client' && e.type !== 'lb');
  const bottleneck = list.slice().sort((a, b) => b.util - a.util)[0];
  const maxRps = bottleneck && bottleneck.util > 0 ? totalRps / bottleneck.util : Infinity;

  const scale = targetRps && totalRps > 0 ? targetRps / totalRps : 1;
  if (scale !== 1) {
    for (const e of list) {
      const capFor = (e as NodeEstimate & { capFor?: (s: number) => number }).capFor;
      if (capFor && e.plan) e.plan[0].needed = capFor(scale);
      else if (e.plan) e.plan[0].needed = Math.ceil(e.plan[0].needed * scale);
    }
  }
  for (const e of list) {
    const pl = e.plan?.[0];
    if (pl?.limit !== undefined && pl.needed > pl.limit) e.note = L(`需要 ${pl.needed} 个消费者，但分区只有 ${pl.limit} 个，多出的消费者会空闲，必须先加分区`, `Needs ${pl.needed} consumers but there are only ${pl.limit} partitions; extra consumers would sit idle, so add partitions first`);
  }
  const clients = [...est.values()].filter((e) => e.type === 'client');
  const e2e = clients.length ? clients.reduce((s, c) => s + c.latency * c.lambda, 0) / Math.max(1e-9, clients.reduce((s, c) => s + c.lambda, 0)) : 0;
  return { totalRps, nodes: [...est.values()], bottleneck, maxRps, e2eLatency: e2e, targetUtil, scale };
}
