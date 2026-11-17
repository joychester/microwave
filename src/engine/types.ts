// Topology & parameter model shared by engine and UI.

export type Lang = 'zh' | 'en';
export interface Text { zh: string; en: string }
export const L = (zh: string, en: string): Text => ({ zh, en });

export type NodeType = 'client' | 'gateway' | 'lb' | 'service' | 'cache' | 'database' | 'queue' | 'external';

export type Dist =
  | { dist: 'constant'; value: number }
  | { dist: 'exponential'; mean: number }
  | { dist: 'lognormal'; median: number; p99: number };

export type ParamValue = number | boolean | string | Dist | import('./traffic').TrafficProgram | undefined;
export type Params = Record<string, ParamValue>;

export interface NodeCfg {
  id: string;
  type: NodeType;
  name: string;
  x: number;
  y: number;
  params: Params;
}

export interface EdgeCfg {
  id: string;
  from: string;
  to: string;
  params: Params;
}

export interface Topology {
  name: string;
  nodes: NodeCfg[];
  edges: EdgeCfg[];
  /** Set when parameters were backsolved from production metrics (see engine/calibrate.ts). */
  calibration?: CalibrationRecord;
}

export interface CalibrationRecord {
  /** Where the metrics came from, e.g. the CSV file name. */
  source: string;
  /** ISO timestamp of when calibration was applied. */
  appliedAt: string;
  /** Components matched by name. */
  components: number;
  /** Median absolute error of the verification run, 0..1, when one was run. */
  medianError?: number;
}

export interface FailureSpec {
  id: string;
  nodeId: string;
  kind: string;
  params: Record<string, number>;
  duration_s: number; // 0 = until cleared
  recovery_s: number;
}

export interface ActiveFailure extends FailureSpec {
  start: number; // sim ms
  end: number; // sim ms (Infinity if open-ended)
}

// ---------- metrics snapshots (one per simulated second) ----------

export interface NodeSample {
  arr: number; // arrivals / s (incl. retries)
  ok: number;
  err: number;
  wasted: number; // completions after caller already gave up
  p50: number;
  p95: number;
  p99: number;
  /** Mean latency of the requests sampled this second (ms). */
  mean?: number;
  util: number; // worker utilisation 0..1
  cpu: number; // cpu utilisation 0..1
  queue: number;
  inflight: number;
  instances: number;
  causes: Record<string, number>;
  extra: Record<string, number>; // type-specific: hit, lag, conns ...
}

export interface EdgeSample {
  calls: number;
  retries: number;
  fails: number;
  cb: 0 | 1 | 2; // closed, open, half-open
  poolWaitP99: number;
}

export interface SystemSample {
  t: number; // sim seconds
  req: number;
  ok: number;
  fail: number;
  p50: number;
  p95: number;
  p99: number;
  /** Mean end-to-end latency this second (ms). */
  mean: number;
  avail: number; // over this second
  amplification: number; // all edge attempts / first attempts
  causes: Record<string, number>;
  offered: number; // offered rps (before client retries)
}

export interface Snapshot {
  t: number;
  sys: SystemSample;
  nodes: Record<string, NodeSample>;
  edges: Record<string, EdgeSample>;
}

export type EventCode =
  | 'fault_start' | 'fault_end' | 'restart' | 'rebalance' | 'conn_limit'
  | 'cb_open' | 'cb_half' | 'cb_close' | 'scale_up' | 'scale_down' | 'game';

export interface SimEvent {
  t: number; // sim seconds
  level: 'info' | 'warn' | 'crit';
  code?: EventCode;
  nodeId?: string;
  edgeId?: string;
  text: Text;
}
