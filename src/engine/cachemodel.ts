// Cache hit ratio from first principles: LRU under Zipf-distributed key popularity,
// using Che's approximation. Ranks are integrated in log-spaced bins so millions of
// keys cost a few hundred operations; results are memoised.
//
//   p_i = i^-s / H                      popularity of the i-th most popular key
//   Σ_i (1 − e^{−p_i T}) = C            characteristic time T for capacity C
//   hit = Σ_i p_i (1 − e^{−p_i T})

interface Bins { count: number[]; prob: number[]; top: number }

const binCache = new Map<string, Bins>();
function bins(keys: number, s: number): Bins {
  const N = Math.max(1, Math.round(keys));
  const key = `${N}|${s.toFixed(3)}`;
  const hit = binCache.get(key);
  if (hit) return hit;
  const count: number[] = [];
  const weight: number[] = [];
  const exact = Math.min(N, 64);
  for (let i = 1; i <= exact; i++) { count.push(1); weight.push(Math.pow(i, -s)); }
  if (N > exact) {
    const nb = 160;
    const lo = Math.log(exact + 0.5);
    const hi = Math.log(N + 0.5);
    let prev = exact;
    for (let b = 1; b <= nb; b++) {
      const edge = Math.min(N, Math.round(Math.exp(lo + ((hi - lo) * b) / nb)));
      if (edge <= prev) continue;
      const a = prev + 1;
      const c = edge - prev;
      // average of i^-s over [a, edge] via the integral
      const integ = Math.abs(s - 1) < 1e-6 ? Math.log((edge + 0.5) / (a - 0.5)) : (Math.pow(edge + 0.5, 1 - s) - Math.pow(a - 0.5, 1 - s)) / (1 - s);
      count.push(c);
      weight.push(integ / c);
      prev = edge;
    }
  }
  let H = 0;
  for (let i = 0; i < count.length; i++) H += count[i] * weight[i];
  const prob = weight.map((w) => w / H);
  const out = { count, prob, top: prob[0] };
  binCache.set(key, out);
  return out;
}

const hitCache = new Map<string, number>();

/** Steady-state LRU hit ratio for a cache holding `capacity` keys out of `keys`, Zipf skew s. */
export function cheHitRatio(capacity: number, keys: number, s: number): number {
  const N = Math.max(1, keys);
  if (capacity <= 0) return 0;
  if (capacity >= N) return 1;
  const k = `${Math.round(capacity)}|${Math.round(N)}|${s.toFixed(3)}`;
  const memo = hitCache.get(k);
  if (memo !== undefined) return memo;
  const { count, prob } = bins(N, s);
  const occupied = (T: number) => {
    let sum = 0;
    for (let i = 0; i < count.length; i++) sum += count[i] * (1 - Math.exp(-prob[i] * T));
    return sum;
  };
  let lo = Math.log(1e-3);
  let hi = Math.log(1e15);
  for (let it = 0; it < 80; it++) {
    const mid = (lo + hi) / 2;
    if (occupied(Math.exp(mid)) < capacity) lo = mid; else hi = mid;
  }
  const T = Math.exp((lo + hi) / 2);
  let h = 0;
  for (let i = 0; i < count.length; i++) h += count[i] * prob[i] * (1 - Math.exp(-prob[i] * T));
  h = Math.max(0, Math.min(1, h));
  if (hitCache.size > 5000) hitCache.clear();
  hitCache.set(k, h);
  return h;
}

/** Share of all requests that go to the single most popular key. */
export function topKeyShare(keys: number, s: number): number {
  return bins(keys, s).top;
}

export interface CacheShape { capacity: number; keys: number; zipf: number }

export function cacheShape(p: Record<string, unknown>): CacheShape {
  return {
    capacity: Math.max(0, Number(p.shards ?? 1) * Number(p.keysPerShard ?? 100000)),
    keys: Math.max(1, Number(p.keySpace ?? 2000000)),
    zipf: Number(p.zipf ?? 0.9),
  };
}

/** Steady-state hit ratio for a cache node's params, in either mode. */
export function steadyHit(p: Record<string, unknown>): number {
  if (p.hitMode !== 'capacity') return Number(p.hitRatio ?? 0.9);
  const c = cacheShape(p);
  return cheHitRatio(c.capacity, c.keys, c.zipf);
}
