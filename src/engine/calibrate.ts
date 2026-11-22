// Calibration: backsolve model parameters from a handful of production metrics so the simulated
// "today" matches the measured baseline (typically a peak hour).
//
// Inputs per component (CSV, matched to nodes by name): QPS, mean response time, CPU utilization,
// pods, cores per pod, threads per pod, DB pool per pod, and a few type-specific extras.
//
// Method
//   1. Structural values are copied straight in: pods → instances, cores → cpuCores, threads → workers,
//      pool sizes onto outgoing DB edges, max connections, cache hit ratio, client rate.
//   2. Service times are solved by fixed-point iteration against the analytical model (analysis.ts):
//      the model predicts each node's mean response time (own time + queueing + downstream calls);
//      own time is nudged until the prediction matches the measurement. Leaves converge first,
//      callers follow, so the call graph is solved bottom-up without special ordering.
//   3. The CPU share of a service's own time comes from the utilization law:
//      CPU time per request = CPU% × pods × cores / QPS.
//   4. Sanity checks flag inputs that cannot all be true at once.
// verifyCalibration() then runs the discrete-event simulator at the measured load and reports
// measured vs simulated values, so nobody has to take the backsolve on faith.
import { analyze, type NodeEstimate } from './analysis';
import { mean } from './dist';
import { EDGE_SPECS, NODE_SPECS, withDefaults } from './specs';
import { Simulator } from './sim';
import { defaultLayer, evalProgram, isProgram } from './traffic';
import { L, type Dist, type NodeCfg, type NodeType, type Text, type Topology } from './types';

// ------------------------------------------------------------------ CSV

export const CAL_COLUMNS = [
  'name', 'type', 'qps', 'avg_ms', 'p99_ms', 'cpu_util', 'pods', 'cores_per_pod',
  'threads_per_pod', 'db_pool_per_pod', 'max_connections', 'hit_ratio',
] as const;
type NumCol = Exclude<(typeof CAL_COLUMNS)[number], 'name' | 'type'>;

export interface CalRow {
  line: number;
  name: string;
  type?: NodeType;
  qps?: number;
  avg_ms?: number;
  p99_ms?: number;
  cpu_util?: number; // 0..1
  pods?: number;
  cores_per_pod?: number;
  threads_per_pod?: number;
  db_pool_per_pod?: number;
  max_connections?: number;
  hit_ratio?: number; // 0..1
}

const TYPE_ALIASES: Record<string, NodeType> = {
  client: 'client', traffic: 'client', source: 'client',
  gateway: 'gateway', 'api gateway': 'gateway', api_gateway: 'gateway',
  lb: 'lb', load_balancer: 'lb', 'load balancer': 'lb',
  service: 'service', svc: 'service',
  cache: 'cache', redis: 'cache',
  database: 'database', db: 'database', postgres: 'database', mysql: 'database',
  queue: 'queue', kafka: 'queue', message_queue: 'queue',
  external: 'external', third_party: 'external', 'third-party': 'external', 'third party': 'external', 'third-party api': 'external', 'third party api': 'external',
};

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Parse the calibration CSV. Blank cells mean "keep the template value". */
export function parseCalibrationCsv(text: string): { rows: CalRow[]; errors: Text[] } {
  const errors: Text[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let hi = lines.findIndex((l) => l.trim() && !l.trim().startsWith('#'));
  if (hi < 0) return { rows: [], errors: [L('CSV 是空的', 'The CSV is empty')] };
  const header = splitCsvLine(lines[hi]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  if (!header.includes('name')) {
    return { rows: [], errors: [L('第一行必须是表头，并且包含 name 列', 'The first line must be a header with a name column')] };
  }
  const unknown = header.filter((h) => h && !(CAL_COLUMNS as readonly string[]).includes(h));
  if (unknown.length) errors.push(L(`忽略未知的列：${unknown.join(', ')}`, `Ignored unknown columns: ${unknown.join(', ')}`));
  const rows: CalRow[] = [];
  for (let i = hi + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const cells = splitCsvLine(raw);
    const row: CalRow = { line: i + 1, name: '' };
    header.forEach((h, j) => {
      const v = (cells[j] ?? '').trim();
      if (!v) return;
      if (h === 'name') { row.name = v; return; }
      if (h === 'type') {
        const tp = TYPE_ALIASES[v.toLowerCase()];
        if (tp) row.type = tp;
        else errors.push(L(`第 ${i + 1} 行：不认识的类型“${v}”`, `Line ${i + 1}: unknown type “${v}”`));
        return;
      }
      if (!(CAL_COLUMNS as readonly string[]).includes(h)) return;
      const pct = v.endsWith('%');
      let n = Number(v.replace(/[%,\s]/g, '').replace(/ms$/i, ''));
      if (!isFinite(n) || n < 0) {
        errors.push(L(`第 ${i + 1} 行 ${h}：“${v}”不是有效的数字`, `Line ${i + 1}, ${h}: “${v}” is not a valid number`));
        return;
      }
      // utilization and hit ratio accept 0.38, 38 or 38%
      if ((h === 'cpu_util' || h === 'hit_ratio') && (pct || n > 1)) n /= 100;
      (row as unknown as Record<NumCol, number>)[h as NumCol] = n;
    });
    if (!row.name) { errors.push(L(`第 ${i + 1} 行缺少 name，已跳过`, `Line ${i + 1} has no name and was skipped`)); continue; }
    rows.push(row);
  }
  if (!rows.length) errors.push(L('CSV 里没有数据行', 'The CSV has no data rows'));
  return { rows, errors };
}

// ------------------------------------------------------------------ calibration

export interface CalChange { nodeId: string; nodeName: string; what: Text; from: string; to: string }
export interface CalWarning { nodeId?: string; nodeName?: string; text: Text }
export interface CalMatch { row: CalRow; nodeId: string }
export interface CalibrationResult {
  topology: Topology;
  matches: CalMatch[];
  unmatched: CalRow[];
  changes: CalChange[];
  warnings: CalWarning[];
  converged: boolean;
  iterations: number;
  /** Analytical prediction for each matched node after calibration. */
  predicted: Record<string, NodeEstimate>;
}

export interface CalibrationOptions {
  /** Share of measured CPU not caused by requests (GC, sidecars, logging, cron), 0..0.9. */
  cpuOverhead?: number;
  source?: string;
}

const MIN_MS = 0.02;
const fmt = (v: number, unit = '') => {
  if (!isFinite(v)) return '—';
  const s = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3);
  return `${s.includes('.') ? s.replace(/\.?0+$/, '') : s}${unit}`;
};
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** A distribution with the same shape (p99 / median) but a new mean. */
function withMean(d: Dist, m: number, p99Ratio?: number): Dist {
  m = Math.max(MIN_MS, m);
  switch (d.dist) {
    case 'constant': return { dist: 'constant', value: m };
    case 'exponential': return { dist: 'exponential', mean: m };
    case 'lognormal': {
      const r = p99Ratio ?? Math.max(1, d.p99 / Math.max(d.median, 1e-9));
      const sigma = Math.log(r) / 2.3263;
      const median = m / Math.exp((sigma * sigma) / 2);
      return { dist: 'lognormal', median, p99: median * r };
    }
  }
}
function scaleDist(d: Dist, k: number): Dist {
  switch (d.dist) {
    case 'constant': return { dist: 'constant', value: Math.max(MIN_MS, d.value * k) };
    case 'exponential': return { dist: 'exponential', mean: Math.max(MIN_MS, d.mean * k) };
    case 'lognormal': return { dist: 'lognormal', median: Math.max(MIN_MS, d.median * k), p99: Math.max(MIN_MS, d.p99 * k) };
  }
}
const distText = (d: Dist) => (d.dist === 'lognormal' ? `${fmt(d.median, 'ms')} / p99 ${fmt(d.p99, 'ms')}` : `${fmt(mean(d), 'ms')}`);

/** Match CSV rows to topology nodes by name (case- and space-insensitive), then by id. */
export function matchRows(topo: Topology, rows: CalRow[]): { matches: CalMatch[]; unmatched: CalRow[]; warnings: CalWarning[] } {
  const byName = new Map(topo.nodes.map((n) => [norm(n.name), n]));
  const byId = new Map(topo.nodes.map((n) => [norm(n.id), n]));
  const matches: CalMatch[] = [], unmatched: CalRow[] = [], warnings: CalWarning[] = [];
  const used = new Set<string>();
  for (const r of rows) {
    const n = byName.get(norm(r.name)) ?? byId.get(norm(r.name));
    if (!n) { unmatched.push(r); continue; }
    if (used.has(n.id)) { warnings.push({ nodeId: n.id, nodeName: n.name, text: L(`“${r.name}”出现了多次，只用第一行`, `“${r.name}” appears more than once; only the first row is used`) }); continue; }
    if (r.type && r.type !== n.type) {
      warnings.push({ nodeId: n.id, nodeName: n.name, text: L(`CSV 里写的类型是 ${r.type}，画布上是 ${n.type}，按画布处理`, `The CSV says ${r.type} but the canvas has a ${n.type}; using the canvas type`) });
    }
    used.add(n.id);
    matches.push({ row: r, nodeId: n.id });
  }
  return { matches, unmatched, warnings };
}

export function calibrate(source: Topology, rows: CalRow[], opts: CalibrationOptions = {}): CalibrationResult {
  const topo: Topology = JSON.parse(JSON.stringify(source));
  const overhead = Math.min(0.9, Math.max(0, opts.cpuOverhead ?? 0));
  const { matches, unmatched, warnings } = matchRows(topo, rows);
  const nodes = new Map(topo.nodes.map((n) => [n.id, n]));
  const rowOf = new Map(matches.map((m) => [m.nodeId, m.row]));
  const before = new Map(source.nodes.map((n) => [n.id, withDefaults(NODE_SPECS[n.type].params, n.params)]));
  const rawBefore = new Map(source.nodes.map((n) => [n.id, n.params as Record<string, unknown>]));
  const beforeEdges = new Map(source.edges.map((e) => [e.id, withDefaults(EDGE_SPECS, e.params)]));
  const P = (n: NodeCfg) => { n.params = withDefaults(NODE_SPECS[n.type].params, n.params); return n.params; };
  const warn = (n: NodeCfg | undefined, zh: string, en: string) => warnings.push({ nodeId: n?.id, nodeName: n?.name, text: L(zh, en) });

  // ---- 1. structural values
  for (const { row: r, nodeId } of matches) {
    const n = nodes.get(nodeId)!;
    const p = P(n);
    switch (n.type) {
      case 'client':
        if (r.qps !== undefined) {
          p.traffic = { base: defaultLayer('constant', { rps: Math.round(r.qps) }), overlays: [] };
          p.rps = Math.round(r.qps);
          p.pattern = 'constant';
        }
        break;
      case 'service':
      case 'gateway':
        if (r.pods !== undefined) {
          const cap = NODE_SPECS[n.type].params.find((x) => x.key === 'instances')?.max ?? Infinity;
          const pods = Math.max(1, Math.round(r.pods));
          if (pods > cap) warn(n, `测得 ${pods} 个 Pod，超过实例数上限 ${cap}，按 ${cap} 计算`, `Measured ${pods} pods, above the ${cap}-instance limit; using ${cap}`);
          p.instances = Math.min(pods, cap);
        }
        if (r.threads_per_pod !== undefined) p.workers = Math.max(1, Math.round(r.threads_per_pod));
        if (r.cores_per_pod !== undefined) {
          if (n.type === 'service') p.cpuCores = r.cores_per_pod;
          else warn(n, 'Gateway 不模拟 CPU，忽略 cores_per_pod', 'The gateway does not model CPU; cores_per_pod ignored');
        }
        if (r.db_pool_per_pod !== undefined) {
          const dbEdges = topo.edges.filter((e) => e.from === n.id && nodes.get(e.to)?.type === 'database');
          if (!dbEdges.length) warn(n, '给了 db_pool_per_pod，但这个组件没有连到数据库', 'db_pool_per_pod given, but this component has no call to a database');
          for (const e of dbEdges) e.params = { ...withDefaults(EDGE_SPECS, e.params), poolSize: Math.max(1, Math.round(r.db_pool_per_pod)) };
        }
        if (n.type === 'service' && p.asEnabled && r.pods !== undefined) {
          warn(n, '自动扩缩容是开着的，运行中实例数可能偏离测量值', 'Autoscaling is on, so the instance count may drift from the measured pods during a run');
        }
        break;
      case 'database':
        if (r.max_connections !== undefined) p.maxConnections = Math.max(1, Math.round(r.max_connections));
        break;
      case 'cache':
        if (r.hit_ratio !== undefined) { p.hitMode = 'fixed'; p.hitRatio = Math.min(1, r.hit_ratio); }
        break;
      default:
        break;
    }
  }
  // Entry rate: if a client has no row, take the measured QPS of what it feeds.
  for (const c of topo.nodes.filter((n) => n.type === 'client' && !rowOf.get(n.id)?.qps)) {
    const outs = topo.edges.filter((e) => e.from === c.id);
    const qs = outs.map((e) => rowOf.get(e.to)?.qps);
    const fedOnlyByMe = outs.every((e) => topo.edges.filter((x) => x.to === e.to).every((x) => x.from === c.id));
    if (outs.length && qs.every((q) => q !== undefined) && fedOnlyByMe) {
      const rps = Math.round(qs.reduce((s, q) => s + q!, 0));
      const p = P(c);
      p.traffic = { base: defaultLayer('constant', { rps }), overlays: [] };
      p.rps = rps; p.pattern = 'constant';
      warn(c, `流量源没有数据行，按下游测得的 QPS 设为 ${rps}/s`, `No row for this traffic source; set it to ${rps}/s from the measured QPS of what it calls`);
    }
  }

  // ---- 2. fixed-point fit of service times
  const fitIds = matches.filter((m) => m.row.avg_ms !== undefined && ['service', 'gateway', 'database', 'cache', 'external'].includes(nodes.get(m.nodeId)!.type)).map((m) => m.nodeId);
  for (const m of matches) {
    const n = nodes.get(m.nodeId)!;
    if (m.row.avg_ms !== undefined && (n.type === 'lb' || n.type === 'queue' || n.type === 'client')) {
      warn(n, `${n.type} 的 avg_ms 不参与反推（它没有可调的处理时间）`, `avg_ms on a ${n.type} is not used (it has no processing time to solve for)`);
    }
  }
  const outsOf = (id: string) => topo.edges.filter((e) => e.from === id);
  let converged = fitIds.length === 0, it = 0, est = new Map<string, NodeEstimate>();
  const fail = new Set<string>();
  const cpuOver = new Map<string, [number, number] | undefined>();
  for (it = 1; it <= 60 && !converged; it++) {
    const a = analyze(topo);
    est = new Map(a.nodes.map((e) => [e.id, e]));
    let worst = 0;
    for (const id of fitIds) {
      const n = nodes.get(id)!, p = P(n), r = rowOf.get(id)!, e = est.get(id);
      if (!e || e.lambda <= 0) { fail.add(id); continue; }
      const R = r.avg_ms!;
      const L0 = e.latency;
      if (n.type === 'service') {
        const S = mean(p.serviceTime as Dist);
        const next = isFinite(L0) ? S + (R - L0) : S * 0.6;
        const ratio = r.p99_ms !== undefined ? Math.min(20, Math.max(1.5, r.p99_ms / R)) : undefined;
        p.serviceTime = withMean(p.serviceTime as Dist, next, ratio);
        if (next < MIN_MS) fail.add(id); else fail.delete(id);
        // CPU share from the utilization law, refreshed every round because CPU queueing feeds back
        // into the predicted response time.
        if (r.cpu_util !== undefined) {
          const S1 = mean(p.serviceTime as Dist);
          const cpuMs = (r.cpu_util * (1 - overhead) * Number(p.cpuCores) * Number(p.instances) * 1000) / e.lambda;
          cpuOver.set(id, cpuMs / Math.max(S1, MIN_MS) > 1 ? [cpuMs, S1] : undefined);
          p.cpuFraction = Math.round(Math.min(1, Math.max(0.01, cpuMs / Math.max(S1, MIN_MS))) * 1000) / 1000;
        }
        worst = Math.max(worst, Math.abs(mean(p.serviceTime as Dist) - S) / Math.max(S, 0.1));
      } else if (n.type === 'gateway') {
        // own overhead = measured − weighted downstream (by where traffic actually goes)
        const outs = outsOf(id);
        const lamSum = outs.reduce((s, o) => s + (est.get(o.to)?.lambda ?? 0), 0);
        let D = 0;
        for (const o of outs) {
          const ch = est.get(o.to);
          if (!ch || lamSum <= 0) continue;
          D += (ch.lambda / lamSum) * (mean(withDefaults(EDGE_SPECS, o.params).network as Dist) + (isFinite(ch.latency) ? ch.latency : 0));
        }
        const auth = mean(p.authLatency as Dist);
        const own = R - D - auth;
        const S = mean(p.latency as Dist);
        p.latency = withMean(p.latency as Dist, own);
        if (own < MIN_MS) fail.add(id); else fail.delete(id);
        worst = Math.max(worst, Math.abs(mean(p.latency as Dist) - S) / Math.max(S, 0.1));
      } else if (n.type === 'database') {
        const k = isFinite(L0) && L0 > 0 ? R / L0 : 0.6;
        const kk = Math.min(3, Math.max(0.33, k));
        p.readTime = scaleDist(p.readTime as Dist, kk);
        p.writeTime = scaleDist(p.writeTime as Dist, kk);
        worst = Math.max(worst, Math.abs(kk - 1));
      } else if (n.type === 'external') {
        // a black box: what you measure from your side is its response time
        const S = mean(p.latency as Dist);
        const ratio = r.p99_ms !== undefined ? Math.min(20, Math.max(1.5, r.p99_ms / R)) : undefined;
        p.latency = withMean(p.latency as Dist, R, ratio);
        worst = Math.max(worst, Math.abs(R - S) / Math.max(S, 0.1));
      } else if (n.type === 'cache') {
        // A cache's measured latency is the command itself; the origin fetch on a miss is the
        // caller's time in production, so it is left out here.
        const S = mean(p.opLatency as Dist);
        const rho = Math.min(0.95, e.util);
        const wqFactor = 1 + (rho / (1 - rho)) * 1; // M/G/1, lognormal scv ≈ 1
        const next = R / wqFactor;
        p.opLatency = withMean(p.opLatency as Dist, next);
        worst = Math.max(worst, Math.abs(next - S) / Math.max(S, 0.01));
      }
    }
    if (worst < 0.002) converged = true;
  }

  // ---- 3. CPU time that does not fit inside the request
  for (const [id, over] of cpuOver) {
    if (!over) continue;
    const [cpuMs, S] = over;
    warn(nodes.get(id), `CPU 利用率意味着每个请求要 ${fmt(cpuMs, 'ms')} CPU，比它自身处理时间 ${fmt(S, 'ms')} 还长。可能 CPU 里有后台开销（调高“CPU 额外开销”），或者 avg_ms 偏低。已按 100% CPU 处理`,
      `CPU utilization implies ${fmt(cpuMs, 'ms')} of CPU per request, more than its own processing time of ${fmt(S, 'ms')}. The CPU figure probably includes background work (raise “CPU overhead”), or avg_ms is too low. Treated as 100% CPU`);
  }
  const after = analyze(topo);
  est = new Map(after.nodes.map((e) => [e.id, e]));

  // ---- 4. sanity checks
  for (const id of fail) {
    const n = nodes.get(id)!;
    const e = est.get(id);
    if (!e || e.lambda <= 0) warn(n, '按当前拓扑，没有流量会到达这个组件，无法反推', 'With the current topology no traffic reaches this component, so nothing could be solved');
    else warn(n, '测得的平均响应时间比它的下游调用加起来还短。检查每请求调用次数，或下游的 avg_ms', 'The measured mean response time is shorter than its downstream calls add up to. Check calls per request or the downstream avg_ms');
  }
  if (!converged) warnings.push({ text: L('迭代没有完全收敛，结果是近似值', 'The fit did not fully converge; the result is approximate') });
  for (const { row: r, nodeId } of matches) {
    const n = nodes.get(nodeId)!, e = est.get(nodeId), p = P(n);
    if (!e) continue;
    if (r.qps !== undefined && n.type !== 'client' && e.lambda > 0 && Math.abs(e.lambda - r.qps) / r.qps > 0.15) {
      warn(n, `按拓扑推算到达这里的流量是 ${fmt(e.lambda)}/s，测得 ${fmt(r.qps)}/s。检查分流权重、每请求调用次数或入口流量`,
        `The topology routes ${fmt(e.lambda)}/s here, but ${fmt(r.qps)}/s was measured. Check split weights, calls per request or the entry rate`);
    }
    if ((n.type === 'service' || n.type === 'gateway') && r.avg_ms !== undefined && r.qps !== undefined) {
      const inflight = (r.qps * r.avg_ms) / 1000 / Number(p.instances);
      if (inflight > 0.8 * Number(p.workers)) {
        warn(n, `每个 pod 平均 ${fmt(inflight)} 个在途请求，接近线程池 ${p.workers}。基线已经接近饱和`, `About ${fmt(inflight)} requests in flight per pod against ${p.workers} threads: already near saturation at baseline`);
      }
    }
    if (e.util > 0.85 && isFinite(e.util)) {
      warn(n, `基线利用率已达 ${pct(Math.min(1, e.util))}（${e.utilKind.zh}），往上外推的结果误差会变大`, `Baseline utilization is already ${pct(Math.min(1, e.util))} (${e.utilKind.en}); extrapolating further up is less reliable`);
    }
  }
  for (const db of topo.nodes.filter((n) => n.type === 'database')) {
    const max = Number(P(db).maxConnections);
    let demand = 0;
    for (const e of topo.edges.filter((x) => x.to === db.id)) {
      const from = nodes.get(e.from);
      if (!from || (from.type !== 'service' && from.type !== 'gateway')) continue;
      demand += Number(P(from).instances) * Number(withDefaults(EDGE_SPECS, e.params).poolSize);
    }
    if (demand > max) warn(db, `调用方连接池加起来 ${demand}，超过数据库上限 ${max}，峰值时会拒绝连接`, `Caller pools add up to ${demand} connections, above the database limit of ${max}; connections will be refused at peak`);
  }

  // ---- 5. what changed
  const changes: CalChange[] = [];
  const push = (n: NodeCfg, what: Text, a: string, b: string) => { if (a !== b) changes.push({ nodeId: n.id, nodeName: n.name, what, from: a, to: b }); };
  for (const n of topo.nodes) {
    const b = before.get(n.id);
    if (!b) continue;
    const p = n.params;
    const num = (k: string, label: Text, f: (v: number) => string = (v) => fmt(v)) => p[k] !== undefined && push(n, label, f(Number(b[k])), f(Number(p[k])));
    const dist = (k: string, label: Text) => p[k] !== undefined && push(n, label, distText(b[k] as Dist), distText(p[k] as Dist));
    switch (n.type) {
      case 'client': {
        const rate = (q: Record<string, unknown>) => (isProgram(q.traffic) ? evalProgram(q.traffic, 0) : Number(q.rps));
        push(n, L('入口流量', 'Entry rate'), `${fmt(rate(rawBefore.get(n.id) ?? b))}/s`, `${fmt(rate(p))}/s`);
        break;
      }
      case 'service':
        num('instances', L('实例数', 'Instances')); num('cpuCores', L('每实例核数', 'Cores per instance')); num('workers', L('每实例线程数', 'Threads per instance'));
        dist('serviceTime', L('本地处理时间', 'Local processing time')); num('cpuFraction', L('CPU 占比', 'CPU share'), pct);
        break;
      case 'gateway':
        num('instances', L('实例数', 'Instances')); num('workers', L('每实例并发', 'Concurrency per instance')); dist('latency', L('自身处理时间', 'Processing time'));
        break;
      case 'database':
        num('maxConnections', L('最大连接数', 'Max connections')); dist('readTime', L('读查询时间', 'Read query time')); dist('writeTime', L('写查询时间', 'Write query time'));
        break;
      case 'external':
        dist('latency', L('响应时间', 'Response time'));
        break;
      case 'cache':
        dist('opLatency', L('命令执行时间', 'Command time'));
        if (p.hitMode !== b.hitMode) push(n, L('命中率模式', 'Hit ratio mode'), String(b.hitMode), String(p.hitMode));
        num('hitRatio', L('命中率', 'Hit ratio'), pct);
        break;
      default: break;
    }
  }
  for (const e of topo.edges) {
    const b = beforeEdges.get(e.id);
    if (!b || e.params.poolSize === undefined || Number(b.poolSize) === Number(e.params.poolSize)) continue;
    const from = nodes.get(e.from)!, to = nodes.get(e.to)!;
    changes.push({ nodeId: from.id, nodeName: from.name, what: L(`连接池 → ${to.name}`, `Pool → ${to.name}`), from: String(b.poolSize), to: String(e.params.poolSize) });
  }

  topo.calibration = {
    source: opts.source ?? 'CSV',
    appliedAt: new Date().toISOString(),
    components: matches.length,
  };
  const predicted: Record<string, NodeEstimate> = {};
  for (const m of matches) { const e = est.get(m.nodeId); if (e) predicted[m.nodeId] = e; }
  return { topology: topo, matches, unmatched, changes, warnings, converged, iterations: it - 1, predicted };
}

// ------------------------------------------------------------------ verification

export interface VerifyLine {
  nodeId: string;
  nodeName: string;
  metric: 'qps' | 'avg_ms' | 'cpu_util' | 'hit_ratio';
  measured: number;
  simulated: number;
  /** Relative error, simulated vs measured (0.08 = 8%). */
  error: number;
}
export interface VerifyResult { lines: VerifyLine[]; medianError: number; maxError: number; seconds: number }

/**
 * Run the discrete-event simulator at the measured load and compare with the measurements.
 * Synchronous; ~0.2–2 s of wall time depending on traffic.
 */
export function verifyCalibration(topo: Topology, matches: CalMatch[], opts: { seconds?: number; warmup?: number; seed?: number; cpuOverhead?: number } = {}): VerifyResult {
  const { seconds = 60, warmup = 15, seed = 23 } = opts;
  const overhead = Math.min(0.9, Math.max(0, opts.cpuOverhead ?? 0));
  const sim = new Simulator(topo, seed);
  sim.advance(warmup * 1000);
  sim.drainSnapshots();
  sim.advance((warmup + seconds) * 1000);
  const snaps = sim.drainSnapshots();
  const types = new Map(topo.nodes.map((n) => [n.id, n]));
  const lines: VerifyLine[] = [];
  const add = (m: CalMatch, metric: VerifyLine['metric'], measured: number | undefined, simulated: number) => {
    if (measured === undefined || !isFinite(simulated)) return;
    const n = types.get(m.nodeId)!;
    const error = measured > 0 ? Math.abs(simulated - measured) / measured : Math.abs(simulated);
    lines.push({ nodeId: n.id, nodeName: n.name, metric, measured, simulated, error });
  };
  for (const m of matches) {
    const n = types.get(m.nodeId)!;
    const s = snaps.map((x) => x.nodes[m.nodeId]).filter(Boolean);
    if (!s.length) continue;
    const arr = s.reduce((a, x) => a + x.arr, 0) / s.length;
    const cnt = s.reduce((a, x) => a + x.ok + x.err, 0);
    const meanLat = cnt > 0 ? s.reduce((a, x) => a + (x.mean ?? x.p50) * (x.ok + x.err), 0) / cnt : NaN;
    add(m, 'qps', m.row.qps, arr);
    if (n.type === 'service' || n.type === 'gateway' || n.type === 'database' || n.type === 'external') add(m, 'avg_ms', m.row.avg_ms, meanLat);
    if (n.type === 'service') add(m, 'cpu_util', m.row.cpu_util, s.reduce((a, x) => a + x.cpu, 0) / s.length / (1 - overhead)); // add back the non-request share
    if (n.type === 'cache') {
      const hits = s.map((x) => x.extra.hitRatio).filter((v) => v !== undefined);
      if (hits.length) add(m, 'hit_ratio', m.row.hit_ratio, hits.reduce((a, v) => a + v, 0) / hits.length);
    }
  }
  const errs = lines.map((l) => l.error).sort((a, b) => a - b);
  const medianError = errs.length ? errs[Math.floor((errs.length - 1) / 2)] : 0;
  return { lines, medianError, maxError: errs.length ? errs[errs.length - 1] : 0, seconds };
}

// ------------------------------------------------------------------ template

/** A CSV pre-filled with the current topology's names and the model's own predictions. */
export function templateCsv(topo: Topology): string {
  const a = analyze(topo);
  const est = new Map(a.nodes.map((e) => [e.id, e]));
  const lines = [CAL_COLUMNS.join(',')];
  const q = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  for (const n of topo.nodes) {
    const p = withDefaults(NODE_SPECS[n.type].params, n.params);
    const e = est.get(n.id);
    const lam = e ? Math.round(e.lambda) : '';
    const lat = e && isFinite(e.latency) ? Number(e.latency.toFixed(1)) : '';
    const cell = (v: unknown) => (v === undefined || v === '' ? '' : String(v));
    const row: Record<string, unknown> = { name: q(n.name), type: n.type };
    switch (n.type) {
      case 'client': row.qps = lam || cell(p.rps); break;
      case 'service':
        Object.assign(row, { qps: lam, avg_ms: lat, cpu_util: e ? Number(Math.min(1, e.cpu).toFixed(2)) : '', pods: p.instances, cores_per_pod: p.cpuCores, threads_per_pod: p.workers });
        {
          const db = topo.edges.find((x) => x.from === n.id && topo.nodes.find((y) => y.id === x.to)?.type === 'database');
          if (db) row.db_pool_per_pod = withDefaults(EDGE_SPECS, db.params).poolSize;
        }
        break;
      case 'gateway': Object.assign(row, { qps: lam, avg_ms: lat, pods: p.instances, threads_per_pod: p.workers }); break;
      case 'database': Object.assign(row, { qps: lam, avg_ms: lat, max_connections: p.maxConnections }); break;
      case 'external': Object.assign(row, { qps: lam, avg_ms: lat }); break;
      case 'cache': Object.assign(row, { qps: lam, avg_ms: Number(mean(p.opLatency as Dist).toFixed(2)), hit_ratio: p.hitMode === 'fixed' ? p.hitRatio : '' }); break;
      default: Object.assign(row, { qps: lam }); break;
    }
    lines.push(CAL_COLUMNS.map((c) => cell(row[c])).join(','));
  }
  return lines.join('\n') + '\n';
}
