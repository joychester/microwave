import type { Dist } from './types';

// Small, fast, seedable PRNG (mulberry32)
export class Rng {
  private s: number;
  constructor(seed = 42) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  exp(mean: number): number {
    return -Math.log(1 - this.next()) * mean;
  }
  normal(): number {
    let u = 0;
    while (u === 0) u = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

const Z99 = 2.326347874;

export function lognormalParams(median: number, p99: number) {
  const mu = Math.log(Math.max(median, 1e-6));
  const sigma = Math.max(0, Math.log(Math.max(p99, median) / Math.max(median, 1e-6)) / Z99);
  return { mu, sigma };
}

export function sample(d: Dist, rng: Rng): number {
  switch (d.dist) {
    case 'constant':
      return d.value;
    case 'exponential':
      return rng.exp(d.mean);
    case 'lognormal': {
      const { mu, sigma } = lognormalParams(d.median, d.p99);
      return Math.exp(mu + sigma * rng.normal());
    }
  }
}

export function mean(d: Dist): number {
  switch (d.dist) {
    case 'constant':
      return d.value;
    case 'exponential':
      return d.mean;
    case 'lognormal': {
      const { mu, sigma } = lognormalParams(d.median, d.p99);
      return Math.exp(mu + (sigma * sigma) / 2);
    }
  }
}

// squared coefficient of variation
export function scv(d: Dist): number {
  switch (d.dist) {
    case 'constant':
      return 0;
    case 'exponential':
      return 1;
    case 'lognormal': {
      const { sigma } = lognormalParams(d.median, d.p99);
      return Math.exp(sigma * sigma) - 1;
    }
  }
}

export function describeDist(d: Dist): string {
  switch (d.dist) {
    case 'constant':
      return `${fmtMs(d.value)}`;
    case 'exponential':
      return `exp 均值 ${fmtMs(d.mean)}`;
    case 'lognormal':
      return `中位 ${fmtMs(d.median)}，p99 ${fmtMs(d.p99)}`;
  }
}

export function fmtMs(v: number): string {
  if (!isFinite(v)) return '—';
  if (v >= 10000) return `${(v / 1000).toFixed(0)}s`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
  if (v >= 100) return `${v.toFixed(0)}ms`;
  if (v >= 10) return `${v.toFixed(0)}ms`;
  if (v >= 1) return `${v.toFixed(1)}ms`;
  return `${v.toFixed(2)}ms`;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}
