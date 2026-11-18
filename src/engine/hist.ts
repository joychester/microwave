// Compact latency histograms: log-spaced buckets, 4% wide, so a percentile read back from one
// is within about ±2% of the exact value. Per-second histograms can be merged to get true
// percentiles over any window (unlike averaging or taking the max of per-second percentiles).

const MIN = 0.05; // ms; everything below lands in bucket 0
const STEP = Math.log(1.04);

/** Sparse histogram, flattened: [bucket, count, bucket, count, ...] with buckets ascending. */
export type Hist = number[];

export function bucketOf(ms: number): number {
  return ms <= MIN ? 0 : Math.floor(Math.log(ms / MIN) / STEP) + 1;
}

/** Representative value of a bucket (its geometric middle). */
export function bucketValue(b: number): number {
  return b === 0 ? MIN : MIN * Math.exp((b - 0.5) * STEP);
}

/** Histogram of latencies sorted ascending. */
export function histOfSorted(sorted: number[]): Hist {
  const out: Hist = [];
  let cur = -1, n = 0;
  for (const v of sorted) {
    const b = bucketOf(v);
    if (b !== cur) {
      if (n > 0) out.push(cur, n);
      cur = b; n = 0;
    }
    n++;
  }
  if (n > 0) out.push(cur, n);
  return out;
}

/** Adds a histogram into a running bucket → count map. */
export function addHist(into: Map<number, number>, h: Hist | undefined): void {
  if (!h) return;
  for (let i = 0; i < h.length; i += 2) into.set(h[i], (into.get(h[i]) ?? 0) + h[i + 1]);
}

export function mergeHists(hs: (Hist | undefined)[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const h of hs) addHist(m, h);
  return m;
}

export function histCount(m: Map<number, number>): number {
  let n = 0;
  for (const c of m.values()) n += c;
  return n;
}

/** Percentile (q in 0..1) of a merged histogram; 0 when empty. Same rank rule as the engine's percentile(). */
export function histPct(m: Map<number, number>, q: number): number {
  const n = histCount(m);
  if (n === 0) return 0;
  const rank = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
  const keys = [...m.keys()].sort((a, b) => a - b);
  let seen = 0;
  for (const k of keys) {
    seen += m.get(k)!;
    if (seen > rank) return bucketValue(k);
  }
  return bucketValue(keys[keys.length - 1]);
}
