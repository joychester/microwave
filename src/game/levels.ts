// Challenge levels. Each level is a starting topology, a traffic curve, a fault
// schedule, constraints (SLO + cost budget) and a few locks that keep the puzzle honest.
import { referenceTopology, threeTierTopology } from '../engine/presets';
import { EDGE_SPECS, NODE_SPECS, defaultParams, edgeDefaultsFor } from '../engine/specs';
import { L, type FailureSpec, type Lang, type NodeType, type Params, type Text, type Topology } from '../engine/types';

const ln = (median: number, p99: number) => ({ dist: 'lognormal' as const, median, p99 });

export interface LevelFault {
  at: number; // level seconds
  spec: Omit<FailureSpec, 'id'>;
  label: Text;
  telegraph: number; // seconds of warning shown in the HUD (0 = surprise)
}

export interface Level {
  id: string;
  num: number;
  title: Text;
  story: Text;
  tips: Text[];
  difficulty: 1 | 2 | 3 | 4 | 5;
  make: (lang: Lang) => Topology;
  duration: number; // seconds
  slo: { avail: number; p99: number };
  budget: number; // max average $/h
  errorBudgetFactor: number; // allowed failures = (1 - avail) × expected requests × factor
  traffic: [number, number][]; // [t, rps] piecewise linear
  faults: LevelFault[];
  chaos?: { from: number; every: [number, number]; telegraph: number };
  allowedComponents: NodeType[];
  lockedNodes: string[]; // node ids the player cannot edit or delete
  lockedParams: Partial<Record<NodeType, string[]>>;
  newNodeDefaults: Partial<Record<NodeType, Params>>;
  lagGoal?: { nodeId: string; max: number };
}

// ------------------------------------------------------------------ topologies
function scaleOutTopo(lang: Lang): Topology {
  const t = threeTierTopology(lang);
  t.name = lang === 'en' ? 'Level 1: First scale-out' : '第 1 关：第一次扩容';
  const api = t.nodes.find((n) => n.id === 'api')!;
  api.params = { ...api.params, instances: 2, workers: 40, serviceTime: ln(8, 50), cpuCores: 2 };
  const db = t.nodes.find((n) => n.id === 'db')!;
  db.params = { ...db.params, workers: 16 };
  t.nodes.find((n) => n.id === 'client')!.params.sloP99 = 300;
  return t;
}

function dbReliefTopo(lang: Lang): Topology {
  const t = threeTierTopology(lang);
  t.name = lang === 'en' ? 'Level 2: Take load off the DB' : '第 2 关：给数据库减压';
  const api = t.nodes.find((n) => n.id === 'api')!;
  api.params = { ...api.params, instances: 4, workers: 50, serviceTime: ln(5, 30) };
  const db = t.nodes.find((n) => n.id === 'db')!;
  db.params = { ...db.params, workers: 6, readTime: ln(3, 30), writeTime: ln(5, 40), readRatio: 0.9, maxConnections: 300 };
  db.x = 1060;
  return t;
}

function ref(lang: Lang, zh: string, en: string): Topology {
  const t = referenceTopology(lang);
  t.name = lang === 'en' ? en : zh;
  return t;
}

// ------------------------------------------------------------------ levels
export const LEVELS: Level[] = [
  {
    id: 'scale-out', num: 1, difficulty: 1,
    title: L('第一次扩容', 'First scale-out'),
    story: L(
      '新功能上线了，运营在第 60 秒开始推广，流量会从 300/s 涨到 900/s。API 服务现在只有 2 个实例。',
      'A new feature just shipped. Marketing starts promoting it at 60 s and traffic climbs from 300/s to 900/s. The API service has only 2 instances.',
    ),
    tips: [
      L('选中“API 服务”，增加实例数，盯着卡片上的 CPU 利用率。', 'Select “API service”, add instances and watch its CPU utilization.'),
      L('也可以打开“自动扩缩容”，但冷启动要 30 秒，要提前准备。', 'Or turn on autoscaling, but cold starts take 30 s, so get ahead of the ramp.'),
      L('实例越多越贵。想拿 3 颗星，就别扩太多。', 'More instances cost more. For 3 stars, don’t overprovision.'),
    ],
    make: scaleOutTopo,
    duration: 180,
    slo: { avail: 0.99, p99: 300 },
    budget: 2.2,
    errorBudgetFactor: 1.5,
    traffic: [[0, 300], [60, 300], [110, 900], [180, 900]],
    faults: [],
    allowedComponents: [],
    lockedNodes: ['client', 'lb', 'db'],
    lockedParams: {},
    newNodeDefaults: {},
  },
  {
    id: 'db-relief', num: 2, difficulty: 2,
    title: L('给数据库减压', 'Take load off the DB'),
    story: L(
      '数据库快扛不住了，DBA 说这周不能动它。流量还会从 500/s 涨到 900/s，而 90% 的查询都是读。',
      'The database is close to its limit and the DBA says it can’t be touched this week. Traffic will grow from 500/s to 900/s, and 90% of queries are reads.',
    ),
    tips: [
      L('从左侧拖一个“缓存”到画布上。', 'Drag a Cache from the left onto the canvas.'),
      L('选中“API 服务 → MySQL”这条连线，按 Delete 删掉。', 'Select the “API service → MySQL” edge and press Delete.'),
      L('连接“API 服务 → 缓存”和“缓存 → MySQL”。缓存未命中时会回源到数据库。', 'Connect “API service → Cache” and “Cache → MySQL”. Misses fall through to the database.'),
    ],
    make: dbReliefTopo,
    duration: 180,
    slo: { avail: 0.99, p99: 400 },
    budget: 2.4,
    errorBudgetFactor: 1.5,
    traffic: [[0, 500], [60, 500], [90, 900], [180, 900]],
    faults: [],
    allowedComponents: ['cache'],
    lockedNodes: ['client', 'lb', 'db'],
    lockedParams: { cache: ['hitRatio', 'hotKeyShare', 'hitMode'] },
    newNodeDefaults: { cache: { hitRatio: 0.9, shards: 4 } },
  },
  {
    id: 'retry-storm', num: 3, difficulty: 3,
    title: L('重试风暴', 'Retry storm'),
    story: L(
      '第 45 秒，商品服务的一个依赖会变慢，商品服务整体慢 3 倍，持续 60 秒。预算不够你把它扩到 3 倍。',
      'At 45 s a dependency slows the Catalog service down 3× for 60 seconds. The budget won’t let you triple its capacity.',
    ),
    tips: [
      L('订单服务调用商品服务时会重试 2 次，客户端还会再重试一次。重试会把负载放大。', 'Orders retries Catalog twice and clients retry once more. Retries multiply the load.'),
      L('试试在“订单服务 → 商品服务”上开熔断器，并选“降级返回默认值”。', 'Try a circuit breaker on “Orders service → Catalog service” with “Return a fallback”.'),
      L('减少重试次数、或者给商品服务设置排队超时丢弃，也能保护它。', 'Fewer retries, or a queue timeout on the Catalog service, also protect it.'),
    ],
    make: (lang) => ref(lang, '第 3 关：重试风暴', 'Level 3: Retry storm'),
    duration: 150,
    slo: { avail: 0.99, p99: 800 },
    budget: 5.0,
    errorBudgetFactor: 3,
    traffic: [[0, 500], [150, 500]],
    faults: [{
      at: 45, telegraph: 15,
      label: L('商品服务变慢 3 倍', 'Catalog service 3× slower'),
      spec: { nodeId: 'product', kind: 'slow', params: { multiplier: 3 }, duration_s: 60, recovery_s: 0 },
    }],
    allowedComponents: [],
    lockedNodes: ['client'],
    lockedParams: {},
    newNodeDefaults: {},
  },
  {
    id: 'black-friday', num: 4, difficulty: 4,
    title: L('黑色星期五', 'Black Friday'),
    story: L(
      '大促来了。流量在 2 分钟内涨到平时的 3 倍，坚持一分钟后回落。订单事件全部进 Kafka，结束时积压要低于 2000 条。',
      'The sale is on. Traffic triples within two minutes, holds for a minute, then drops. Every order event goes through Kafka, and the backlog must be under 2,000 at the end.',
    ),
    tips: [
      L('先打开“容量分析”，把目标流量设成 1500/s，看看谁会先撑不住。', 'Open the Capacity tab and set the target to 1500/s to see what breaks first.'),
      L('自动扩缩容可以省钱，但冷启动有延迟；关键服务可以先预留一些实例。', 'Autoscaling saves money but cold starts lag; pre-provision the critical services.'),
      L('Kafka 的有效并行度受分区数限制，消费者再多也没用。', 'Kafka parallelism is capped by partitions, so extra consumers alone won’t help.'),
    ],
    make: (lang) => ref(lang, '第 4 关：黑色星期五', 'Level 4: Black Friday'),
    duration: 240,
    slo: { avail: 0.995, p99: 600 },
    budget: 8.0,
    errorBudgetFactor: 2,
    traffic: [[0, 500], [30, 500], [60, 1000], [120, 1500], [180, 1500], [205, 600], [240, 600]],
    faults: [],
    allowedComponents: [],
    lockedNodes: ['client'],
    lockedParams: {},
    newNodeDefaults: {},
    lagGoal: { nodeId: 'kafka', max: 2000 },
  },
  {
    id: 'chaos', num: 5, difficulty: 5,
    title: L('混沌猴子', 'Chaos monkey'),
    story: L(
      '混沌猴子被放出来了。每隔半分钟左右就会随机制造一次故障，只提前 5 秒预警。流量还会慢慢涨到 800/s。',
      'The chaos monkey is loose. Roughly every half minute it breaks something at random, with only 5 seconds of warning. Traffic also creeps up to 800/s.',
    ),
    tips: [
      L('预先加好防护：熔断、排队超时丢弃、重试预算、留一些余量。', 'Prepare defenses up front: circuit breakers, queue timeouts, retry budgets and some headroom.'),
      L('故障来了别慌，看“失败原因”图表找到源头。', 'When a fault hits, use the “Why user requests fail” chart to find the source.'),
      L('LB 用 P2C 或最少连接，宕机实例的影响会小很多。', 'P2C or least-connections on the LBs limits the damage from a crashed instance.'),
    ],
    make: (lang) => ref(lang, '第 5 关：混沌猴子', 'Level 5: Chaos monkey'),
    duration: 240,
    slo: { avail: 0.99, p99: 800 },
    budget: 7.0,
    errorBudgetFactor: 3,
    traffic: [[0, 500], [60, 500], [180, 800], [240, 800]],
    faults: [],
    chaos: { from: 25, every: [25, 38], telegraph: 5 },
    allowedComponents: [],
    lockedNodes: ['client'],
    lockedParams: {},
    newNodeDefaults: {},
  },
];

// Chaos monkey's menu: [label, spec]
const CHAOS: { label: Text; spec: Omit<FailureSpec, 'id'> }[] = [
  { label: L('订单服务实例宕机', 'Orders service instance crash'), spec: { nodeId: 'order', kind: 'instanceDown', params: { count: 1 }, duration_s: 30, recovery_s: 0 } },
  { label: L('商品服务变慢 4 倍', 'Catalog service 4× slower'), spec: { nodeId: 'product', kind: 'slow', params: { multiplier: 4 }, duration_s: 20, recovery_s: 0 } },
  { label: L('Redis 被清空', 'Redis flushed'), spec: { nodeId: 'redis', kind: 'flush', params: {}, duration_s: 3, recovery_s: 45 } },
  { label: L('Postgres 慢查询', 'Postgres slow queries'), spec: { nodeId: 'pg', kind: 'slowQuery', params: { multiplier: 4 }, duration_s: 15, recovery_s: 0 } },
  { label: L('履约服务 2 个实例宕机', 'Two Fulfillment instances crash'), spec: { nodeId: 'fulfill', kind: 'instanceDown', params: { count: 2 }, duration_s: 30, recovery_s: 0 } },
  { label: L('Kafka 消费者崩溃', 'Kafka consumers crash'), spec: { nodeId: 'kafka', kind: 'consumerCrash', params: { count: 3 }, duration_s: 30, recovery_s: 0 } },
  { label: L('商品服务错误率飙升', 'Catalog service error spike'), spec: { nodeId: 'product', kind: 'errorSpike', params: { rate: 0.15 }, duration_s: 20, recovery_s: 0 } },
  { label: L('Postgres 主从切换', 'Postgres failover'), spec: { nodeId: 'pg', kind: 'failover', params: {}, duration_s: 8, recovery_s: 0 } },
];

/** All faults for one attempt: fixed ones plus a fresh chaos draw. */
export function planFaults(level: Level, rand: () => number = Math.random): LevelFault[] {
  const out = [...level.faults];
  if (level.chaos) {
    let t = level.chaos.from;
    let last = -1;
    while (t < level.duration - 20) {
      let i = Math.floor(rand() * CHAOS.length);
      if (i === last) i = (i + 1) % CHAOS.length;
      last = i;
      out.push({ at: Math.round(t), telegraph: level.chaos.telegraph, label: CHAOS[i].label, spec: CHAOS[i].spec });
      t += level.chaos.every[0] + rand() * (level.chaos.every[1] - level.chaos.every[0]);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export function trafficAt(level: Level, t: number): number {
  const c = level.traffic;
  if (t <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (t <= c[i][0]) {
      const [t0, v0] = c[i - 1];
      const [t1, v1] = c[i];
      return v0 + ((v1 - v0) * (t - t0)) / Math.max(1e-9, t1 - t0);
    }
  }
  return c[c.length - 1][1];
}

export function expectedRequests(level: Level): number {
  let sum = 0;
  for (let t = 0; t < level.duration; t++) sum += trafficAt(level, t + 0.5);
  return sum;
}

export function isParamLocked(level: Level | null, nodeId: string, type: NodeType, key: string): boolean {
  if (!level) return false;
  if (level.lockedNodes.includes(nodeId)) return true;
  return level.lockedParams[type]?.includes(key) ?? false;
}

export { EDGE_SPECS, NODE_SPECS, defaultParams, edgeDefaultsFor };
