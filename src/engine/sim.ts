// Request-level discrete-event simulator for microservice topologies.
import { Rng, sample, percentile } from './dist';
import { EDGE_SPECS, NODE_SPECS, withDefaults } from './specs';
import { L, type Text } from './types';
import { evalProgram, isProgram } from './traffic';
import { cacheShape, cheHitRatio, topKeyShare } from './cachemodel';
import type {
  ActiveFailure, Dist, EdgeCfg, EdgeSample, FailureSpec, NodeCfg, NodeSample, NodeType,
  Params, SimEvent, Snapshot, Topology,
} from './types';

type Done = (ok: boolean, cause?: string) => void;

interface Req {
  path: string;
  pickInst?: () => Instance | null;
  callerInst?: Instance | null;
  opDone?: () => void; // cache: op finished; stop the caller's timeout clock (origin fetch has its own edge)
}

// ---------------------------------------------------------------- event heap
interface Ev { t: number; s: number; f: () => void }

class EventHeap {
  a: Ev[] = [];
  private seq = 0;
  push(t: number, f: () => void) {
    const e = { t, s: this.seq++, f };
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(a[p], e)) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = e;
  }
  peek(): Ev | undefined { return this.a[0]; }
  pop(): Ev | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && less(a[r], a[l]) ? r : l;
        if (less(last, a[c])) break;
        a[i] = a[c];
        i = c;
      }
      a[i] = last;
    }
    return top;
  }
  get size() { return this.a.length; }
}
function less(x: Ev, y: Ev) { return x.t < y.t || (x.t === y.t && x.s < y.s); }

class Fifo<T> {
  private a: T[] = [];
  private h = 0;
  push(v: T) { this.a.push(v); }
  shift(): T | undefined {
    if (this.h >= this.a.length) return undefined;
    const v = this.a[this.h++];
    if (this.h > 4096 && this.h * 2 > this.a.length) { this.a = this.a.slice(this.h); this.h = 0; }
    return v;
  }
  get length() { return this.a.length - this.h; }
  clear(): T[] { const rest = this.a.slice(this.h); this.a = []; this.h = 0; return rest; }
}

// ---------------------------------------------------------------- runtime structs
interface Job {
  arrive: number;
  run: (inst: Instance, release: () => void, epoch: number) => void;
  fail: (cause: string) => void;
}

interface ConnPool {
  size: number;
  inUse: number;
  opened: number;
  waiters: Fifo<{ cb: (ok: boolean, cause?: string) => void; t: number; done: boolean }>;
  target: NodeRT;
}

let INST_SEQ = 0;
class Instance {
  id = INST_SEQ++;
  busy = 0;
  cpuActive = 0;
  queue = new Fifo<Job>();
  cpuQueue = new Fifo<() => void>();
  active = new Set<Job>();
  up = true;
  ready = true;
  detected = false; // health-check has noticed it is down
  draining = false;
  epoch = 0;
  gcUntil = 0;
  nextGc = -1;
  lastT: number;
  pools: { edge: EdgeRT; pool: ConnPool }[] = [];
  constructor(now: number) { this.lastT = now; }
}

interface Acc {
  arr: number; ok: number; err: number; wasted: number;
  lats: number[]; causes: Record<string, number>;
  busyInt: number; cpuInt: number;
  extra: Record<string, number>;
}
const newAcc = (): Acc => ({ arr: 0, ok: 0, err: 0, wasted: 0, lats: [], causes: {}, busyInt: 0, cpuInt: 0, extra: {} });

interface ConsumerGroup {
  edgeId: string;
  parts: Fifo<number>[];
  gen: number;
  pausedUntil: number;
  rr: number;
}

class NodeRT {
  cfg: NodeCfg;
  p: Params;
  instances: Instance[] = [];
  acc: Acc = newAcc();
  callGroups: EdgeRT[][] = [];
  // gateway rate limiter
  tokens = 0;
  tokLast = 0;
  // autoscale
  asBusy = 0; asCpu = 0; asLast = 0; asRecs: { t: number; d: number }[] = [];
  // cache / db / queue state
  openConns = 0;
  lastConnWarn = -1e9;
  groups = new Map<string, ConsumerGroup>();
  crashedConsumers = 0;
  produceRr = 0;
  fill = -1; // cache: keys currently held (capacity mode)
  hitMemo = { fill: -1, at: -1e9, key: '', v: 0 };
  extInflight = 0; // external: calls in flight
  alive = true;
  constructor(cfg: NodeCfg) {
    this.cfg = cfg;
    this.p = withDefaults(NODE_SPECS[cfg.type].params, cfg.params);
  }
  get type(): NodeType { return this.cfg.type; }
  num(k: string): number { return Number(this.p[k]); }
  dist(k: string): Dist { return this.p[k] as Dist; }
}

interface EdgeAcc { calls: number; retries: number; fails: number; poolWaits: number[] }

class EdgeRT {
  cfg: EdgeCfg;
  p: Params;
  acc: EdgeAcc = { calls: 0, retries: 0, fails: 0, poolWaits: [] };
  budget = 10;
  cbState: 0 | 1 | 2 = 0;
  cbOpenedAt = 0;
  cbHalfInflight = 0;
  cbHalfOk = 0;
  cbBuckets: { sec: number; ok: number; fail: number }[] = [];
  pools = new Map<Instance, ConnPool>();
  constructor(cfg: EdgeCfg) {
    this.cfg = cfg;
    this.p = withDefaults(EDGE_SPECS, cfg.params);
  }
  num(k: string): number { return Number(this.p[k]); }
}

const NON_RETRYABLE = new Set(['circuit_open', 'no_route', 'no_target']);

export const CAUSE_LABELS: Record<string, Text> = {
  timeout: L('超时', 'Timeout'),
  rejected: L('队列满拒绝', 'Queue full'),
  shed: L('排队超时丢弃', 'Shed after queueing'),
  rate_limited: L('限流 429', 'Rate limited (429)'),
  circuit_open: L('熔断', 'Circuit open'),
  pool_timeout: L('连接池等待超时', 'Pool wait timeout'),
  too_many_connections: L('DB 连接数超限', 'DB connections exhausted'),
  conn_refused: L('连接被拒', 'Connection refused'),
  conn_reset: L('实例崩溃', 'Instance crashed'),
  no_instance: L('无可用实例', 'No healthy instance'),
  error: L('服务 5xx', 'Service 5xx'),
  db_failover: L('主从切换中', 'DB failover'),
  no_route: L('无路由', 'No route'),
  no_target: L('目标不存在', 'Missing target'),
  quota_exceeded: L('第三方配额 429', 'Provider quota (429)'),
  provider_down: L('第三方不可用', 'Provider outage'),
};

// ---------------------------------------------------------------- simulator
export class Simulator {
  now = 0;
  private heap = new EventHeap();
  private rng: Rng;
  private nodes = new Map<string, NodeRT>();
  private edges = new Map<string, EdgeRT>();
  private out = new Map<string, EdgeRT[]>();
  private inbound = new Map<string, EdgeRT[]>();
  private failures: ActiveFailure[] = [];
  private snapshots: Snapshot[] = [];
  private events: SimEvent[] = [];
  private sys = { req: 0, ok: 0, fail: 0, lats: [] as number[], causes: {} as Record<string, number>, offered: 0, attempts: 0, first: 0 };

  constructor(topo: Topology, seed = 7) {
    this.rng = new Rng(seed);
    this.sync(topo);
    this.at(1000, () => this.tickSecond());
  }

  // ------------------------------------------------------------ public API
  advance(toMs: number, maxEvents = Infinity): boolean {
    let n = 0;
    for (;;) {
      const e = this.heap.peek();
      if (!e || e.t > toMs) { this.now = toMs; return true; }
      if (n++ >= maxEvents) return false;
      this.heap.pop();
      this.now = e.t;
      e.f();
    }
  }

  drainSnapshots(): Snapshot[] { const s = this.snapshots; this.snapshots = []; return s; }
  drainEvents(): SimEvent[] { const e = this.events; this.events = []; return e; }
  activeFailures(): ActiveFailure[] {
    return this.failures.filter((f) => this.now < f.end + f.recovery_s * 1000 || f.end === Infinity);
  }
  get pendingEvents() { return this.heap.size; }

  inject(spec: FailureSpec) {
    const f: ActiveFailure = { ...spec, start: this.now, end: spec.duration_s > 0 ? this.now + spec.duration_s * 1000 : Infinity };
    this.failures.push(f);
    const node = this.nodes.get(f.nodeId);
    const fs = node ? NODE_SPECS[node.type].failures.find((x) => x.kind === f.kind) : undefined;
    const nm = node?.cfg.name ?? f.nodeId;
    this.log('crit', L(
      `注入故障：${nm} ${fs?.label.zh ?? f.kind}${spec.duration_s > 0 ? `，持续 ${spec.duration_s}s` : ''}`,
      `Fault injected: ${nm}, ${(fs?.label.en ?? f.kind).toLowerCase()}${spec.duration_s > 0 ? ` for ${spec.duration_s}s` : ''}`,
    ), f.nodeId, undefined, 'fault_start');
    this.applyDiscrete(f, true);
    if (f.end !== Infinity) {
      this.at(f.end - this.now, () => this.endFailure(f));
    }
  }

  clearFailure(id: string) {
    const f = this.failures.find((x) => x.id === id);
    if (!f || this.now >= f.end) return;
    f.end = this.now;
    this.endFailure(f);
  }

  // Live topology / parameter update (no restart needed)
  sync(topo: Topology) {
    const seen = new Set<string>();
    for (const cfg of topo.nodes) {
      seen.add(cfg.id);
      let rt = this.nodes.get(cfg.id);
      const isNew = !rt || rt.type !== cfg.type;
      if (isNew) {
        if (rt) rt.alive = false;
        rt = new NodeRT(cfg);
        rt.tokLast = this.now;
        rt.asLast = this.now;
        this.nodes.set(cfg.id, rt);
      } else {
        rt!.cfg = cfg;
        rt!.p = withDefaults(NODE_SPECS[cfg.type].params, cfg.params);
      }
      if (isNew && cfg.type === 'gateway') rt!.tokens = rt!.num('rlBurst');
      if (isNew && cfg.type === 'external') rt!.tokens = rt!.num('quotaBurst');
      if (isNew && cfg.type === 'client') this.startClient(rt!);
    }
    for (const [id, rt] of this.nodes) {
      if (!seen.has(id)) { rt.alive = false; this.nodes.delete(id); }
    }
    // edges
    const eseen = new Set<string>();
    this.out.clear();
    this.inbound.clear();
    for (const cfg of topo.edges) {
      if (!this.nodes.has(cfg.from) || !this.nodes.has(cfg.to)) continue;
      eseen.add(cfg.id);
      let e = this.edges.get(cfg.id);
      if (!e) { e = new EdgeRT(cfg); this.edges.set(cfg.id, e); }
      else { e.cfg = cfg; e.p = withDefaults(EDGE_SPECS, cfg.params); }
      if (!this.out.has(cfg.from)) this.out.set(cfg.from, []);
      this.out.get(cfg.from)!.push(e);
      if (!this.inbound.has(cfg.to)) this.inbound.set(cfg.to, []);
      this.inbound.get(cfg.to)!.push(e);
    }
    for (const id of [...this.edges.keys()]) if (!eseen.has(id)) this.edges.delete(id);
    // call groups + structural reconcile
    for (const rt of this.nodes.values()) {
      const outs = (this.out.get(rt.cfg.id) ?? []).slice().sort((a, b) => a.num('order') - b.num('order'));
      const groups: EdgeRT[][] = [];
      let cur = NaN;
      for (const e of outs) {
        if (e.num('order') !== cur) { groups.push([]); cur = e.num('order'); }
        groups[groups.length - 1].push(e);
      }
      rt.callGroups = groups;
      this.reconcile(rt);
    }
  }

  // ------------------------------------------------------------ scheduling
  private at(delay: number, f: () => void) { this.heap.push(this.now + Math.max(0, delay), f); }

  private log(level: SimEvent['level'], text: Text, nodeId?: string, edgeId?: string, code?: SimEvent['code']) {
    this.events.push({ t: this.now / 1000, level, text, nodeId, edgeId, code });
  }

  // ------------------------------------------------------------ structure
  private reconcile(rt: NodeRT) {
    const t = rt.type;
    if (t === 'service' || t === 'gateway') {
      if (rt.instances.length === 0) {
        const n = Math.max(1, rt.num('instances'));
        for (let i = 0; i < n; i++) rt.instances.push(new Instance(this.now));
      } else if (!rt.p.asEnabled) {
        this.setInstanceCount(rt, Math.max(1, rt.num('instances')), true);
      }
    } else if (t === 'cache') {
      this.resizeServers(rt, Math.max(1, rt.num('shards')));
      if (rt.fill < 0) rt.fill = rt.p.coldStart ? 0 : cacheShape(rt.p).capacity;
    } else if (t === 'database') {
      this.resizeServers(rt, 1 + Math.max(0, rt.num('replicas')));
    } else if (t === 'queue') {
      const outs = this.out.get(rt.cfg.id) ?? [];
      const ids = new Set(outs.map((e) => e.cfg.id));
      for (const id of [...rt.groups.keys()]) if (!ids.has(id)) rt.groups.delete(id);
      const P = Math.max(1, rt.num('partitions'));
      for (const e of outs) {
        let g = rt.groups.get(e.cfg.id);
        if (!g) {
          g = { edgeId: e.cfg.id, parts: [], gen: 0, pausedUntil: 0, rr: 0 };
          rt.groups.set(e.cfg.id, g);
        }
        let changed = g.gen === 0;
        if (g.parts.length !== P) {
          const backlog: number[] = [];
          for (const q of g.parts) backlog.push(...q.clear());
          g.parts = Array.from({ length: P }, () => new Fifo<number>());
          backlog.sort((a, b) => a - b).forEach((ts, i) => g!.parts[i % P].push(ts));
          changed = true;
        }
        const want = this.consumerCount(rt);
        if ((g as ConsumerGroup & { lastEff?: number }).lastEff !== want) changed = true;
        if (changed) this.rebalance(rt, g, g.gen !== 0);
      }
    }
  }

  private resizeServers(rt: NodeRT, n: number) {
    while (rt.instances.length < n) rt.instances.push(new Instance(this.now));
    while (rt.instances.length > n) {
      const inst = rt.instances.pop()!;
      this.crash(rt, inst, 'conn_reset', true);
    }
  }

  private setInstanceCount(rt: NodeRT, want: number, instant: boolean, coldStart = 0) {
    const live = rt.instances.filter((i) => !i.draining);
    if (live.length < want) {
      for (let k = live.length; k < want; k++) {
        const inst = new Instance(this.now);
        if (!instant) {
          inst.ready = false;
          this.at(coldStart, () => { inst.ready = true; });
        }
        rt.instances.push(inst);
      }
    } else if (live.length > want) {
      // drain not-ready first, then newest
      const order = live.slice().sort((a, b) => Number(a.ready) - Number(b.ready) || b.id - a.id);
      for (let k = 0; k < live.length - want; k++) {
        const inst = order[k];
        inst.draining = true;
        this.maybeRemove(rt, inst);
      }
    }
    // revive crashed instances if user explicitly wants them gone: keep as is (failure end restarts them)
  }

  private maybeRemove(rt: NodeRT, inst: Instance) {
    if (inst.draining && inst.busy === 0 && inst.queue.length === 0) {
      const i = rt.instances.indexOf(inst);
      if (i >= 0) rt.instances.splice(i, 1);
      this.touch(rt, inst);
      inst.epoch++;
      this.releasePools(inst);
    }
  }

  private releasePools(inst: Instance) {
    for (const { edge, pool } of inst.pools) {
      pool.target.openConns = Math.max(0, pool.target.openConns - pool.opened);
      pool.opened = 0;
      edge.pools.delete(inst);
    }
    inst.pools = [];
  }

  private crash(rt: NodeRT, inst: Instance, cause: string, remove = false) {
    this.touch(rt, inst);
    inst.epoch++;
    inst.up = false;
    inst.detected = false;
    const act = [...inst.active];
    inst.active.clear();
    inst.busy = 0;
    inst.cpuActive = 0;
    inst.cpuQueue.clear();
    const queued = inst.queue.clear();
    for (const j of act) j.fail(cause);
    for (const j of queued) j.fail(cause);
    this.releasePools(inst);
    if (!remove) {
      const delay = this.detectDelay(rt);
      this.at(delay, () => { if (!inst.up) inst.detected = true; });
    }
  }

  private detectDelay(rt: NodeRT): number {
    const lbEdge = (this.inbound.get(rt.cfg.id) ?? []).find((e) => this.nodes.get(e.cfg.from)?.type === 'lb');
    if (lbEdge) {
      const lb = this.nodes.get(lbEdge.cfg.from)!;
      return lb.num('hcInterval') * lb.num('hcThreshold') * 1000 * (0.7 + 0.3 * this.rng.next());
    }
    return 10000;
  }

  // ------------------------------------------------------------ accounting
  private touch(rt: NodeRT, inst: Instance) {
    const dt = this.now - inst.lastT;
    if (dt > 0) {
      rt.acc.busyInt += inst.busy * dt;
      rt.asBusy += inst.busy * dt;
      if (rt.type === 'service') {
        const c = inst.cpuActive * this.cpuSpeed(rt) * dt;
        rt.acc.cpuInt += c;
        rt.asCpu += c;
      }
    }
    inst.lastT = this.now;
  }

  private workers(rt: NodeRT): number {
    if (rt.type === 'cache') return 1;
    return Math.max(1, rt.num('workers'));
  }
  private queueCap(rt: NodeRT): number {
    if (rt.type === 'service' || rt.type === 'gateway') return Math.max(0, rt.num('queueCap'));
    if (rt.type === 'database') return Math.max(0, rt.num('maxConnections') - this.workers(rt));
    return Infinity;
  }

  // ------------------------------------------------------------ failures
  private intensity(nodeId: string, kind: string): { v: number; f?: ActiveFailure } {
    let best = 0;
    let bf: ActiveFailure | undefined;
    for (const f of this.failures) {
      if (f.nodeId !== nodeId || f.kind !== kind) continue;
      let v = 0;
      if (this.now < f.start) v = 0;
      else if (this.now < f.end) v = 1;
      else if (f.recovery_s > 0 && this.now < f.end + f.recovery_s * 1000) v = 1 - (this.now - f.end) / (f.recovery_s * 1000);
      if (v > best) { best = v; bf = f; }
    }
    return { v: best, f: bf };
  }

  private applyDiscrete(f: ActiveFailure, starting: boolean) {
    const rt = this.nodes.get(f.nodeId);
    if (!rt) return;
    if (f.kind === 'instanceDown') {
      if (starting) {
        const victims = rt.instances.filter((i) => i.up && !i.draining).slice(-Math.max(1, f.params.count ?? 1));
        (f as ActiveFailure & { victims?: Instance[] }).victims = victims;
        for (const v of victims) this.crash(rt, v, 'conn_reset');
      } else {
        const victims = (f as ActiveFailure & { victims?: Instance[] }).victims ?? [];
        const restart = rt.p.asEnabled ? rt.num('asColdStart') * 1000 : 15000;
        for (const v of victims) {
          if (!rt.instances.includes(v)) continue;
          v.up = true;
          v.ready = false;
          v.detected = false;
          v.lastT = this.now;
          this.at(restart, () => { v.ready = true; });
        }
        this.log('info', L(
          `${rt.cfg.name}：${victims.length} 个实例重启中，${(restart / 1000).toFixed(0)}s 后可用`,
          `${rt.cfg.name}: restarting ${victims.length} instance${victims.length > 1 ? 's' : ''}, ready in ${(restart / 1000).toFixed(0)}s`,
        ), rt.cfg.id, undefined, 'restart');
      }
    } else if (f.kind === 'consumerCrash') {
      rt.crashedConsumers += (starting ? 1 : -1) * Math.max(1, f.params.count ?? 1);
      rt.crashedConsumers = Math.max(0, rt.crashedConsumers);
      for (const g of rt.groups.values()) this.rebalance(rt, g, true);
    }
  }

  private endFailure(f: ActiveFailure) {
    const node = this.nodes.get(f.nodeId);
    const fs = node ? NODE_SPECS[node.type].failures.find((x) => x.kind === f.kind) : undefined;
    const nm = node?.cfg.name ?? f.nodeId;
    this.log('info', L(
      `故障结束：${nm} ${fs?.label.zh ?? f.kind}${f.recovery_s > 0 ? `，${f.recovery_s}s 内逐步恢复` : ''}`,
      `Fault ended: ${nm}, ${(fs?.label.en ?? f.kind).toLowerCase()}${f.recovery_s > 0 ? `, recovering over ${f.recovery_s}s` : ''}`,
    ), f.nodeId, undefined, 'fault_end');
    this.applyDiscrete(f, false);
  }

  // ------------------------------------------------------------ delivery
  private deliver(rt: NodeRT, req: Req, done: Done) {
    if (!rt.alive) { done(false, 'no_target'); return; }
    const t0 = this.now;
    rt.acc.arr++;
    let fired = false;
    const d: Done = (ok, cause) => {
      if (fired) return;
      fired = true;
      rt.acc.lats.push(this.now - t0);
      if (ok) rt.acc.ok++;
      else { rt.acc.err++; const c = cause ?? 'error'; rt.acc.causes[c] = (rt.acc.causes[c] ?? 0) + 1; }
      done(ok, cause);
    };
    switch (rt.type) {
      case 'service': return this.handleService(rt, req, d);
      case 'gateway': return this.handleGateway(rt, req, d);
      case 'lb': return this.handleLb(rt, req, d);
      case 'cache': return this.handleCache(rt, req, d);
      case 'database': return this.handleDb(rt, req, d);
      case 'queue': return this.handleQueueProduce(rt, req, d);
      case 'external': return this.handleExternal(rt, d);
      case 'client': return d(false, 'no_route');
    }
  }

  private pickDirect(rt: NodeRT): Instance | null {
    const c = rt.instances.filter((i) => i.ready && !i.draining && (i.up || !i.detected));
    if (c.length === 0) return null;
    return c[this.rng.int(c.length)];
  }

  private submit(rt: NodeRT, inst: Instance | null, job: Job) {
    if (!inst) { job.fail('no_instance'); return; }
    if (!inst.up) { this.at(1, () => job.fail('conn_refused')); return; }
    if (inst.busy < this.workers(rt)) { this.start(rt, inst, job); return; }
    if (inst.queue.length < this.queueCap(rt)) { inst.queue.push(job); return; }
    job.fail(rt.type === 'database' ? 'too_many_connections' : 'rejected');
  }

  private start(rt: NodeRT, inst: Instance, job: Job) {
    this.touch(rt, inst);
    inst.busy++;
    inst.active.add(job);
    const epoch = inst.epoch;
    let released = false;
    const release = () => {
      if (released || inst.epoch !== epoch) return;
      released = true;
      this.touch(rt, inst);
      inst.busy--;
      inst.active.delete(job);
      this.next(rt, inst);
    };
    job.run(inst, release, epoch);
  }

  private next(rt: NodeRT, inst: Instance) {
    const qt = rt.type === 'service' ? rt.num('queueTimeout') : 0;
    while (inst.busy < this.workers(rt) && inst.queue.length > 0) {
      const j = inst.queue.shift()!;
      if (qt > 0 && this.now - j.arrive > qt) { j.fail('shed'); continue; }
      this.start(rt, inst, j);
    }
    if (inst.draining) this.maybeRemove(rt, inst);
  }

  private cpuSlots(rt: NodeRT) { return Math.max(1, Math.floor(rt.num('cpuCores'))); }
  private cpuSpeed(rt: NodeRT) { return Math.max(0.01, rt.num('cpuCores')) / this.cpuSlots(rt); }

  private cpuRun(rt: NodeRT, inst: Instance, work: number, epoch: number, cb: () => void) {
    const go = () => {
      this.touch(rt, inst);
      inst.cpuActive++;
      this.at(work / this.cpuSpeed(rt), () => {
        if (inst.epoch !== epoch) return;
        this.touch(rt, inst);
        inst.cpuActive--;
        const nx = inst.cpuQueue.shift();
        if (nx) nx();
        cb();
      });
    };
    if (inst.cpuActive < this.cpuSlots(rt)) go();
    else inst.cpuQueue.push(go);
  }

  private gcDelay(rt: NodeRT, inst: Instance): number {
    if (!rt.p.gcEnabled) return 0;
    const iv = rt.num('gcInterval') * 1000;
    if (inst.nextGc < 0) inst.nextGc = this.now + this.rng.next() * iv;
    while (this.now >= inst.nextGc) {
      inst.gcUntil = inst.nextGc + sample(rt.dist('gcPause'), this.rng);
      inst.nextGc += iv * (0.8 + 0.4 * this.rng.next());
    }
    return this.now < inst.gcUntil ? inst.gcUntil - this.now : 0;
  }

  // ------------------------------------------------------------ service
  private handleService(rt: NodeRT, req: Req, done: Done) {
    const inst = req.pickInst ? req.pickInst() : this.pickDirect(rt);
    const job: Job = {
      arrive: this.now,
      fail: (c) => done(false, c),
      run: (inst, release, epoch) => {
        const slow = this.intensity(rt.cfg.id, 'slow');
        const mult = 1 + ((slow.f?.params.multiplier ?? 1) - 1) * slow.v;
        const S = sample(rt.dist('serviceTime'), this.rng) * mult;
        const f = rt.num('cpuFraction');
        // I/O wait (+ GC pause) is a pure delay; the CPU part queues for a core
        this.at(S * (1 - f) + this.gcDelay(rt, inst), () => {
          if (inst.epoch !== epoch) return;
          this.cpuRun(rt, inst, S * f, epoch, () => {
            const spike = this.intensity(rt.cfg.id, 'errorSpike');
            const er = rt.num('errorRate') * (1 - spike.v) + (spike.f?.params.rate ?? 0) * spike.v;
            if (this.rng.next() < er) { release(); done(false, 'error'); return; }
            if (!rt.p.holdWorker) release();
            this.runCalls(rt, inst, req, (ok, c) => { release(); done(ok, c); });
          });
        });
      },
    };
    this.submit(rt, inst, job);
  }

  // ------------------------------------------------------------ gateway
  private handleGateway(rt: NodeRT, req: Req, done: Done) {
    if (rt.p.rlEnabled) {
      const rate = rt.num('rlRps');
      const burst = rt.num('rlBurst');
      rt.tokens = Math.min(burst, rt.tokens + ((this.now - rt.tokLast) * rate) / 1000);
      rt.tokLast = this.now;
      if (rt.tokens < 1) { done(false, 'rate_limited'); return; }
      rt.tokens -= 1;
    }
    const inst = this.pickDirect(rt);
    this.submit(rt, inst, {
      arrive: this.now,
      fail: (c) => done(false, c),
      run: (inst, release, epoch) => {
        const lat = sample(rt.dist('latency'), this.rng) + sample(rt.dist('authLatency'), this.rng);
        this.at(lat, () => {
          if (inst.epoch !== epoch) return;
          const outs = this.out.get(rt.cfg.id) ?? [];
          const routes = outs.filter((e) => req.path.startsWith(String(e.p.match ?? '')));
          // most specific prefix wins
          routes.sort((a, b) => String(b.p.match).length - String(a.p.match).length);
          const best = routes.length ? String(routes[0].p.match).length : 0;
          const e = this.pickWeighted(routes.filter((r) => String(r.p.match).length === best));
          if (!e) { release(); done(false, 'no_route'); return; }
          // extra edges with empty match & different order act as side calls (e.g. external auth) — keep simple: route only
          this.callEdge(e, inst, req, (ok, c) => { release(); done(ok, c); });
        });
      },
    });
  }

  // ------------------------------------------------------------ load balancer
  private handleLb(rt: NodeRT, req: Req, done: Done) {
    const e = this.pickWeighted(this.out.get(rt.cfg.id) ?? []);
    if (!e) { done(false, 'no_route'); return; }
    const target = this.nodes.get(e.cfg.to);
    const lat = sample(rt.dist('latency'), this.rng);
    this.at(lat, () => {
      const pick = target && (target.type === 'service' || target.type === 'gateway') ? () => this.lbPick(rt, target) : undefined;
      this.callEdge(e, null, { path: req.path, pickInst: pick }, done);
    });
  }

  private rrCounters = new Map<string, number>();
  private lbPick(lb: NodeRT, target: NodeRT): Instance | null {
    const c = target.instances.filter((i) => i.ready && !i.draining && (i.up || !i.detected));
    if (c.length === 0) return null;
    const load = (i: Instance) => i.busy + i.queue.length;
    switch (String(lb.p.algorithm)) {
      case 'random': return c[this.rng.int(c.length)];
      case 'least_conn': {
        let best = c[0];
        let bl = load(best);
        const off = this.rng.int(c.length);
        for (let k = 0; k < c.length; k++) { const i = c[(k + off) % c.length]; const l = load(i); if (l < bl) { best = i; bl = l; } }
        return best;
      }
      case 'p2c': {
        const a = c[this.rng.int(c.length)];
        const b = c[this.rng.int(c.length)];
        return load(a) <= load(b) ? a : b;
      }
      default: {
        const k = (this.rrCounters.get(lb.cfg.id) ?? 0) + 1;
        this.rrCounters.set(lb.cfg.id, k);
        return c[k % c.length];
      }
    }
  }

  // ------------------------------------------------------------ cache
  // ------------------------------------------------------------ third-party API
  // A black box you can't scale: sampled latency, an error rate, and the provider's quota
  // (a token bucket on rate plus an optional in-flight cap), both answered with 429.
  private handleExternal(rt: NodeRT, done: Done) {
    const outage = this.intensity(rt.cfg.id, 'outage');
    if (outage.v > 0 && this.rng.next() < outage.v) { this.at(1, () => done(false, 'provider_down')); return; }
    const qps = rt.num('quotaRps');
    if (qps > 0) {
      const cut = this.intensity(rt.cfg.id, 'quotaCut');
      const share = 1 - (1 - (cut.f?.params.share ?? 1)) * cut.v;
      const burst = Math.max(1, rt.num('quotaBurst'));
      rt.tokens = Math.min(burst, rt.tokens + ((this.now - rt.tokLast) * qps * share) / 1000);
      rt.tokLast = this.now;
      if (rt.tokens < 1) { this.at(1, () => done(false, 'quota_exceeded')); return; }
      rt.tokens -= 1;
    }
    const cap = rt.num('maxConcurrent');
    if (cap > 0 && rt.extInflight >= cap) { this.at(1, () => done(false, 'quota_exceeded')); return; }
    rt.extInflight++;
    rt.acc.extra.billed = (rt.acc.extra.billed ?? 0) + 1;
    const slow = this.intensity(rt.cfg.id, 'slow');
    const mult = 1 + ((slow.f?.params.multiplier ?? 1) - 1) * slow.v;
    const lat = sample(rt.dist('latency'), this.rng) * mult;
    const t0 = this.now;
    this.at(lat, () => {
      rt.extInflight--;
      rt.acc.busyInt += this.now - t0;
      const spike = this.intensity(rt.cfg.id, 'errorSpike');
      const er = rt.num('errorRate') * (1 - spike.v) + (spike.f?.params.rate ?? 0) * spike.v;
      done(this.rng.next() >= er, 'error');
    });
  }

  private handleCache(rt: NodeRT, req: Req, done: Done) {
    const n = rt.instances.length;
    const hk = this.intensity(rt.cfg.id, 'hotKey');
    const hot = rt.num('hotKeyShare') * (1 - hk.v) + (hk.f?.params.share ?? 0) * hk.v;
    const capMode = rt.p.hitMode === 'capacity';
    const shape = capMode ? cacheShape(rt.p) : null;
    const hotShare = shape ? Math.max(hot, topKeyShare(shape.keys, shape.zipf)) : hot;
    const idx = this.rng.next() < hotShare ? 0 : this.rng.int(n);
    if (idx === 0 && this.intensity(rt.cfg.id, 'shardDown').v > 0) { this.at(1, () => done(false, 'conn_refused')); return; }
    const shard = rt.instances[idx];
    this.submit(rt, shard, {
      arrive: this.now,
      fail: (c) => done(false, c),
      run: (inst, release) => {
        this.at(sample(rt.dist('opLatency'), this.rng), () => {
          release();
          req.opDone?.();
          const fl = this.intensity(rt.cfg.id, 'flush');
          let hr: number;
          if (shape) {
            if (fl.v >= 1 && this.now < (fl.f?.end ?? 0)) rt.fill = 0;
            rt.fill = Math.max(0, Math.min(rt.fill, shape.capacity));
            hr = this.cacheHitNow(rt, shape);
          } else hr = rt.num('hitRatio') * (1 - fl.v);
          if (this.rng.next() < hr) { rt.acc.extra.hit = (rt.acc.extra.hit ?? 0) + 1; done(true); return; }
          rt.acc.extra.miss = (rt.acc.extra.miss ?? 0) + 1;
          if (rt.callGroups.length === 0) { done(true); return; }
          this.runCalls(rt, req.callerInst ?? null, req, (ok, c) => {
            if (ok && rt.p.populate && shape && rt.fill < shape.capacity) rt.fill += 1;
            if (ok && rt.p.populate) {
              this.submit(rt, inst, { arrive: this.now, fail: () => {}, run: (_i, rel) => this.at(sample(rt.dist('opLatency'), this.rng), rel) });
            }
            done(ok, c);
          });
        });
      },
    });
  }

  private cacheHitNow(rt: NodeRT, shape: { capacity: number; keys: number; zipf: number }): number {
    const m = rt.hitMemo;
    const key = `${shape.capacity}|${shape.keys}|${shape.zipf}`;
    const tol = Math.max(1, shape.capacity * 0.002);
    if (m.key !== key || Math.abs(m.fill - rt.fill) > tol || this.now - m.at > 1000) {
      m.v = cheHitRatio(Math.min(rt.fill, shape.capacity), shape.keys, shape.zipf);
      m.fill = rt.fill; m.at = this.now; m.key = key;
    }
    return m.v;
  }

  // ------------------------------------------------------------ database
  private handleDb(rt: NodeRT, req: Req, done: Done) {
    const isRead = this.rng.next() < rt.num('readRatio');
    const replicas = rt.instances.length - 1;
    let server = rt.instances[0];
    if (isRead && replicas > 0) {
      const routing = String(rt.p.readRouting);
      if (routing === 'replicas') server = rt.instances[1 + this.rng.int(replicas)];
      else if (routing === 'mixed') server = rt.instances[this.rng.int(replicas + 1)];
    }
    if (server === rt.instances[0] && this.intensity(rt.cfg.id, 'failover').v >= 1) {
      this.at(1, () => done(false, 'db_failover'));
      return;
    }
    this.submit(rt, server, {
      arrive: this.now,
      fail: (c) => done(false, c),
      run: (inst, release) => {
        const lc = this.intensity(rt.cfg.id, 'lockContention');
        const alpha = rt.num('uslAlpha') * (1 - lc.v) + (lc.f?.params.alpha ?? 0) * lc.v;
        const beta = rt.num('uslBeta');
        const N = inst.busy;
        const usl = 1 + alpha * (N - 1) + beta * N * (N - 1);
        const sq = this.intensity(rt.cfg.id, 'slowQuery');
        const mult = 1 + ((sq.f?.params.multiplier ?? 1) - 1) * sq.v;
        const st = sample(rt.dist(isRead ? 'readTime' : 'writeTime'), this.rng) * usl * mult;
        this.at(st, () => { release(); done(true); });
      },
    });
  }

  // ------------------------------------------------------------ queue
  private consumerCount(rt: NodeRT): number {
    return Math.max(0, Math.min(rt.num('consumers') - rt.crashedConsumers, rt.num('partitions')));
  }

  private rebalance(rt: NodeRT, g: ConsumerGroup, pause: boolean) {
    g.gen++;
    const eff = this.consumerCount(rt);
    (g as ConsumerGroup & { lastEff?: number }).lastEff = eff;
    if (pause) {
      g.pausedUntil = this.now + rt.num('rebalancePause') * 1000;
      if (rt.num('rebalancePause') > 0) this.log('warn', L(
        `${rt.cfg.name}：消费组 rebalance，暂停 ${rt.num('rebalancePause')}s，有效消费者 ${eff}`,
        `${rt.cfg.name}: consumer group rebalancing, paused for ${rt.num('rebalancePause')}s, ${eff} active consumers`,
      ), rt.cfg.id, undefined, 'rebalance');
    }
    const gen = g.gen;
    for (let c = 0; c < eff; c++) this.at(0, () => this.consumeLoop(rt, g, c, eff, gen));
  }

  private consumeLoop(rt: NodeRT, g: ConsumerGroup, c: number, eff: number, gen: number) {
    if (g.gen !== gen || !rt.alive || !rt.groups.has(g.edgeId)) return;
    if (this.now < g.pausedUntil) { this.at(g.pausedUntil - this.now, () => this.consumeLoop(rt, g, c, eff, gen)); return; }
    const e = this.edges.get(g.edgeId);
    if (!e) return;
    const P = g.parts.length;
    let ts: number | undefined;
    for (let k = 0; k < P; k++) {
      const p = (g.rr + k) % P;
      if (p % eff !== c) continue;
      if (g.parts[p].length > 0) { ts = g.parts[p].shift(); g.rr = p + 1; break; }
    }
    if (ts === undefined) { this.at(rt.num('pollInterval'), () => this.consumeLoop(rt, g, c, eff, gen)); return; }
    const born = ts;
    this.callEdge(e, null, { path: '/consume' }, (ok) => {
      rt.acc.extra[ok ? 'consumed' : 'dlq'] = (rt.acc.extra[ok ? 'consumed' : 'dlq'] ?? 0) + 1;
      if (ok) rt.acc.lats.push(this.now - born);
      this.at(0, () => this.consumeLoop(rt, g, c, eff, gen));
    });
  }

  private handleQueueProduce(rt: NodeRT, _req: Req, done: Done) {
    this.at(sample(rt.dist('produceLatency'), this.rng), () => {
      for (const g of rt.groups.values()) {
        if (g.parts.length === 0) continue;
        g.parts[rt.produceRr % g.parts.length].push(this.now);
      }
      rt.produceRr++;
      done(true);
    });
  }

  // ------------------------------------------------------------ client
  private startClient(rt: NodeRT) {
    const loop = () => {
      if (!rt.alive) return;
      const rate = this.clientRate(rt);
      if (rate <= 0) { this.at(200, loop); return; }
      const dt = this.rng.exp(1000 / rate);
      if (dt > 200) { this.at(200, loop); return; }
      this.at(dt, () => { if (!rt.alive) return; this.fire(rt); loop(); });
    };
    this.at(0, loop);
  }

  private clientRate(rt: NodeRT): number {
    let r = rt.num('rps');
    const t = this.now / 1000;
    const pat = String(rt.p.pattern);
    if (isProgram(rt.p.traffic)) {
      r = evalProgram(rt.p.traffic, t);
    } else if (pat === 'burst') {
      const every = Math.max(1, rt.num('burstEvery'));
      if (t % every < rt.num('burstDur') && t >= every) r *= rt.num('burstMult');
    } else if (pat === 'diurnal') {
      const tr = rt.num('diurnalTrough');
      r *= tr + (1 - tr) * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / Math.max(1, rt.num('diurnalPeriod'))));
    }
    const s = this.intensity(rt.cfg.id, 'surge');
    r *= 1 + ((s.f?.params.multiplier ?? 1) - 1) * s.v;
    return r;
  }

  private pathMixCache = new Map<string, { path: string; w: number }[]>();
  private pickPath(rt: NodeRT): string {
    const raw = String(rt.p.mix ?? '');
    let mix = this.pathMixCache.get(raw);
    if (!mix) {
      mix = raw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
        const [path, w] = s.split(':');
        return { path: path.trim() || '/', w: Number(w ?? 1) || 0 };
      });
      if (mix.length === 0) mix = [{ path: '/', w: 1 }];
      this.pathMixCache.set(raw, mix);
    }
    const total = mix.reduce((s, m) => s + m.w, 0) || 1;
    let x = this.rng.next() * total;
    for (const m of mix) { x -= m.w; if (x <= 0) return m.path; }
    return mix[mix.length - 1].path;
  }

  private fire(rt: NodeRT) {
    const e = this.pickWeighted(this.out.get(rt.cfg.id) ?? []);
    const t0 = this.now;
    this.sys.offered++;
    rt.acc.arr++;
    const finish: Done = (ok, cause) => {
      const lat = this.now - t0;
      this.sys.req++;
      this.sys.lats.push(lat);
      rt.acc.lats.push(lat);
      if (ok) { this.sys.ok++; rt.acc.ok++; }
      else {
        this.sys.fail++; rt.acc.err++;
        const c = cause ?? 'error';
        this.sys.causes[c] = (this.sys.causes[c] ?? 0) + 1;
        rt.acc.causes[c] = (rt.acc.causes[c] ?? 0) + 1;
      }
    };
    if (!e) { finish(false, 'no_target'); return; }
    this.callEdge(e, null, { path: this.pickPath(rt) }, finish);
  }

  // ------------------------------------------------------------ calls
  private runCalls(rt: NodeRT, inst: Instance | null, req: Req, done: Done) {
    const groups = rt.callGroups;
    let gi = 0;
    const nextGroup = () => {
      if (gi >= groups.length) { done(true); return; }
      const g = groups[gi++];
      let pending = 0;
      let failed = false;
      const cb: Done = (ok, c) => {
        if (failed) return;
        if (!ok) { failed = true; done(false, c); return; }
        if (--pending === 0) nextGroup();
      };
      const launch: (() => void)[] = [];
      const choice = g.filter((e) => e.p.choice);
      const picked = choice.length ? this.pickWeighted(choice) : undefined;
      for (const e of g) {
        if (e.p.choice && e !== picked) continue;
        if (this.rng.next() >= e.num('probability')) continue;
        pending++;
        launch.push(() => this.callMany(e, inst, { path: req.path }, Math.max(1, Math.round(e.num('callsPerRequest'))), cb));
      }
      if (pending === 0) { nextGroup(); return; }
      for (const l of launch) l();
    };
    nextGroup();
  }

  private pickWeighted(edges: EdgeRT[]): EdgeRT | undefined {
    if (edges.length <= 1) return edges[0];
    let total = 0;
    for (const e of edges) total += Math.max(0, e.num('weight'));
    if (total <= 0) return edges[this.rng.int(edges.length)];
    let x = this.rng.next() * total;
    for (const e of edges) { x -= Math.max(0, e.num('weight')); if (x <= 0) return e; }
    return edges[edges.length - 1];
  }

  private callMany(e: EdgeRT, inst: Instance | null, req: Req, n: number, done: Done) {
    let i = 0;
    const step = () => {
      if (i++ >= n) { done(true); return; }
      this.callEdge(e, inst, req, (ok, c) => { if (!ok) done(false, c); else step(); });
    };
    step();
  }

  private callEdge(e: EdgeRT, callerInst: Instance | null, req: Req, done: Done) {
    const target = this.nodes.get(e.cfg.to);
    if (!target) { done(false, 'no_target'); return; }
    if (e.p.async) {
      this.attempts(e, target, callerInst, req, () => {});
      done(true);
      return;
    }
    this.attempts(e, target, callerInst, req, done);
  }

  private attempts(e: EdgeRT, target: NodeRT, callerInst: Instance | null, req: Req, done: Done) {
    let attempt = 0;
    const maxA = Math.max(1, Math.round(e.num('maxAttempts')));
    const tryOnce = () => {
      attempt++;
      if (!this.cbAllow(e)) {
        if (e.p.cbFallback === 'success') done(true);
        else done(false, 'circuit_open');
        return;
      }
      e.acc.calls++;
      this.sys.attempts++;
      if (attempt > 1) e.acc.retries++;
      else { this.sys.first++; e.budget = Math.min(e.budget + e.num('retryBudget'), 50); }
      const usePool = callerInst && (target.type === 'database' || target.type === 'cache') && e.num('poolSize') > 0;
      if (usePool) {
        const pool = this.poolFor(e, callerInst!, target);
        this.acquire(e, pool, (ok, cause) => {
          if (!ok) {
            if (e.cbState === 2) e.cbHalfInflight--;
            retryOrFail(cause ?? 'pool_timeout');
            return;
          }
          invoke(() => this.releaseConn(e, pool));
        });
      } else invoke();
    };
    const invoke = (rel0?: () => void) => {
      let settled = false;
      let timerOff = false;
      let rel = rel0;
      const finish = (ok: boolean, c?: string) => {
        if (settled) return;
        settled = true;
        rel?.();
        rel = undefined;
        this.cbRecord(e, ok);
        if (ok) done(true);
        else retryOrFail(c ?? 'error');
      };
      this.at(e.num('timeout'), () => { if (!timerOff) finish(false, 'timeout'); });
      const net = sample(e.p.network as Dist, this.rng);
      const r: Req = { ...req, callerInst };
      if (target.type === 'cache') r.opDone = () => { if (settled) return; timerOff = true; rel?.(); rel = undefined; };
      this.at(net / 2, () => {
        this.deliver(target, r, (ok, c) => {
          this.at(net / 2, () => {
            if (settled) { target.acc.wasted++; return; }
            finish(ok, c);
          });
        });
      });
    };
    const retryOrFail = (c: string) => {
      e.acc.fails++;
      if (attempt < maxA && !NON_RETRYABLE.has(c)) {
        const ratio = e.num('retryBudget');
        let allowed = true;
        if (ratio > 0) {
          if (e.budget >= 1) e.budget -= 1;
          else allowed = false;
        }
        if (allowed) {
          let b = Math.min(e.num('backoffMax'), e.num('backoffBase') * Math.pow(2, attempt - 1));
          if (e.p.jitter) b = this.rng.next() * b;
          this.at(b, tryOnce);
          return;
        }
      }
      done(false, c);
    };
    tryOnce();
  }

  // ------------------------------------------------------------ connection pools
  private poolFor(e: EdgeRT, inst: Instance, target: NodeRT): ConnPool {
    let p = e.pools.get(inst);
    if (!p) {
      p = { size: 0, inUse: 0, opened: 0, waiters: new Fifo(), target };
      e.pools.set(inst, p);
      inst.pools.push({ edge: e, pool: p });
    }
    p.size = Math.max(1, e.num('poolSize'));
    return p;
  }

  private acquire(e: EdgeRT, pool: ConnPool, cb: (ok: boolean, cause?: string) => void) {
    if (pool.inUse < pool.size) {
      if (pool.inUse >= pool.opened) {
        const t = pool.target;
        if (t.type === 'database' && t.openConns >= t.num('maxConnections')) {
          if (this.now - t.lastConnWarn > 15000) {
            t.lastConnWarn = this.now;
            this.log('crit', L(
              `${t.cfg.name}：连接数达到上限 ${t.num('maxConnections')}，新连接被拒绝`,
              `${t.cfg.name}: hit the ${t.num('maxConnections')} connection limit, new connections refused`,
            ), t.cfg.id, undefined, 'conn_limit');
          }
          cb(false, 'too_many_connections');
          return;
        }
        pool.opened++;
        t.openConns++;
      }
      pool.inUse++;
      e.acc.poolWaits.push(0);
      cb(true);
      return;
    }
    const w = { cb, t: this.now, done: false };
    pool.waiters.push(w);
    this.at(e.num('poolTimeout'), () => {
      if (w.done) return;
      w.done = true;
      e.acc.poolWaits.push(this.now - w.t);
      cb(false, 'pool_timeout');
    });
  }

  private releaseConn(e: EdgeRT, pool: ConnPool) {
    pool.inUse = Math.max(0, pool.inUse - 1);
    for (;;) {
      const w = pool.waiters.shift();
      if (!w) return;
      if (w.done) continue;
      w.done = true;
      pool.inUse++;
      e.acc.poolWaits.push(this.now - w.t);
      w.cb(true);
      return;
    }
  }

  // ------------------------------------------------------------ circuit breaker
  private cbAllow(e: EdgeRT): boolean {
    if (!e.p.cbEnabled) { e.cbState = 0; return true; }
    if (e.cbState === 1) {
      if (this.now - e.cbOpenedAt >= e.num('cbOpen') * 1000) {
        e.cbState = 2; e.cbHalfInflight = 0; e.cbHalfOk = 0;
        this.log('info', L(`熔断半开：${this.edgeName(e)} 放行探测请求`, `Circuit half-open: ${this.edgeName(e)} letting probe requests through`), undefined, e.cfg.id, 'cb_half');
      } else return false;
    }
    if (e.cbState === 2) {
      if (e.cbHalfInflight >= 5) return false;
      e.cbHalfInflight++;
    }
    return true;
  }

  private cbRecord(e: EdgeRT, ok: boolean) {
    if (!e.p.cbEnabled) return;
    if (e.cbState === 2) {
      e.cbHalfInflight = Math.max(0, e.cbHalfInflight - 1);
      if (!ok) this.cbOpen(e);
      else if (++e.cbHalfOk >= 5) {
        e.cbState = 0; e.cbBuckets = [];
        this.log('info', L(`熔断关闭：${this.edgeName(e)} 恢复正常`, `Circuit closed: ${this.edgeName(e)} back to normal`), undefined, e.cfg.id, 'cb_close');
      }
      return;
    }
    if (e.cbState !== 0) return;
    const sec = Math.floor(this.now / 1000);
    const win = Math.max(1, e.num('cbWindow'));
    let b = e.cbBuckets[e.cbBuckets.length - 1];
    if (!b || b.sec !== sec) { b = { sec, ok: 0, fail: 0 }; e.cbBuckets.push(b); }
    if (ok) b.ok++; else b.fail++;
    while (e.cbBuckets.length && e.cbBuckets[0].sec <= sec - win) e.cbBuckets.shift();
    if (ok) return;
    let tot = 0, fail = 0;
    for (const x of e.cbBuckets) { tot += x.ok + x.fail; fail += x.fail; }
    if (tot >= e.num('cbMinRequests') && fail / tot >= e.num('cbThreshold')) this.cbOpen(e);
  }

  private cbOpen(e: EdgeRT) {
    e.cbState = 1;
    e.cbOpenedAt = this.now;
    this.log('warn', L(
      `熔断打开：${this.edgeName(e)}，${e.num('cbOpen')}s 内直接${e.p.cbFallback === 'success' ? '降级' : '失败'}`,
      `Circuit open: ${this.edgeName(e)}, ${e.p.cbFallback === 'success' ? 'serving fallbacks' : 'failing fast'} for ${e.num('cbOpen')}s`,
    ), undefined, e.cfg.id, 'cb_open');
  }

  private edgeName(e: EdgeRT) {
    return `${this.nodes.get(e.cfg.from)?.cfg.name ?? '?'} → ${this.nodes.get(e.cfg.to)?.cfg.name ?? '?'}`;
  }

  // ------------------------------------------------------------ autoscale
  private autoscale(rt: NodeRT) {
    if (!rt.p.asEnabled) { rt.asBusy = 0; rt.asCpu = 0; rt.asLast = this.now; return; }
    const period = Math.max(1, rt.num('asPeriod')) * 1000;
    if (this.now - rt.asLast < period) return;
    const dt = this.now - rt.asLast;
    const ready = rt.instances.filter((i) => i.up && i.ready && !i.draining).length || 1;
    const util = rt.type === 'service'
      ? rt.asCpu / (rt.num('cpuCores') * ready * dt)
      : rt.asBusy / (this.workers(rt) * ready * dt);
    rt.asBusy = 0; rt.asCpu = 0; rt.asLast = this.now;
    const target = Math.max(0.05, rt.num('asTarget'));
    let desired = Math.ceil((ready * util) / target);
    if (Math.abs(util / target - 1) < 0.1) desired = ready; // HPA tolerance
    desired = Math.max(rt.num('asMin'), Math.min(rt.num('asMax'), desired));
    rt.asRecs.push({ t: this.now, d: desired });
    const stab = rt.num('asDownStab') * 1000;
    rt.asRecs = rt.asRecs.filter((r) => r.t >= this.now - stab);
    const current = rt.instances.filter((i) => !i.draining).length;
    let eff = desired;
    if (desired < current) eff = Math.min(current, Math.max(...rt.asRecs.map((r) => r.d)));
    if (eff !== current) {
      this.log(eff > current ? 'warn' : 'info', L(
        `${rt.cfg.name}：${eff > current ? '扩容' : '缩容'} ${current} → ${eff}（${rt.type === 'service' ? 'CPU' : '并发'}利用率 ${(util * 100).toFixed(0)}%）`,
        `${rt.cfg.name}: scaling ${eff > current ? 'up' : 'down'} ${current} → ${eff} (${rt.type === 'service' ? 'CPU' : 'concurrency'} at ${(util * 100).toFixed(0)}%)`,
      ), rt.cfg.id, undefined, eff > current ? 'scale_up' : 'scale_down');
      this.setInstanceCount(rt, eff, false, rt.num('asColdStart') * 1000);
    }
  }

  // ------------------------------------------------------------ per-second sampling
  private tickSecond() {
    const nodes: Record<string, NodeSample> = {};
    for (const rt of this.nodes.values()) {
      let busy = 0, queue = 0;
      for (const i of rt.instances) { this.touch(rt, i); busy += i.busy; queue += i.queue.length; }
      const a = rt.acc;
      const lats = a.lats.sort((x, y) => x - y);
      const ready = rt.instances.filter((i) => i.up && i.ready && !i.draining).length;
      let util = 0, cpu = 0;
      if (rt.type === 'service' || rt.type === 'gateway') {
        util = ready > 0 ? a.busyInt / (this.workers(rt) * ready * 1000) : (busy > 0 ? 1 : 0);
        if (rt.type === 'service') cpu = ready > 0 ? a.cpuInt / (rt.num('cpuCores') * ready * 1000) : 0;
      } else if (rt.type === 'cache') {
        util = a.busyInt / (Math.max(1, rt.instances.length) * 1000);
        // hottest shard matters more than the average
      } else if (rt.type === 'database') {
        util = a.busyInt / (this.workers(rt) * Math.max(1, rt.instances.length) * 1000);
      } else if (rt.type === 'external') {
        // how much of the provider's allowance is in use: rate against quota, in-flight against the cap
        const q = rt.num('quotaRps'), cap = rt.num('maxConcurrent');
        util = Math.max(q > 0 ? (a.extra.billed ?? 0) / q : 0, cap > 0 ? a.busyInt / (cap * 1000) : 0);
      }
      const extra: Record<string, number> = {};
      if (rt.type === 'cache') {
        const h = a.extra.hit ?? 0, m = a.extra.miss ?? 0;
        extra.hitRatio = h + m > 0 ? h / (h + m) : NaN;
        let hottest = 0;
        for (const i of rt.instances) hottest = Math.max(hottest, i.queue.length + i.busy);
        extra.hottestQueue = hottest;
        if (rt.p.hitMode === 'capacity') {
          const sh = cacheShape(rt.p);
          extra.fill = sh.capacity > 0 ? Math.min(1, rt.fill / sh.capacity) : 0;
          extra.modelHit = this.cacheHitNow(rt, sh);
        }
      }
      if (rt.type === 'external') {
        extra.billed = a.extra.billed ?? 0;
        extra.inflight = rt.extInflight;
      }
      if (rt.type === 'database') {
        extra.conns = rt.openConns;
        extra.maxConns = rt.num('maxConnections');
      }
      if (rt.type === 'queue') {
        let lag = 0;
        for (const g of rt.groups.values()) for (const p of g.parts) lag += p.length;
        extra.lag = lag;
        extra.consumed = a.extra.consumed ?? 0;
        extra.dlq = a.extra.dlq ?? 0;
        extra.consumers = this.consumerCount(rt);
      }
      if (rt.type === 'service' || rt.type === 'gateway') {
        extra.starting = rt.instances.filter((i) => i.up && !i.ready).length;
        extra.down = rt.instances.filter((i) => !i.up).length;
      }
      nodes[rt.cfg.id] = {
        arr: a.arr, ok: a.ok, err: a.err, wasted: a.wasted,
        p50: percentile(lats, 0.5), p99: percentile(lats, 0.99),
        mean: lats.length ? lats.reduce((x, y) => x + y, 0) / lats.length : 0,
        util: Math.min(1, util), cpu: Math.min(1, cpu), queue, inflight: rt.type === 'external' ? rt.extInflight : busy,
        instances: rt.type === 'cache' || rt.type === 'database' ? rt.instances.length : ready,
        causes: a.causes, extra,
      };
      rt.acc = newAcc();
      if (rt.type === 'service' || rt.type === 'gateway') this.autoscale(rt);
    }
    const edges: Record<string, EdgeSample> = {};
    for (const e of this.edges.values()) {
      const w = e.acc.poolWaits.sort((x, y) => x - y);
      edges[e.cfg.id] = { calls: e.acc.calls, retries: e.acc.retries, fails: e.acc.fails, cb: e.p.cbEnabled ? e.cbState : 0, poolWaitP99: percentile(w, 0.99) };
      e.acc = { calls: 0, retries: 0, fails: 0, poolWaits: [] };
    }
    const s = this.sys;
    const lats = s.lats.sort((x, y) => x - y);
    const done = s.ok + s.fail;
    this.snapshots.push({
      t: Math.round(this.now / 1000),
      sys: {
        t: Math.round(this.now / 1000),
        req: s.req, ok: s.ok, fail: s.fail,
        p50: percentile(lats, 0.5), p95: percentile(lats, 0.95), p99: percentile(lats, 0.99),
        avail: done > 0 ? s.ok / done : 1,
        amplification: s.first > 0 ? s.attempts / s.first : 1,
        causes: s.causes, offered: s.offered,
      },
      nodes, edges,
    });
    this.sys = { req: 0, ok: 0, fail: 0, lats: [], causes: {}, offered: 0, attempts: 0, first: 0 };
    // forget long-finished failures
    this.failures = this.failures.filter((f) => f.end === Infinity || this.now < f.end + f.recovery_s * 1000 + 1000);
    this.at(1000, () => this.tickSecond());
  }
}
