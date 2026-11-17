import { EDGE_SPECS, NODE_SPECS, defaultParams, edgeDefaultsFor } from './specs';
import { defaultLayer } from './traffic';
import { L, type EdgeCfg, type FailureSpec, type Lang, type NodeCfg, type NodeType, type Params, type Text, type Topology } from './types';

const ln = (median: number, p99: number) => ({ dist: 'lognormal' as const, median, p99 });

// Names used by the presets, in both languages. Switching language renames
// any node or topology whose name still matches one of these.
export const PRESET_NAMES: Text[] = [];
const N = (zh: string, en: string) => { const t = L(zh, en); PRESET_NAMES.push(t); return t; };
const NAMES = {
  traffic: N('用户流量', 'User traffic'), gw: N('API Gateway', 'API Gateway'),
  lbP: N('商品 LB', 'Catalog LB'), lbO: N('订单 LB', 'Orders LB'),
  product: N('商品服务', 'Catalog service'), order: N('订单服务', 'Orders service'),
  redis: N('Redis', 'Redis'), pg: N('Postgres', 'Postgres'),
  kafka: N('Kafka 订单事件', 'Kafka order events'), fulfill: N('履约服务', 'Fulfillment service'),
  lb: N('LB', 'LB'), api: N('API 服务', 'API service'), mysql: N('MySQL', 'MySQL'),
  ref: N('电商下单参考架构', 'E-commerce checkout reference'),
  multi: N('多流量源叠加', 'Multiple traffic sources'),
  canary: N('金丝雀发布', 'Canary release'), v1: N('商品服务 v1', 'Catalog v1'), v2: N('商品服务 v2（金丝雀）', 'Catalog v2 (canary)'),
  batch: N('批处理任务', 'Batch jobs'), push: N('App 推送', 'App push'), three: N('三层架构', 'Three-tier app'), blank: N('空白画布', 'Blank canvas'),
  payment: N('结算与第三方支付', 'Checkout with a payment provider'), checkout: N('结算服务', 'Checkout service'), pay: N('支付商 API', 'Payment provider API'),
};

let LANG: Lang = 'zh';
function node(id: string, type: NodeType, name: Text, x: number, y: number, params: Params = {}): NodeCfg {
  return { id, type, name: name[LANG], x, y, params: { ...defaultParams(NODE_SPECS[type].params), ...params } };
}

function edge(from: NodeCfg, to: NodeCfg, params: Params = {}): EdgeCfg {
  return { id: `${from.id}->${to.id}`, from: from.id, to: to.id, params: { ...edgeDefaultsFor(from.type, to.type), ...params } };
}

export function referenceTopology(lang: Lang = 'zh'): Topology {
  LANG = lang;
  const client = node('client', 'client', NAMES.traffic, 0, 280, { rps: 500, mix: '/orders:0.3,/products:0.7', sloAvail: 0.999, sloP99: 500 });
  const gw = node('gw', 'gateway', NAMES.gw, 240, 280, { instances: 2 });
  const lbP = node('lb-product', 'lb', NAMES.lbP, 480, 150, { algorithm: 'round_robin' });
  const lbO = node('lb-order', 'lb', NAMES.lbO, 480, 410, { algorithm: 'p2c' });
  const product = node('product', 'service', NAMES.product, 720, 150, { instances: 6, workers: 50, serviceTime: ln(10, 60) });
  const order = node('order', 'service', NAMES.order, 720, 410, { instances: 3, workers: 40, serviceTime: ln(12, 80) });
  const redis = node('redis', 'cache', NAMES.redis, 975, 30, { shards: 6, hitRatio: 0.92 });
  const pg = node('pg', 'database', NAMES.pg, 1230, 280, { workers: 8, maxConnections: 200, readTime: ln(3, 30), writeTime: ln(5, 40), readRatio: 0.75 });
  const kafka = node('kafka', 'queue', NAMES.kafka, 975, 540, { partitions: 12, consumers: 6 });
  const fulfill = node('fulfill', 'service', NAMES.fulfill, 1230, 540, { instances: 3, workers: 20, serviceTime: ln(20, 120) });

  return {
    name: NAMES.ref[lang],
    nodes: [client, gw, lbP, lbO, product, order, redis, pg, kafka, fulfill],
    edges: [
      edge(client, gw, { timeout: 3000, maxAttempts: 2 }),
      edge(gw, lbP, { match: '/products', timeout: 2000 }),
      edge(gw, lbO, { match: '/orders', timeout: 2000 }),
      edge(lbP, product, { timeout: 2000 }),
      edge(lbO, order, { timeout: 2000 }),
      edge(product, redis, { callsPerRequest: 3, timeout: 50, poolSize: 20 }),
      edge(redis, pg, { timeout: 500 }),
      edge(order, product, { order: 0, timeout: 300, maxAttempts: 3, backoffBase: 20 }),
      edge(order, pg, { order: 1, timeout: 500, poolSize: 20 }),
      edge(order, kafka, { order: 2, timeout: 200 }),
      edge(kafka, fulfill, { timeout: 10000, maxAttempts: 3 }),
      edge(fulfill, pg, { timeout: 500, poolSize: 10 }),
    ],
  };
}

export function blankTopology(lang: Lang = 'zh'): Topology {
  LANG = lang;
  return { name: NAMES.blank[lang], nodes: [node('client', 'client', NAMES.traffic, 80, 240, { rps: 200, mix: '/:1' })], edges: [] };
}

export function threeTierTopology(lang: Lang = 'zh'): Topology {
  LANG = lang;
  const client = node('client', 'client', NAMES.traffic, 0, 200, { rps: 800, mix: '/:1' });
  const lb = node('lb', 'lb', NAMES.lb, 260, 200, { algorithm: 'round_robin' });
  const api = node('api', 'service', NAMES.api, 520, 200, { instances: 4, workers: 30, serviceTime: ln(8, 50) });
  const db = node('db', 'database', NAMES.mysql, 800, 200, { workers: 12, readTime: ln(2, 25), writeTime: ln(4, 30) });
  return {
    name: NAMES.three[lang],
    nodes: [client, lb, api, db],
    edges: [edge(client, lb), edge(lb, api), edge(api, db, { callsPerRequest: 2, poolSize: 15 })],
  };
}

export function multiSourceTopology(lang: Lang = 'zh'): Topology {
  const t = referenceTopology(lang);
  LANG = lang;
  t.name = NAMES.multi[lang];
  const user = t.nodes.find((n) => n.id === 'client')!;
  user.y = 150;
  user.params = { ...user.params, traffic: { base: defaultLayer('diurnal', { trough: 200, peak: 650, period: 240 }), overlays: [defaultLayer('noise', { pct: 8 })] } };
  const batch = node('batch', 'client', NAMES.batch, 0, 430, {
    mix: '/orders:1',
    traffic: { base: defaultLayer('step', { start: 20, stepBy: 40, every: 30, steps: 6 }), overlays: [] },
  });
  const push = node('push', 'client', NAMES.push, 0, -40, {
    mix: '/products:1',
    traffic: { base: defaultLayer('constant', { rps: 40 }), overlays: [defaultLayer('spike', { at: 95, extra: 900, rise: 3, hold: 15, fall: 20 })] },
  });
  const gw = t.nodes.find((n) => n.id === 'gw')!;
  const lbO = t.nodes.find((n) => n.id === 'lb-order')!;
  t.nodes.push(batch, push);
  t.edges.push(edge(batch, lbO, { timeout: 5000, maxAttempts: 3 }), edge(push, gw, { timeout: 3000, maxAttempts: 2 }));
  return t;
}

export function canaryTopology(lang: Lang = 'zh'): Topology {
  LANG = lang;
  const client = node('client', 'client', NAMES.traffic, 0, 220, { rps: 800, mix: '/:1' });
  const gw = node('gw', 'gateway', NAMES.gw, 260, 220, { instances: 2 });
  const lb = node('lb', 'lb', NAMES.lb, 520, 220, { algorithm: 'least_conn' });
  const v1 = node('v1', 'service', NAMES.v1, 780, 90, { instances: 5, serviceTime: ln(10, 60) });
  const v2 = node('v2', 'service', NAMES.v2, 780, 360, { instances: 1, serviceTime: ln(14, 90), errorRate: 0.002 });
  const redis = node('redis', 'cache', NAMES.redis, 1060, 90, { shards: 4, hitMode: 'capacity' });
  const pg = node('pg', 'database', NAMES.pg, 1060, 360, { workers: 12 });
  return {
    name: NAMES.canary[lang],
    nodes: [client, gw, lb, v1, v2, redis, pg],
    edges: [
      edge(client, gw), edge(gw, lb, { timeout: 2000 }),
      edge(lb, v1, { weight: 90 }), edge(lb, v2, { weight: 10 }),
      edge(v1, redis, { callsPerRequest: 2, poolSize: 20 }), edge(v2, redis, { callsPerRequest: 2, poolSize: 20 }),
      edge(redis, pg), edge(v1, pg, { order: 1, poolSize: 15, probability: 0.3 }), edge(v2, pg, { order: 1, poolSize: 15, probability: 0.3 }),
    ],
  };
}

// A checkout path that depends on a payment provider: the classic way an outside slowdown
// eats your own thread pool.
export function paymentTopology(lang: Lang = 'zh'): Topology {
  LANG = lang;
  const client = node('client', 'client', NAMES.traffic, 0, 200, { rps: 300, mix: '/:1', sloAvail: 0.999, sloP99: 1500 });
  const gw = node('gw', 'gateway', NAMES.gw, 260, 200, { instances: 2 });
  const checkout = node('checkout', 'service', NAMES.checkout, 520, 200, { instances: 3, workers: 60, serviceTime: ln(15, 80), cpuFraction: 0.35 });
  const pg = node('pg', 'database', NAMES.pg, 800, 60, { workers: 8, readTime: ln(2, 20), writeTime: ln(4, 30) });
  const pay = node('pay', 'external', NAMES.pay, 800, 340, { latency: ln(250, 1200), errorRate: 0.003, quotaRps: 400, quotaBurst: 100, costPer1k: 0.01 });
  return {
    name: NAMES.payment[lang],
    nodes: [client, gw, checkout, pg, pay],
    edges: [
      edge(client, gw, { timeout: 5000 }),
      edge(gw, checkout, { timeout: 4000 }),
      edge(checkout, pg, { order: 0, timeout: 500, poolSize: 10 }),
      edge(checkout, pay, { order: 1, probability: 0.3, timeout: 3000, maxAttempts: 2, backoffBase: 100 }),
    ],
  };
}

export const TOPOLOGY_PRESETS: { id: string; label: Text; make: (lang: Lang) => Topology }[] = [
  { id: 'reference', label: NAMES.ref, make: referenceTopology },
  { id: 'multi', label: NAMES.multi, make: multiSourceTopology },
  { id: 'canary', label: NAMES.canary, make: canaryTopology },
  { id: 'three-tier', label: NAMES.three, make: threeTierTopology },
  { id: 'payment', label: NAMES.payment, make: paymentTopology },
  { id: 'blank', label: NAMES.blank, make: blankTopology },
];

// Rename preset-named nodes / topology into the target language.
export function translateTopology(t: Topology, to: Lang): Topology {
  const from: Lang = to === 'zh' ? 'en' : 'zh';
  const tr = (name: string) => PRESET_NAMES.find((n) => n[from] === name)?.[to] ?? name;
  const trNode = (name: string) => {
    const direct = tr(name);
    if (direct !== name) return direct;
    // default names of new nodes, e.g. "微服务 2" ↔ "Service 2"
    for (const sp of Object.values(NODE_SPECS)) {
      const m = name.match(new RegExp(`^${sp.label[from].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\d+)?$`));
      if (m) return sp.label[to] + (m[1] ?? '');
    }
    return name;
  };
  return { ...t, name: tr(t.name), nodes: t.nodes.map((n) => ({ ...n, name: trNode(n.name) })) };
}

export interface Scenario {
  id: string;
  label: Text;
  description: Text;
  topology: string;
  failure: Omit<FailureSpec, 'id'>;
  setup?: (t: Topology) => void; // patch applied to the topology before the run
  requires?: string[]; // node ids the scenario needs; otherwise its preset is loaded
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'warmup', label: L('缓存冷启动回暖', 'Cache warm-up after restart'), topology: 'reference',
    description: L(
      'Redis 改为按容量推算命中率后重启清空。热门 key 很快回来，长尾要很久；回源把数据库压慢时，回暖也被拖慢。试试把 Postgres 并行执行数调到 4 再跑一次。',
      'Redis switches to capacity-based hit ratio and restarts empty. Hot keys return fast, the long tail slowly; when misses overload the database, warm-up stalls too. Try Postgres at 4 parallel executions and run it again.',
    ),
    failure: { nodeId: 'redis', kind: 'flush', params: {}, duration_s: 2, recovery_s: 0 },
    setup: (t) => { const r = t.nodes.find((n) => n.id === 'redis'); if (r) r.params = { ...r.params, hitMode: 'capacity' }; },
    requires: ['redis', 'pg', 'product', 'order', 'kafka'],
  },
  {
    id: 'stampede', label: L('缓存雪崩', 'Cache stampede'), topology: 'reference',
    description: L('Redis 被清空，命中率掉到 0 后两分钟内逐步恢复。回源流量瞬间放大，打到 Postgres。', 'Redis is flushed. The hit ratio drops to 0 and recovers over two minutes, while origin traffic floods Postgres.'),
    failure: { nodeId: 'redis', kind: 'flush', params: {}, duration_s: 5, recovery_s: 120 },
  },
  {
    id: 'slowdb', label: L('慢查询拖垮线程池', 'Slow queries exhaust threads'), topology: 'reference',
    description: L('Postgres 查询变慢 15 倍。连接池被占满，订单服务线程阻塞，故障一路向上游蔓延。', 'Postgres queries get 15× slower. Connection pools fill, Orders service threads block, and the failure climbs upstream.'),
    failure: { nodeId: 'pg', kind: 'slowQuery', params: { multiplier: 15 }, duration_s: 60, recovery_s: 0 },
  },
  {
    id: 'retrystorm', label: L('重试风暴', 'Retry storm'), topology: 'reference',
    description: L('商品服务只是变慢 3 倍。订单服务超时后重试 2 次，客户端再重试一次，放大的负载把它彻底压垮。', 'The Catalog service only gets 3× slower. Orders retries twice on timeout, clients retry once more, and the amplified load finishes it off.'),
    failure: { nodeId: 'product', kind: 'slow', params: { multiplier: 3 }, duration_s: 45, recovery_s: 0 },
  },
  {
    id: 'surge', label: L('流量突增与消费积压', 'Surge and consumer lag'), topology: 'reference',
    description: L('入口流量翻倍，持续 90 秒。同步链路扛住了，Kafka 消费跟不上，积压持续增长，流量回落后还要很久才能消化完。', 'Traffic doubles for 90 seconds. The synchronous path holds, but Kafka consumers fall behind and the backlog takes long to drain after traffic drops.'),
    failure: { nodeId: 'client', kind: 'surge', params: { multiplier: 2 }, duration_s: 90, recovery_s: 0 },
  },
  {
    id: 'crash', label: L('实例宕机', 'Instance crash'), topology: 'reference',
    description: L('订单服务 1 个实例崩溃。健康检查摘除之前，LB 还会继续往它发请求。', 'One Orders service instance crashes. Until health checks remove it, the LB keeps sending it requests.'),
    failure: { nodeId: 'order', kind: 'instanceDown', params: { count: 1 }, duration_s: 60, recovery_s: 0 },
  },
  {
    id: 'payslow', label: L('支付商变慢', 'Payment provider slowdown'), topology: 'payment',
    description: L(
      '支付商 API 变慢 6 倍，持续 60 秒。结算服务的线程都在等它，线程池被占满，连不需要付款的请求也开始失败。试试把支付调用的超时改成 1 秒，再打开熔断和降级。',
      'The payment provider gets 6× slower for 60 seconds. Checkout threads sit waiting on it, the pool fills, and even requests that never pay start failing. Try a 1 s timeout on the payment call, then turn on the circuit breaker with a fallback.',
    ),
    failure: { nodeId: 'pay', kind: 'slow', params: { multiplier: 6 }, duration_s: 60, recovery_s: 0 },
    requires: ['checkout', 'pay'],
  },
];

export function newNode(type: NodeType, x: number, y: number, existing: NodeCfg[], lang: Lang = 'zh'): NodeCfg {
  LANG = lang;
  const base = NODE_SPECS[type].label[lang];
  let i = 1;
  const names = new Set(existing.map((n) => n.name));
  let name = base;
  while (names.has(name)) name = `${base} ${++i}`;
  let id = `${type}-${Math.random().toString(36).slice(2, 7)}`;
  while (existing.some((n) => n.id === id)) id = `${type}-${Math.random().toString(36).slice(2, 7)}`;
  return node(id, type, L(name, name), x, y);
}

export function newEdge(from: NodeCfg, to: NodeCfg, existing: EdgeCfg[]): EdgeCfg {
  const order = existing.filter((e) => e.from === from.id).length;
  const e = edge(from, to);
  e.params.order = from.type === 'service' ? order : 0;
  if (existing.some((x) => x.id === e.id)) e.id = `${e.id}-${Math.random().toString(36).slice(2, 5)}`;
  return e;
}

export { EDGE_SPECS };
