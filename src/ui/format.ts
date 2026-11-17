import type { NodeSample, NodeType, Snapshot, Topology } from '../engine/types';

export function fmtRate(v: number): string {
  if (!isFinite(v)) return '—';
  if (v >= 10000) return `${(v / 1000).toFixed(0)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(0);
  return v.toFixed(1).replace(/\.0$/, '');
}

export function fmtCount(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(0)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return v.toFixed(0);
}

export function fmtPct(v: number, digits = 0): string {
  if (!isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export function fmtAvail(v: number): string {
  if (!isFinite(v)) return '—';
  if (v >= 0.99995) return '100%';
  if (v >= 0.99) return `${(v * 100).toFixed(2)}%`;
  return `${(v * 100).toFixed(1)}%`;
}

export function fmtLatency(v: number): string {
  if (!isFinite(v) || v <= 0) return '—';
  if (v >= 10000) return `${(v / 1000).toFixed(0)}s`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
  if (v >= 10) return `${v.toFixed(0)}ms`;
  return `${v.toFixed(1)}ms`;
}

export function fmtClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

// ---------- latency percentile used for the SLO (set on the traffic source; p95 unless it says p99)
export type Pct = 'p95' | 'p99';
export function sloPct(topo: Topology): Pct {
  const c = topo.nodes.find((n) => n.type === 'client');
  return c?.params.sloPct === 'p99' ? 'p99' : 'p95';
}

// ---------- windowed aggregation over the last N snapshots
export function windowSys(history: Snapshot[], n = 5) {
  const w = history.slice(-n);
  if (w.length === 0) return null;
  let req = 0, ok = 0, fail = 0, attempts = 0, offered = 0;
  let p99 = 0, p95 = 0, p50 = 0, latSum = 0;
  for (const s of w) {
    req += s.sys.req; ok += s.sys.ok; fail += s.sys.fail; offered += s.sys.offered;
    attempts += s.sys.amplification;
    p99 = Math.max(p99, s.sys.p99);
    p95 = Math.max(p95, s.sys.p95);
    p50 += s.sys.p50;
    latSum += (s.sys.mean ?? s.sys.p50) * s.sys.req;
  }
  return {
    rps: req / w.length,
    okRps: ok / w.length,
    failRps: fail / w.length,
    offered: offered / w.length,
    avail: ok + fail > 0 ? ok / (ok + fail) : 1,
    p99,
    p95,
    p50: p50 / w.length,
    /** request-weighted mean latency */
    avg: req > 0 ? latSum / req : 0,
    amplification: attempts / w.length,
  };
}

export function windowNode(history: Snapshot[], id: string, n = 3): NodeSample | null {
  const w = history.slice(-n).map((s) => s.nodes[id]).filter(Boolean) as NodeSample[];
  if (w.length === 0) return null;
  const last = w[w.length - 1];
  const avg = (k: keyof NodeSample) => w.reduce((s, x) => s + (x[k] as number), 0) / w.length;
  return {
    ...last,
    arr: avg('arr'), ok: avg('ok'), err: avg('err'), wasted: avg('wasted'),
    util: avg('util'), cpu: avg('cpu'), p50: avg('p50'),
    mean: (() => { const n = w.reduce((s, x) => s + x.ok + x.err, 0); return n > 0 ? w.reduce((s, x) => s + (x.mean ?? x.p50) * (x.ok + x.err), 0) / n : 0; })(),
    p95: Math.max(...w.map((x) => x.p95 ?? x.p99)),
    p99: Math.max(...w.map((x) => x.p99)),
  };
}

export type Health = 'idle' | 'ok' | 'warn' | 'crit';

export function nodeHealth(type: NodeType, s: NodeSample | null, prevLag?: number): Health {
  if (!s) return 'idle';
  const total = s.ok + s.err;
  const errRate = total > 0 ? s.err / total : 0;
  const load = Math.max(s.util, s.cpu);
  if (type === 'queue') {
    const lag = s.extra.lag ?? 0;
    const consumed = s.extra.consumed ?? 0;
    if (lag > 0 && prevLag !== undefined && lag > prevLag * 1.02 && lag > Math.max(50, consumed * 3)) return 'crit';
    if (lag > Math.max(50, consumed * 2)) return 'warn';
    return s.arr > 0 || consumed > 0 ? 'ok' : 'idle';
  }
  if (type === 'client') {
    if (errRate > 0.01) return 'crit';
    if (errRate > 0.001) return 'warn';
    return s.arr > 0 ? 'ok' : 'idle';
  }
  if (s.arr === 0 && s.inflight === 0) return 'idle';
  if (errRate > 0.05 || load >= 0.97) return 'crit';
  if (errRate > 0.005 || load >= 0.75 || s.queue > 0) return 'warn';
  if (type === 'database' && (s.extra.conns ?? 0) >= 0.9 * (s.extra.maxConns ?? Infinity)) return 'warn';
  return 'ok';
}

export function utilLabel(type: NodeType, s: NodeSample, lang: 'zh' | 'en' = 'zh'): { kind: string; value: number } | null {
  const t = (zh: string, en: string) => (lang === 'en' ? en : zh);
  switch (type) {
    case 'service':
      return s.cpu >= s.util ? { kind: 'CPU', value: s.cpu } : { kind: t('线程', 'Threads'), value: s.util };
    case 'gateway':
      return { kind: t('并发', 'Concurrency'), value: s.util };
    case 'cache':
      return { kind: t('分片', 'Shards'), value: s.util };
    case 'database':
      return { kind: t('执行', 'Executing'), value: s.util };
    case 'external':
      return { kind: t('配额', 'Quota'), value: s.util };
    default:
      return null;
  }
}
