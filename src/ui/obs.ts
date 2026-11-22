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
export type ObsMetric = 'rps' | 'avg' | 'p90' | 'cpu' | 'hit' | 'conns' | 'maxconn';
/** What kind of component the metrics describe; each kind has its own metrics and exporter queries. */
export type ObsKind = 'http' | 'cache' | 'database';
export const OBS_KINDS: ObsKind[] = ['http', 'cache', 'database'];

/** Metrics per kind, in display order. */
export const KIND_METRICS: Record<ObsKind, ObsMetric[]> = {
  http: ['rps', 'avg', 'p90', 'cpu'],
  cache: ['rps', 'avg', 'hit'],
  database: ['rps', 'avg', 'conns', 'maxconn'],
};
/** HTTP metrics, kept for callers that only deal with services. */
export const OBS_METRICS: ObsMetric[] = KIND_METRICS.http;

export const KIND_LABEL: Record<ObsKind, Text> = {
  http: L('服务 / 网关', 'Services / gateways'),
  cache: L('缓存', 'Caches'),
  database: L('数据库', 'Databases'),
};

/** Components that can have real metrics, and their kind. */
export const OBS_KIND_OF: Record<string, ObsKind> = { service: 'http', gateway: 'http', cache: 'cache', database: 'database' };
export const OBS_TYPES = new Set(Object.keys(OBS_KIND_OF));
export const kindOf = (type: string): ObsKind => OBS_KIND_OF[type] ?? 'http';

export interface ObsPreset { id: string; label: Text; queries: Partial<Record<ObsMetric, string>> }

const HTTP_CPU = 'sum(rate(container_cpu_usage_seconds_total{pod=~"{service}-.*", container!=""}[{window}])) / sum(kube_pod_container_resource_limits{pod=~"{service}-.*", resource="cpu"})';

// {service} is the component's label (the Prometheus job); {window} the rate window (e.g. 5m).
export const PRESETS: Record<ObsKind, ObsPreset[]> = {
  http: [
    {
      id: 'otel',
      label: L('OpenTelemetry（http_server_request_duration_seconds）', 'OpenTelemetry (http_server_request_duration_seconds)'),
      queries: {
        rps: 'sum(rate(http_server_request_duration_seconds_count{job="{service}"}[{window}]))',
        avg: '1000 * sum(rate(http_server_request_duration_seconds_sum{job="{service}"}[{window}])) / sum(rate(http_server_request_duration_seconds_count{job="{service}"}[{window}]))',
        p90: '1000 * histogram_quantile(0.9, sum by (le) (rate(http_server_request_duration_seconds_bucket{job="{service}"}[{window}])))',
        cpu: HTTP_CPU,
      },
    },
    {
      id: 'spring',
      label: L('Spring Boot / Micrometer（http_server_requests_seconds）', 'Spring Boot / Micrometer (http_server_requests_seconds)'),
      queries: {
        rps: 'sum(rate(http_server_requests_seconds_count{application="{service}"}[{window}]))',
        avg: '1000 * sum(rate(http_server_requests_seconds_sum{application="{service}"}[{window}])) / sum(rate(http_server_requests_seconds_count{application="{service}"}[{window}]))',
        p90: '1000 * histogram_quantile(0.9, sum by (le) (rate(http_server_requests_seconds_bucket{application="{service}"}[{window}])))',
        cpu: HTTP_CPU,
      },
    },
  ],
  cache: [
    {
      id: 'redis',
      label: L('Redis（redis_exporter）', 'Redis (redis_exporter)'),
      queries: {
        rps: 'sum(rate(redis_commands_total{job="{service}"}[{window}]))',
        avg: '1000 * sum(rate(redis_commands_duration_seconds_total{job="{service}"}[{window}])) / sum(rate(redis_commands_total{job="{service}"}[{window}]))',
        hit: 'sum(rate(redis_keyspace_hits_total{job="{service}"}[{window}])) / (sum(rate(redis_keyspace_hits_total{job="{service}"}[{window}])) + sum(rate(redis_keyspace_misses_total{job="{service}"}[{window}])))',
      },
    },
  ],
  database: [
    {
      id: 'postgres',
      label: L('PostgreSQL（postgres_exporter + pg_stat_statements）', 'PostgreSQL (postgres_exporter + pg_stat_statements)'),
      queries: {
        rps: 'sum(rate(pg_stat_statements_calls_total{job="{service}"}[{window}]))',
        avg: '1000 * sum(rate(pg_stat_statements_seconds_total{job="{service}"}[{window}])) / sum(rate(pg_stat_statements_calls_total{job="{service}"}[{window}]))',
        conns: 'sum(pg_stat_activity_count{job="{service}"})',
        maxconn: 'max(pg_settings_max_connections{job="{service}"})',
      },
    },
    {
      id: 'mysql',
      label: L('MySQL（mysqld_exporter）', 'MySQL (mysqld_exporter)'),
      queries: {
        rps: 'sum(rate(mysql_global_status_questions{job="{service}"}[{window}]))',
        avg: '1000 * sum(rate(mysql_perf_schema_events_statements_seconds_total{job="{service}"}[{window}])) / sum(rate(mysql_perf_schema_events_statements_total{job="{service}"}[{window}]))',
        conns: 'sum(mysql_global_status_threads_connected{job="{service}"})',
        maxconn: 'max(mysql_global_variables_max_connections{job="{service}"})',
      },
    },
  ],
};

const HTTP_LABEL: Record<ObsMetric, Text> = {
  rps: L('流量（请求/秒）', 'Traffic (req/s)'),
  avg: L('平均延迟（ms）', 'Average latency (ms)'),
  p90: L('P90 延迟（ms）', 'P90 latency (ms)'),
  cpu: L('CPU 利用率（0–1）', 'CPU utilization (0–1)'),
  hit: L('命中率（0–1）', 'Hit ratio (0–1)'),
  // open connections, idle ones in client pools included, which is what the simulation counts
  conns: L('已建立连接数', 'Open connections'),
  maxconn: L('最大连接数', 'Max connections'),
};
const KIND_OVERRIDE: Record<ObsKind, Partial<Record<ObsMetric, Text>>> = {
  http: {},
  cache: { rps: L('命令数（次/秒）', 'Commands (/s)'), avg: L('命令平均耗时（ms）', 'Average command time (ms)') },
  database: { rps: L('查询数（次/秒）', 'Queries (/s)'), avg: L('查询平均耗时（ms）', 'Average query time (ms)') },
};
/** A metric's label for a kind of component, e.g. "Queries (/s)" for a database. */
export const metricLabel = (kind: ObsKind, m: ObsMetric): Text => KIND_OVERRIDE[kind][m] ?? HTTP_LABEL[m];
/** The same label without its unit, for tables and checkboxes. */
export const metricShort = (kind: ObsKind, m: ObsMetric, lang: 'zh' | 'en'): string => metricLabel(kind, m)[lang].replace(/（.*）|\s\(.*\)/, '');
/** HTTP labels, kept for older callers. */
export const METRIC_LABEL = HTTP_LABEL;

export const WINDOWS = ['1m', '5m', '15m'];

/** "5m" → "5 分钟" / "5 min". */
export function windowLabel(w: string, lang: 'zh' | 'en'): string {
  const n = parseInt(w, 10);
  return lang === 'zh' ? `${n} 分钟` : `${n} min`;
}

/** A configured performance-data source: one endpoint type plus how to query each kind of component. */
export interface ObsConn {
  id: string;
  name: string;
  source: ObsSource;
  /** Prometheus datasource UID in Grafana (grafana and mcp sources). */
  datasourceUid: string;
  window: string;
  /** Preset id per kind ('custom' once a template is edited). */
  preset: Record<ObsKind, string>;
  queries: Record<ObsKind, Partial<Record<ObsMetric, string>>>;
}

const LS = 'simbench.obs.v2';

const defaultPresets = (): Record<ObsKind, string> => ({ http: PRESETS.http[0].id, cache: PRESETS.cache[0].id, database: PRESETS.database[0].id });
const defaultQueries = (): ObsConn['queries'] => ({ http: { ...PRESETS.http[0].queries }, cache: { ...PRESETS.cache[0].queries }, database: { ...PRESETS.database[0].queries } });

export function newConn(n: number, lang: 'zh' | 'en'): ObsConn {
  return { id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: `${L('数据来源', 'Source')[lang]} ${n}`, source: 'mcp', datasourceUid: '', window: '5m', preset: defaultPresets(), queries: defaultQueries() };
}

/** Reads a saved source, including the earlier shape that only had HTTP queries. */
export function migrateConn(c: Record<string, unknown>): ObsConn {
  const preset = defaultPresets(), queries = defaultQueries();
  if (typeof c.preset === 'string') preset.http = c.preset;
  else if (c.preset && typeof c.preset === 'object') Object.assign(preset, c.preset);
  const q = (c.queries ?? {}) as Record<string, unknown>;
  if (typeof q.rps === 'string') queries.http = { ...queries.http, ...(q as Partial<Record<ObsMetric, string>>) };
  else for (const k of OBS_KINDS) if (q[k] && typeof q[k] === 'object') queries[k] = { ...queries[k], ...(q[k] as Partial<Record<ObsMetric, string>>) };
  return { ...(c as unknown as ObsConn), preset, queries };
}

function loadConns(): ObsConn[] {
  try {
    const v = JSON.parse(localStorage.getItem(LS) ?? '[]') as Record<string, unknown>[];
    return Array.isArray(v) ? v.map(migrateConn) : [];
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
  usePreset: (id: string, kind: ObsKind, preset: string) => void;
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
    usePreset: (id, kind, preset) => {
      const c = get().conns.find((x) => x.id === id);
      const pr = PRESETS[kind].find((x) => x.id === preset);
      if (c && pr) get().update(id, { preset: { ...c.preset, [kind]: preset }, queries: { ...c.queries, [kind]: { ...pr.queries } } });
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
/** Error text for a metric whose PromQL template is empty. */
export const NO_QUERY = 'NO_QUERY_TEMPLATE';

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

/** Fetches the chosen metrics for one component label from one configured source. */
export async function fetchMetrics(service: string, conn: ObsConn, kind: ObsKind = 'http', metrics: ObsMetric[] = KIND_METRICS[kind]): Promise<Partial<Record<ObsMetric, ObsResult>>> {
  const out: Partial<Record<ObsMetric, ObsResult>> = {};
  await Promise.all(metrics.map(async (m) => {
    const tpl = conn.queries[kind]?.[m] ?? '';
    const query = fill(tpl, service, conn.window);
    if (!tpl.trim()) { out[m] = { value: null, error: NO_QUERY, query }; return; }
    try { out[m] = { value: await runQuery(query, conn), query }; }
    catch (e) { out[m] = { value: null, error: e instanceof Error ? e.message : String(e), query }; }
  }));
  return out;
}

// ---------------------------------------------------------------- per-component results
export interface ObsFetched { at: number; conn: string; window: string; data: Partial<Record<ObsMetric, ObsResult>> }

/** Last fetched results per component, so they survive switching selection. */
export const useObsResults = create<{ by: Record<string, ObsFetched>; busy: boolean }>(() => ({ by: {}, busy: false }));

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

/** The metrics a component asks for (all of its kind's unless it chose a subset). */
export function metricsFor(node: NodeCfg): ObsMetric[] {
  const all = KIND_METRICS[kindOf(node.type)];
  const v = String(node.params.obsMetrics ?? '');
  const picked = all.filter((m) => v.split(',').includes(m));
  return v && picked.length ? picked : all;
}

export async function fetchFor(node: NodeCfg, conn: ObsConn, service: string): Promise<ObsFetched> {
  const data = await fetchMetrics(service, conn, kindOf(node.type), metricsFor(node));
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
 * A calibration CSV from the fetched real metrics: measured qps, avg_ms and cpu_util per service,
 * hit_ratio per cache, max_connections per database, structural columns (pods, cores, threads,
 * DB pool) from the current canvas, and a traffic-source
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
  // services and gateways first: a cache or database counts commands and queries, not requests
  const httpFirst = (n: NodeCfg) => (kindOf(n.type) === 'http' ? 0 : 1);
  const anchor = topo.nodes
    .filter((n) => OBS_TYPES.has(n.type) && by[n.id]?.data.rps?.value)
    .sort((a, b) => httpFirst(a) - httpFirst(b) || (lam.get(b.id) ?? 0) - (lam.get(a.id) ?? 0))[0];
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
    const row: Record<string, string> = { name: q(n.name), type: n.type, qps: num(d.rps?.value), avg_ms: num(d.avg?.value, 2) };
    if (n.type === 'service' || n.type === 'gateway') {
      row.pods = String(p.instances ?? '');
      row.threads_per_pod = String(p.workers ?? '');
    }
    if (n.type === 'service') {
      row.cpu_util = num(d.cpu?.value, 3);
      row.cores_per_pod = String(p.cpuCores ?? '');
      const db = topo.edges.find((x) => x.from === n.id && topo.nodes.find((y) => y.id === x.to)?.type === 'database');
      if (db) row.db_pool_per_pod = String(withDefaults(EDGE_SPECS, db.params).poolSize ?? '');
    }
    if (n.type === 'cache') row.hit_ratio = num(d.hit?.value, 3);
    if (n.type === 'database') row.max_connections = num(d.maxconn?.value, 0);
    if (!row.qps && !row.avg_ms && !row.cpu_util && !row.hit_ratio && !row.max_connections) continue;
    lines.push(CAL_COLUMNS.map((c) => row[c] ?? '').join(','));
    rows++;
  }
  if (clientRow) lines.splice(1, 0, clientRow);
  return { text: lines.join('\n') + '\n', rows };
}

/** For tests: forget the MCP session. */
export function resetMcp() { mcpSession = null; }
