// Real metrics from your monitoring stack, to compare with the simulation.
// Three sources, all reached through the dev server's /obs proxy so tokens never reach the browser:
//   prometheus  → /obs/prometheus/api/v1/query
//   grafana     → /obs/grafana/api/datasources/proxy/uid/<uid>/api/v1/query  (Grafana's datasource proxy)
//   mcp         → /obs/mcp, the Grafana MCP server's query_prometheus tool (streamable HTTP)
import { create } from 'zustand';
import type { NodeCfg, Params, Text, Topology } from '../engine/types';
import { analyze } from '../engine/analysis';
import { isProgram, programFromLegacy } from '../engine/traffic';
import { CAL_COLUMNS } from '../engine/calibrate';
import { EDGE_SPECS, NODE_SPECS, withDefaults } from '../engine/specs';
import { L } from '../engine/types';

export type ObsSource = 'prometheus' | 'grafana' | 'mcp';
export type ObsMetric = 'rps' | 'avg' | 'p90' | 'cpu';
export const OBS_METRICS: ObsMetric[] = ['rps', 'avg', 'p90', 'cpu'];

export interface ObsPreset { id: string; label: Text; queries: Record<ObsMetric, string> }

// {service} is the component's service label; {window} the rate window (e.g. 5m).
export const PRESETS: ObsPreset[] = [
  {
    id: 'otel',
    label: L('OpenTelemetry（http_server_request_duration_seconds）', 'OpenTelemetry (http_server_request_duration_seconds)'),
    queries: {
      rps: 'sum(rate(http_server_request_duration_seconds_count{job="{service}"}[{window}]))',
      avg: '1000 * sum(rate(http_server_request_duration_seconds_sum{job="{service}"}[{window}])) / sum(rate(http_server_request_duration_seconds_count{job="{service}"}[{window}]))',
      p90: '1000 * histogram_quantile(0.9, sum by (le) (rate(http_server_request_duration_seconds_bucket{job="{service}"}[{window}])))',
      cpu: 'sum(rate(container_cpu_usage_seconds_total{pod=~"{service}-.*", container!=""}[{window}])) / sum(kube_pod_container_resource_limits{pod=~"{service}-.*", resource="cpu"})',
    },
  },
  {
    id: 'spring',
    label: L('Spring Boot / Micrometer（http_server_requests_seconds）', 'Spring Boot / Micrometer (http_server_requests_seconds)'),
    queries: {
      rps: 'sum(rate(http_server_requests_seconds_count{application="{service}"}[{window}]))',
      avg: '1000 * sum(rate(http_server_requests_seconds_sum{application="{service}"}[{window}])) / sum(rate(http_server_requests_seconds_count{application="{service}"}[{window}]))',
      p90: '1000 * histogram_quantile(0.9, sum by (le) (rate(http_server_requests_seconds_bucket{application="{service}"}[{window}])))',
      cpu: 'sum(rate(container_cpu_usage_seconds_total{pod=~"{service}-.*", container!=""}[{window}])) / sum(kube_pod_container_resource_limits{pod=~"{service}-.*", resource="cpu"})',
    },
  },
];

export const METRIC_LABEL: Record<ObsMetric, Text> = {
  rps: L('流量（请求/秒）', 'Traffic (req/s)'),
  avg: L('平均延迟（ms）', 'Average latency (ms)'),
  p90: L('P90 延迟（ms）', 'P90 latency (ms)'),
  cpu: L('CPU 利用率（0–1）', 'CPU utilization (0–1)'),
};

export const WINDOWS = ['1m', '5m', '15m'];

/** "5m" → "5 分钟" / "5 min". */
export function windowLabel(w: string, lang: 'zh' | 'en'): string {
  const n = parseInt(w, 10);
  return lang === 'zh' ? `${n} 分钟` : `${n} min`;
}

/** A configured performance-data source: one endpoint type plus how to query it. */
export interface ObsConn {
  id: string;
  name: string;
  source: ObsSource;
  /** Prometheus datasource UID in Grafana (grafana and mcp sources). */
  datasourceUid: string;
  window: string;
  preset: string;
  queries: Record<ObsMetric, string>;
}

const LS = 'simbench.obs.v2';

export function newConn(n: number, lang: 'zh' | 'en'): ObsConn {
  return { id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: `${L('数据来源', 'Source')[lang]} ${n}`, source: 'mcp', datasourceUid: '', window: '5m', preset: 'otel', queries: { ...PRESETS[0].queries } };
}

function loadConns(): ObsConn[] {
  try {
    const v = JSON.parse(localStorage.getItem(LS) ?? '[]') as ObsConn[];
    return Array.isArray(v) ? v.map((c) => ({ ...c, queries: { ...PRESETS[0].queries, ...c.queries } })) : [];
  } catch { return []; }
}

interface ObsState {
  conns: ObsConn[];
  /** The settings dialog is open. */
  open: boolean;
  setOpen: (v: boolean) => void;
  add: (lang: 'zh' | 'en') => string;
  update: (id: string, p: Partial<ObsConn>) => void;
  remove: (id: string) => void;
  usePreset: (id: string, preset: string) => void;
}

export const useObs = create<ObsState>((set, get) => {
  const persist = () => { try { localStorage.setItem(LS, JSON.stringify(get().conns)); } catch { /* ignore */ } };
  return {
    conns: loadConns(),
    open: false,
    setOpen: (open) => set({ open }),
    add: (lang) => {
      const c = newConn(get().conns.length + 1, lang);
      set({ conns: [...get().conns, c] }); persist();
      return c.id;
    },
    update: (id, p) => { set({ conns: get().conns.map((c) => (c.id === id ? { ...c, ...p } : c)) }); persist(); },
    remove: (id) => { set({ conns: get().conns.filter((c) => c.id !== id) }); persist(); },
    usePreset: (id, preset) => {
      const pr = PRESETS.find((x) => x.id === preset);
      if (pr) get().update(id, { preset, queries: { ...pr.queries } });
    },
  };
});

/** Which sources the dev server has a target for (from /obs/config); null when there is no /obs proxy. */
export async function fetchObsConfig(): Promise<Record<ObsSource, boolean> | null> {
  // opened as a file (the single-file build): there is no server, so no proxy
  if (typeof location !== 'undefined' && location.protocol === 'file:') return null;
  try {
    const r = await fetch('/obs/config', { headers: { Accept: 'application/json' } });
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
    return (await r.json()) as Record<ObsSource, boolean>;
  } catch { return null; }
}

export function fill(q: string, service: string, window: string): string {
  return q.split('{service}').join(service).split('{window}').join(window);
}

/** First number in a Prometheus-style result: vector, scalar, matrix (last point), or wrapped in {data: ...}. */
export function firstNumber(v: unknown): number | null {
  const num = (x: unknown) => { const n = typeof x === 'string' ? Number(x) : typeof x === 'number' ? x : NaN; return isFinite(n) ? n : null; };
  const walk = (x: unknown): number | null => {
    if (Array.isArray(x)) {
      // a sample: [timestamp, "value"]
      if (x.length === 2 && typeof x[0] === 'number' && (typeof x[1] === 'string' || typeof x[1] === 'number')) return num(x[1]);
      for (const y of x) { const r = walk(y); if (r !== null) return r; }
      return null;
    }
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if ('value' in o) { const r = walk(o.value); if (r !== null) return r; }
      if (Array.isArray(o.values) && o.values.length) { const r = walk(o.values[o.values.length - 1]); if (r !== null) return r; }
      for (const k of ['data', 'result']) if (k in o) { const r = walk(o[k]); if (r !== null) return r; }
    }
    return null;
  };
  return walk(v);
}

class ObsError extends Error {}
/** Error text for a missing datasource UID; the UI shows it in the user's language. */
export const NO_UID = 'NO_DATASOURCE_UID';

async function promApi(url: string): Promise<number | null> {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await r.text();
  let body: { status?: string; error?: string; message?: string; data?: unknown } = {};
  try { body = JSON.parse(text); } catch { throw new ObsError(`HTTP ${r.status}: ${text.slice(0, 160)}`); }
  if (!r.ok || body.status === 'error') throw new ObsError(`${body.error ?? body.message ?? 'error'} (HTTP ${r.status})`);
  return firstNumber(body.data);
}

// ---------------------------------------------------------------- minimal MCP client (streamable HTTP)
let mcpSession: { id: string | null; ready: Promise<void> } | null = null;
let rpcId = 0;

/** Reads a JSON-RPC response that came back as JSON or as an SSE stream. */
async function readRpc(r: Response, id: number): Promise<{ result?: unknown; error?: { message: string } }> {
  const ct = r.headers.get('content-type') ?? '';
  const text = await r.text();
  if (!r.ok) throw new ObsError(`MCP HTTP ${r.status}: ${text.slice(0, 160)}`);
  const msgs: unknown[] = [];
  if (ct.includes('text/event-stream')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) { try { msgs.push(JSON.parse(data)); } catch { /* skip */ } }
    }
  } else if (text.trim()) {
    const v = JSON.parse(text);
    if (Array.isArray(v)) msgs.push(...v); else msgs.push(v);
  }
  const hit = msgs.find((m) => (m as { id?: number }).id === id) as { result?: unknown; error?: { message: string } } | undefined;
  if (!hit) throw new ObsError('MCP: no response');
  return hit;
}

async function mcpPost(body: object, expectReply: boolean): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (mcpSession?.id) headers['Mcp-Session-Id'] = mcpSession.id;
  const r = await fetch('/obs/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
  if (!expectReply && !r.ok && r.status !== 202) throw new ObsError(`MCP HTTP ${r.status}`);
  return r;
}

async function mcpInit(): Promise<void> {
  const id = ++rpcId;
  const r = await mcpPost({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'microwave', version: '1.0.0' } } }, true);
  const sid = r.headers.get('mcp-session-id');
  const res = await readRpc(r, id);
  if (res.error) throw new ObsError(`MCP: ${res.error.message}`);
  if (mcpSession) mcpSession.id = sid;
  await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
}

async function mcpCall(name: string, args: object, retry = true): Promise<unknown> {
  if (!mcpSession) {
    mcpSession = { id: null, ready: Promise.resolve() };
    mcpSession.ready = mcpInit().catch((e) => { mcpSession = null; throw e; });
  }
  await mcpSession.ready;
  const id = ++rpcId;
  const r = await mcpPost({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, true);
  if ((r.status === 404 || r.status === 400) && retry) {
    // the server dropped our session: start a new one
    mcpSession = null;
    return mcpCall(name, args, false);
  }
  const res = await readRpc(r, id);
  if (res.error) throw new ObsError(`MCP: ${res.error.message}`);
  const out = res.result as { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
  const text = (out.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
  if (out.isError) throw new ObsError(text.slice(0, 200) || 'MCP tool error');
  if (out.structuredContent !== undefined) return out.structuredContent;
  try { return JSON.parse(text); } catch { return text; }
}

/** Runs one instant PromQL query on the chosen source. */
export async function runQuery(expr: string, s: Pick<ObsConn, 'source' | 'datasourceUid'>): Promise<number | null> {
  if ((s.source === 'grafana' || s.source === 'mcp') && !s.datasourceUid.trim()) {
    throw new ObsError(NO_UID);
  }
  const q = encodeURIComponent(expr);
  if (s.source === 'prometheus') return promApi(`/obs/prometheus/api/v1/query?query=${q}`);
  if (s.source === 'grafana') return promApi(`/obs/grafana/api/datasources/proxy/uid/${encodeURIComponent(s.datasourceUid.trim())}/api/v1/query?query=${q}`);
  const v = await mcpCall('query_prometheus', { datasourceUid: s.datasourceUid.trim(), expr, startTime: 'now', queryType: 'instant' });
  return firstNumber(v);
}

export interface ObsResult { value: number | null; error?: string; query: string }

/** Fetches every metric for one service label from one configured source. */
export async function fetchMetrics(service: string, conn: ObsConn, metrics: ObsMetric[] = OBS_METRICS): Promise<Partial<Record<ObsMetric, ObsResult>>> {
  const out: Partial<Record<ObsMetric, ObsResult>> = {};
  await Promise.all(metrics.map(async (m) => {
    const query = fill(conn.queries[m], service, conn.window);
    try { out[m] = { value: await runQuery(query, conn), query }; }
    catch (e) { out[m] = { value: null, error: e instanceof Error ? e.message : String(e), query }; }
  }));
  return out;
}

// ---------------------------------------------------------------- per-component results
export interface ObsFetched { at: number; conn: string; window: string; data: Partial<Record<ObsMetric, ObsResult>> }

/** Last fetched results per component, so they survive switching selection. */
export const useObsResults = create<{ by: Record<string, ObsFetched>; busy: boolean }>(() => ({ by: {}, busy: false }));

/** Components that can have real metrics: HTTP services and gateways. */
export const OBS_TYPES = new Set(['service', 'gateway']);

/** The component's source: the one it picked, or the only one configured. */
export function connFor(node: NodeCfg, conns: ObsConn[]): ObsConn | undefined {
  return conns.find((c) => c.id === node.params.obsConn) ?? (conns.length === 1 ? conns[0] : undefined);
}

/** The component's service label: the one it set, or its name when that already looks like a label (order-service). */
export function serviceFor(node: NodeCfg): string {
  const set = String(node.params.obsService ?? '').trim();
  if (set) return set;
  return /^[A-Za-z0-9][\w.-]*$/.test(node.name.trim()) ? node.name.trim() : '';
}

/** The metrics a component asks for (all four unless it chose a subset). */
export function metricsFor(node: NodeCfg): ObsMetric[] {
  const v = String(node.params.obsMetrics ?? '');
  const picked = OBS_METRICS.filter((m) => v.split(',').includes(m));
  return v && picked.length ? picked : OBS_METRICS;
}

export async function fetchFor(node: NodeCfg, conn: ObsConn, service: string): Promise<ObsFetched> {
  const data = await fetchMetrics(service, conn, metricsFor(node));
  const f = { at: Date.now(), conn: conn.name, window: conn.window, data };
  useObsResults.setState((r) => ({ by: { ...r.by, [node.id]: f } }));
  return f;
}

/** One click: fetch every component that has a source and a service label. */
export async function fetchAll(nodes: NodeCfg[]): Promise<{ ok: number; failed: number; skipped: number }> {
  const conns = useObs.getState().conns;
  const jobs = nodes.filter((n) => OBS_TYPES.has(n.type));
  let ok = 0, failed = 0, skipped = 0;
  useObsResults.setState({ busy: true });
  try {
    await Promise.all(jobs.map(async (n) => {
      const conn = connFor(n, conns), svc = serviceFor(n);
      if (!conn || !svc) { skipped++; return; }
      const f = await fetchFor(n, conn, svc);
      const got = Object.values(f.data);
      if (got.length && got.every((r) => r?.error)) failed++; else ok++;
    }));
  } finally { useObsResults.setState({ busy: false }); }
  return { ok, failed, skipped };
}

// ---------------------------------------------------------------- from real metrics to the model

/** The one traffic source, when it has a plain constant rate (the only shape scaled automatically). */
function constantClient(topo: Topology): { node: NodeCfg; rate: number } | null {
  const clients = topo.nodes.filter((n) => n.type === 'client');
  if (clients.length !== 1) return null;
  const c = clients[0];
  const prog = isProgram(c.params.traffic) ? c.params.traffic : programFromLegacy(c.params);
  if (prog.base.kind !== 'constant' || prog.overlays.length) return null;
  return { node: c, rate: Number(prog.base.p.rps ?? 0) };
}

/**
 * The traffic-source rate that would give a component its real request rate: today's rate scaled by
 * real ÷ modelled arrivals at that component (from the capacity analysis, so no run is needed).
 * Null when there isn't exactly one constant-rate traffic source, or the component gets no traffic.
 */
export function rateForReal(topo: Topology, nodeId: string, realRps: number): { clientId: string; from: number; to: number } | null {
  const c = constantClient(topo);
  if (!c || !(realRps > 0)) return null;
  const lam = analyze(topo).nodes.find((n) => n.id === nodeId)?.lambda ?? 0;
  if (!(lam > 0)) return null;
  const to = Math.max(1, Math.round((c.rate * realRps) / lam));
  return { clientId: c.node.id, from: c.rate, to };
}

/** The params patch that sets a constant traffic source's rate. */
export function ratePatch(client: NodeCfg, rate: number): Params {
  const prog = isProgram(client.params.traffic) ? client.params.traffic : programFromLegacy(client.params);
  return { traffic: { ...prog, base: { ...prog.base, p: { ...prog.base.p, rps: rate } } } };
}

/**
 * A calibration CSV from the fetched real metrics: measured qps, avg_ms and cpu_util per component,
 * structural columns (pods, cores, threads, DB pool) from the current canvas, and a traffic-source
 * row scaled so the first measured component's traffic matches. Feeds the existing calibration.
 */
export function realMetricsCsv(topo: Topology, by: Record<string, ObsFetched>): { text: string; rows: number } {
  const q = (v: string) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const num = (v: number | null | undefined, digits = 1) => (v === null || v === undefined || !isFinite(v) ? '' : String(Number(v.toFixed(digits))));
  const lines: string[] = [CAL_COLUMNS.join(',')];
  let rows = 0;
  // the traffic source is scaled from the measured component closest to it (most modelled traffic),
  // which leans least on the model's split ratios
  const lam = new Map(analyze(topo).nodes.map((e) => [e.id, e.lambda]));
  const anchor = topo.nodes
    .filter((n) => OBS_TYPES.has(n.type) && by[n.id]?.data.rps?.value)
    .sort((a, b) => (lam.get(b.id) ?? 0) - (lam.get(a.id) ?? 0))[0];
  let clientRow: string | null = null;
  if (anchor) {
    const r = rateForReal(topo, anchor.id, by[anchor.id].data.rps!.value!);
    const client = r && topo.nodes.find((x) => x.id === r.clientId);
    if (r && client) clientRow = CAL_COLUMNS.map((c) => (c === 'name' ? q(client.name) : c === 'type' ? 'client' : c === 'qps' ? String(r.to) : '')).join(',');
  }
  for (const n of topo.nodes) {
    const f = by[n.id];
    if (!f || !OBS_TYPES.has(n.type)) continue;
    const d = f.data;
    const p = withDefaults(NODE_SPECS[n.type].params, n.params);
    const row: Record<string, string> = { name: q(n.name), type: n.type, qps: num(d.rps?.value), avg_ms: num(d.avg?.value), pods: String(p.instances ?? ''), threads_per_pod: String(p.workers ?? '') };
    if (n.type === 'service') {
      row.cpu_util = num(d.cpu?.value, 3);
      row.cores_per_pod = String(p.cpuCores ?? '');
      const db = topo.edges.find((x) => x.from === n.id && topo.nodes.find((y) => y.id === x.to)?.type === 'database');
      if (db) row.db_pool_per_pod = String(withDefaults(EDGE_SPECS, db.params).poolSize ?? '');
    }
    if (!row.qps && !row.avg_ms && !row.cpu_util) continue;
    lines.push(CAL_COLUMNS.map((c) => row[c] ?? '').join(','));
    rows++;
  }
  if (clientRow) lines.splice(1, 0, clientRow);
  return { text: lines.join('\n') + '\n', rows };
}

/** For tests: forget the MCP session. */
export function resetMcp() { mcpSession = null; }
