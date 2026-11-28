// Declarative parameter specs. The engine reads params by key;
// the UI generates forms from these specs. One source of truth. All text is bilingual.
import { L, type Dist, type NodeType, type Params, type Text } from './types';

export type ParamKind = 'int' | 'number' | 'ratio' | 'ms' | 'seconds' | 'bool' | 'enum' | 'dist' | 'text' | 'pathmix';

export type GroupId =
  | 'traffic' | 'route' | 'slo' | 'capacity' | 'processing' | 'ratelimit' | 'autoscale' | 'routing' | 'health' | 'gc'
  | 'hit' | 'load' | 'usl' | 'produce' | 'consume' | 'call' | 'retry' | 'breaker' | 'pool' | 'quota' | 'billing';

export const GROUP_LABELS: Record<GroupId, Text> = {
  traffic: L('流量', 'Traffic'),
  route: L('路由', 'Routing'),
  slo: L('SLO', 'SLO'),
  capacity: L('容量', 'Capacity'),
  processing: L('处理', 'Processing'),
  ratelimit: L('限流', 'Rate limiting'),
  autoscale: L('自动扩缩容', 'Autoscaling'),
  routing: L('分流', 'Balancing'),
  health: L('健康检查', 'Health checks'),
  gc: L('GC', 'GC'),
  hit: L('命中', 'Hits'),
  load: L('负载', 'Workload'),
  usl: L('可扩展性（USL）', 'Scalability (USL)'),
  produce: L('生产', 'Produce'),
  consume: L('消费', 'Consume'),
  call: L('调用', 'Call'),
  retry: L('超时与重试', 'Timeouts & retries'),
  breaker: L('熔断', 'Circuit breaker'),
  pool: L('连接池', 'Connection pool'),
  quota: L('配额', 'Quota'),
  billing: L('计费', 'Billing'),
};

export interface ParamSpec {
  key: string;
  label: Text;
  kind: ParamKind;
  default: number | boolean | string | Dist;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: Text }[];
  group: GroupId;
  help?: Text;
  showIf?: (p: Params) => boolean;
}

export interface FailureKindSpec {
  kind: string;
  label: Text;
  help: Text;
  params: { key: string; label: Text; default: number; min?: number; max?: number; step?: number }[];
  defaultDuration: number; // s, 0 = until cleared
  defaultRecovery?: number;
}

export interface NodeTypeSpec {
  type: NodeType;
  label: Text;
  short: string;
  blurb: Text;
  params: ParamSpec[];
  failures: FailureKindSpec[];
}

const ln = (median: number, p99: number): Dist => ({ dist: 'lognormal', median, p99 });

// maxInst matches the component's own Instances limit, so the autoscaler can't grow past it
const autoscale = (target = 0.6, maxInst = 100): ParamSpec[] => [
  { key: 'asEnabled', label: L('自动扩缩容', 'Autoscaling'), kind: 'bool', default: false, group: 'autoscale' },
  { key: 'asTarget', label: L('目标 CPU 利用率', 'Target CPU utilization'), kind: 'ratio', default: target, min: 0.1, max: 0.95, step: 0.05, group: 'autoscale', showIf: (p) => !!p.asEnabled },
  { key: 'asMin', label: L('最少实例', 'Min instances'), kind: 'int', default: 2, min: 1, max: maxInst, group: 'autoscale', showIf: (p) => !!p.asEnabled },
  { key: 'asMax', label: L('最多实例', 'Max instances'), kind: 'int', default: 20, min: 1, max: maxInst, group: 'autoscale', showIf: (p) => !!p.asEnabled },
  { key: 'asPeriod', label: L('决策周期', 'Sync period'), kind: 'seconds', default: 15, min: 1, max: 120, group: 'autoscale', showIf: (p) => !!p.asEnabled, help: L('K8s HPA 默认 15 秒', 'Kubernetes HPA default is 15 s') },
  { key: 'asColdStart', label: L('冷启动', 'Cold start'), kind: 'seconds', default: 30, min: 0, max: 600, group: 'autoscale', showIf: (p) => !!p.asEnabled, help: L('新实例创建到可以接流量的时间', 'Time from creating an instance until it can take traffic') },
  { key: 'asDownStab', label: L('缩容稳定窗口', 'Scale-down stabilization'), kind: 'seconds', default: 60, min: 0, max: 600, group: 'autoscale', showIf: (p) => !!p.asEnabled },
];

export const NODE_SPECS: Record<NodeType, NodeTypeSpec> = {
  client: {
    type: 'client',
    label: L('流量源', 'Traffic source'),
    short: 'Client',
    blurb: L('产生请求，并定义面向用户的 SLO', 'Generates requests and defines the user-facing SLO'),
    params: [
      { key: 'rps', label: L('基础流量', 'Base traffic'), kind: 'number', default: 300, min: 0, max: 20000, step: 10, group: 'traffic', help: L('每秒请求数（rps），泊松到达', 'Requests per second, Poisson arrivals') },
      { key: 'pattern', label: L('流量形态', 'Traffic shape'), kind: 'enum', default: 'constant', group: 'traffic', options: [
        { value: 'constant', label: L('恒定', 'Constant') }, { value: 'burst', label: L('周期突发', 'Periodic bursts') }, { value: 'diurnal', label: L('日周期（压缩）', 'Diurnal (compressed)') },
      ] },
      { key: 'burstMult', label: L('突发倍数', 'Burst multiplier'), kind: 'number', default: 3, min: 1, max: 20, step: 0.5, group: 'traffic', showIf: (p) => p.pattern === 'burst' },
      { key: 'burstEvery', label: L('突发间隔', 'Burst interval'), kind: 'seconds', default: 60, min: 5, max: 600, group: 'traffic', showIf: (p) => p.pattern === 'burst' },
      { key: 'burstDur', label: L('突发持续', 'Burst duration'), kind: 'seconds', default: 10, min: 1, max: 300, group: 'traffic', showIf: (p) => p.pattern === 'burst' },
      { key: 'diurnalPeriod', label: L('周期长度', 'Period'), kind: 'seconds', default: 300, min: 30, max: 3600, group: 'traffic', showIf: (p) => p.pattern === 'diurnal', help: L('把一天压缩到这么长', 'One day compressed into this many seconds') },
      { key: 'diurnalTrough', label: L('低谷 / 高峰', 'Trough / peak'), kind: 'ratio', default: 0.3, min: 0, max: 1, step: 0.05, group: 'traffic', showIf: (p) => p.pattern === 'diurnal' },
      { key: 'mix', label: L('请求路径组成', 'Request path mix'), kind: 'pathmix', default: '/orders:30,/products:70', group: 'traffic', help: L('每条路径占总流量的百分比，合计须为 100%。API Gateway 按路径前缀路由', 'Each path\u2019s share of the traffic; the shares must add up to 100%. The API Gateway routes by path prefix') },
      { key: 'sloAvail', label: L('可用性 SLO', 'Availability SLO'), kind: 'number', default: 0.999, min: 0.9, max: 0.99999, step: 0.0005, group: 'slo' },
      { key: 'sloPct', label: L('延迟 SLO 分位数', 'Latency SLO percentile'), kind: 'enum', default: 'p95', group: 'slo', options: [
        { value: 'p95', label: L('p95', 'p95') }, { value: 'p99', label: L('p99', 'p99') },
      ], help: L('延迟指标、SLO 判定和运行报告都按这个分位数计算', 'Latency figures, the SLO check and run reports all use this percentile') },
      { key: 'sloP99', label: L('延迟 SLO', 'Latency SLO'), kind: 'ms', default: 500, min: 10, max: 30000, group: 'slo', help: L('按上面选的分位数衡量', 'Measured at the percentile chosen above') },
    ],
    failures: [
      { kind: 'surge', label: L('流量突增', 'Traffic surge'), help: L('入口流量放大 N 倍', 'Multiplies incoming traffic by N'), params: [{ key: 'multiplier', label: L('倍数', 'Multiplier'), default: 3, min: 1, max: 20, step: 0.5 }], defaultDuration: 60 },
    ],
  },
  gateway: {
    type: 'gateway',
    label: L('API Gateway', 'API Gateway'),
    short: 'Gateway',
    blurb: L('统一入口：鉴权、限流、按路径路由', 'Single entry point: auth, rate limiting, path routing'),
    params: [
      { key: 'instances', label: L('实例数', 'Instances'), kind: 'int', default: 2, min: 1, max: 200, group: 'capacity' },
      { key: 'workers', label: L('每实例并发', 'Concurrency per instance'), kind: 'int', default: 1000, min: 1, max: 100000, group: 'capacity' },
      { key: 'queueCap', label: L('每实例队列', 'Queue per instance'), kind: 'int', default: 500, min: 0, max: 100000, group: 'capacity', help: L('队列满时直接返回 503', 'Returns 503 when the queue is full') },
      { key: 'latency', label: L('自身处理时间', 'Processing time'), kind: 'dist', default: ln(1, 5), group: 'processing' },
      { key: 'authLatency', label: L('鉴权插件开销', 'Auth plugin cost'), kind: 'dist', default: ln(0.3, 2), group: 'processing', help: L('本地 JWT 校验的耗时', 'Local JWT validation time') },
      { key: 'rlEnabled', label: L('限流', 'Rate limiting'), kind: 'bool', default: false, group: 'ratelimit' },
      { key: 'rlRps', label: L('限流速率', 'Rate limit'), kind: 'number', default: 1000, min: 1, max: 100000, step: 10, group: 'ratelimit', showIf: (p) => !!p.rlEnabled },
      { key: 'rlBurst', label: L('突发容量', 'Burst capacity'), kind: 'int', default: 200, min: 1, max: 100000, group: 'ratelimit', showIf: (p) => !!p.rlEnabled },
      ...autoscale(0.6, 200),
    ],
    failures: [
      { kind: 'instanceDown', label: L('实例宕机', 'Instance crash'), help: L('部分实例崩溃，在途请求失败', 'Some instances crash; in-flight requests fail'), params: [{ key: 'count', label: L('数量', 'Count'), default: 1, min: 1, max: 100 }], defaultDuration: 60 },
    ],
  },
  lb: {
    type: 'lb',
    label: L('Load Balancer', 'Load balancer'),
    short: 'LB',
    blurb: L('把流量分到同一服务的多个实例', 'Spreads traffic across instances of one service'),
    params: [
      { key: 'algorithm', label: L('分流算法', 'Algorithm'), kind: 'enum', default: 'round_robin', group: 'routing', options: [
        { value: 'round_robin', label: L('轮询', 'Round robin') }, { value: 'random', label: L('随机', 'Random') },
        { value: 'least_conn', label: L('最少连接', 'Least connections') }, { value: 'p2c', label: L('P2C（二选一最少连接）', 'P2C (power of two choices)') },
      ], help: L('轮询遇到慢实例会被拖累；最少连接和 P2C 会自动绕开', 'Round robin suffers from slow instances; least connections and P2C route around them') },
      { key: 'latency', label: L('附加延迟', 'Added latency'), kind: 'dist', default: ln(0.3, 2), group: 'routing' },
      { key: 'hcInterval', label: L('健康检查间隔', 'Check interval'), kind: 'seconds', default: 10, min: 1, max: 60, group: 'health' },
      { key: 'hcThreshold', label: L('失败几次摘除', 'Failures before removal'), kind: 'int', default: 3, min: 1, max: 10, group: 'health', help: L('故障实例最多会继续接流量 间隔 × 次数 秒', 'A failed instance keeps receiving traffic for up to interval × failures seconds') },
    ],
    failures: [],
  },
  service: {
    type: 'service',
    label: L('微服务', 'Service'),
    short: 'Service',
    blurb: L('无状态服务：线程池 + 本地计算 + 下游调用', 'Stateless service: thread pool, local work, downstream calls'),
    params: [
      { key: 'instances', label: L('实例数', 'Instances'), kind: 'int', default: 3, min: 1, max: 100, group: 'capacity' },
      { key: 'workers', label: L('每实例线程数', 'Threads per instance'), kind: 'int', default: 50, min: 1, max: 10000, group: 'capacity', help: L('同时处理的请求上限（线程池 / 并发上限）', 'Requests handled at once (thread pool / concurrency limit)') },
      { key: 'queueCap', label: L('每实例队列', 'Queue per instance'), kind: 'int', default: 100, min: 0, max: 100000, group: 'capacity', help: L('线程全忙时排队；队列满返回 503', 'Requests wait here when all threads are busy; 503 when full') },
      { key: 'queueTimeout', label: L('排队超时丢弃', 'Queue timeout (shed)'), kind: 'ms', default: 0, min: 0, max: 60000, group: 'capacity', help: L('排队超过此时间直接丢弃（load shedding），0 表示不启用', 'Drop requests that waited longer than this (load shedding). 0 disables it') },
      { key: 'serviceTime', label: L('本地处理时间', 'Local processing time'), kind: 'dist', default: ln(10, 60), group: 'processing', help: L('不含下游调用的耗时', 'Excludes time spent in downstream calls') },
      { key: 'pathCost', label: L('按路径的处理时间倍数', 'Processing time by path'), kind: 'text', default: '', group: 'processing', help: L('不同请求路径的处理时间是上面的几倍，比如 /search:6,/orders:1：搜索请求的处理时间是 6 倍。按最长前缀匹配，没匹配上的按 1 倍。留空表示所有路径一样', 'How many times the time above each request path takes, e.g. /search:6,/orders:1 makes search requests take 6 times as long. The longest matching prefix wins; unmatched paths take 1×. Leave empty for the same on every path') },
      { key: 'cpuCores', label: L('每实例 CPU 核数', 'CPU cores per instance'), kind: 'number', default: 2, min: 0.25, max: 64, step: 0.25, group: 'processing' },
      { key: 'cpuFraction', label: L('CPU 占处理时间比例', 'CPU share of processing'), kind: 'ratio', default: 0.7, min: 0, max: 1, step: 0.05, group: 'processing', help: L('其余时间在等待 I/O。CPU 不够时计算部分要排队等核', 'The rest is I/O wait. When cores run out, the CPU part queues for a core') },
      { key: 'holdWorker', label: L('调用下游时占用线程', 'Hold thread during calls'), kind: 'bool', default: true, group: 'processing', help: L('同步阻塞模型：下游变慢会耗尽本服务线程池，故障向上游传播', 'Blocking model: a slow dependency exhausts this thread pool and the failure spreads upstream') },
      { key: 'errorRate', label: L('自身错误率', 'Own error rate'), kind: 'ratio', default: 0, min: 0, max: 1, step: 0.001, group: 'processing' },
      { key: 'gcEnabled', label: L('GC 暂停', 'GC pauses'), kind: 'bool', default: false, group: 'gc' },
      { key: 'gcInterval', label: L('GC 间隔', 'GC interval'), kind: 'seconds', default: 20, min: 1, max: 600, group: 'gc', showIf: (p) => !!p.gcEnabled },
      { key: 'gcPause', label: L('暂停时长', 'Pause length'), kind: 'dist', default: ln(30, 300), group: 'gc', showIf: (p) => !!p.gcEnabled },
      ...autoscale(0.6),
    ],
    failures: [
      { kind: 'slow', label: L('变慢', 'Slowdown'), help: L('本地处理时间放大 N 倍（依赖退化、代码回归）', 'Local processing time × N (degraded dependency, code regression)'), params: [{ key: 'multiplier', label: L('倍数', 'Multiplier'), default: 8, min: 1, max: 100 }], defaultDuration: 45 },
      { kind: 'instanceDown', label: L('实例宕机', 'Instance crash'), help: L('部分实例崩溃；结束后重新拉起', 'Some instances crash and restart when the fault ends'), params: [{ key: 'count', label: L('数量', 'Count'), default: 1, min: 1, max: 100 }], defaultDuration: 60 },
      { kind: 'errorSpike', label: L('错误率飙升', 'Error spike'), help: L('返回 5xx 的比例上升', 'A higher share of requests return 5xx'), params: [{ key: 'rate', label: L('错误率', 'Error rate'), default: 0.3, min: 0, max: 1, step: 0.05 }], defaultDuration: 30 },
    ],
  },
  cache: {
    type: 'cache',
    label: L('缓存', 'Cache'),
    short: 'Redis',
    blurb: L('命中直接返回，未命中回源（出边指向回源目标）', 'Hits return directly; misses go to the origin (its outgoing edge)'),
    params: [
      { key: 'shards', label: L('分片数', 'Shards'), kind: 'int', default: 6, min: 1, max: 256, group: 'capacity', help: L('Redis 每分片单线程执行命令', 'Redis runs commands single-threaded per shard') },
      { key: 'opLatency', label: L('命令执行时间', 'Command time'), kind: 'dist', default: ln(0.2, 1.5), group: 'processing' },
      { key: 'hitMode', label: L('命中率来源', 'Hit ratio from'), kind: 'enum', default: 'fixed', group: 'hit', options: [
        { value: 'fixed', label: L('直接指定', 'A fixed value') }, { value: 'capacity', label: L('按容量推算', 'Cache capacity') },
      ], help: L('直接指定：填一个命中率（可以用监控里的真实值）。按容量推算：由容量、key 总数和访问倾斜度算出，缓存清空后随回源逐步回暖', 'Fixed: enter a hit ratio (e.g. the real one from monitoring). Capacity: derived from capacity, key count and access skew; after a flush it warms up as misses are filled') },
      { key: 'hitRatio', label: L('命中率', 'Hit ratio'), kind: 'ratio', default: 0.9, min: 0, max: 1, step: 0.01, group: 'hit', showIf: (p) => p.hitMode !== 'capacity' },
      { key: 'keysPerShard', label: L('每分片可存 key 数', 'Keys per shard'), kind: 'int', default: 80000, min: 100, max: 100000000, group: 'hit', showIf: (p) => p.hitMode === 'capacity', help: L('总容量 = 分片数 × 每分片 key 数。加分片既加吞吐也加容量', 'Total capacity = shards × keys per shard. More shards add throughput and capacity') },
      { key: 'keySpace', label: L('key 总数', 'Distinct keys'), kind: 'int', default: 1000000, min: 1, max: 1000000000, group: 'hit', showIf: (p) => p.hitMode === 'capacity', help: L('业务里会被访问到的不同 key 的数量', 'How many different keys the workload touches') },
      { key: 'zipf', label: L('访问倾斜度', 'Access skew'), kind: 'number', default: 1.0, min: 0.3, max: 1.6, step: 0.05, group: 'hit', showIf: (p) => p.hitMode === 'capacity', help: L('Zipf 指数 s。越大越集中在少数热门 key：0.7 较平均，1.0 常见，1.2 以上非常集中', 'Zipf exponent s. Higher means traffic concentrates on fewer hot keys: 0.7 fairly even, 1.0 typical, 1.2+ very concentrated') },
      { key: 'coldStart', label: L('启动时缓存为空', 'Start with an empty cache'), kind: 'bool', default: false, group: 'hit', showIf: (p) => p.hitMode === 'capacity', help: L('模拟刚部署或刚重启：从 0 开始回暖', 'Simulates a fresh deploy or restart: warms up from zero') },
      { key: 'hotKeyShare', label: L('热点分片流量占比', 'Hot shard share'), kind: 'ratio', default: 0, min: 0, max: 1, step: 0.05, group: 'hit', help: L('落在同一个分片上的流量比例（数据倾斜）', 'Share of traffic landing on a single shard (data skew)') },
      { key: 'populate', label: L('未命中后回写', 'Write back on miss'), kind: 'bool', default: true, group: 'hit', help: L('cache-aside：回源成功后写回缓存，多一次写操作', 'Cache-aside: write the value back after the origin fetch, one extra write') },
    ],
    failures: [
      { kind: 'flush', label: L('缓存清空（雪崩）', 'Cache flush (stampede)'), help: L('命中率掉到 0。直接指定模式下线性恢复；按容量推算模式下随回源逐步回暖', 'Hit ratio drops to 0. Fixed mode recovers linearly; capacity mode warms up as misses are refilled'), params: [], defaultDuration: 5, defaultRecovery: 120 },
      { kind: 'shardDown', label: L('分片宕机', 'Shard down'), help: L('一个分片的请求全部失败', 'All requests to one shard fail'), params: [], defaultDuration: 30 },
      { kind: 'hotKey', label: L('热点 key', 'Hot key'), help: L('大量流量集中到一个分片', 'Traffic concentrates on one shard'), params: [{ key: 'share', label: L('占比', 'Share'), default: 0.5, min: 0, max: 1, step: 0.05 }], defaultDuration: 60 },
    ],
  },
  database: {
    type: 'database',
    label: L('数据库', 'Database'),
    short: 'SQL DB',
    blurb: L('主库 + 只读副本；连接数上限与锁竞争', 'Primary plus read replicas; connection limit and contention'),
    params: [
      { key: 'workers', label: L('主库并行执行数', 'Parallel executions (primary)'), kind: 'int', default: 16, min: 1, max: 1000, group: 'capacity', help: L('大约是 CPU 核数 × 2', 'Roughly CPU cores × 2') },
      { key: 'maxConnections', label: L('最大连接数', 'Max connections'), kind: 'int', default: 200, min: 1, max: 100000, group: 'capacity', help: L('所有调用方连接池之和超过它，新连接会被拒绝', 'New connections are refused once all callers’ pools together exceed this') },
      { key: 'replicas', label: L('只读副本数', 'Read replicas'), kind: 'int', default: 0, min: 0, max: 15, group: 'capacity' },
      { key: 'readRouting', label: L('读请求路由', 'Read routing'), kind: 'enum', default: 'primary', group: 'capacity', options: [
        { value: 'primary', label: L('只读主库', 'Primary only') }, { value: 'replicas', label: L('读走副本', 'Replicas') }, { value: 'mixed', label: L('主库和副本均分', 'Spread evenly') },
      ], showIf: (p) => Number(p.replicas) > 0 },
      { key: 'readRatio', label: L('读请求占比', 'Read share'), kind: 'ratio', default: 0.8, min: 0, max: 1, step: 0.05, group: 'load' },
      { key: 'readTime', label: L('读查询时间', 'Read query time'), kind: 'dist', default: ln(2, 20), group: 'load' },
      { key: 'writeTime', label: L('写查询时间', 'Write query time'), kind: 'dist', default: ln(4, 30), group: 'load' },
      { key: 'uslAlpha', label: L('竞争系数 α', 'Contention α'), kind: 'number', default: 0.02, min: 0, max: 1, step: 0.005, group: 'usl', help: L('并发越高单个查询越慢：S × (1 + α(N−1) + βN(N−1))', 'Queries slow down with concurrency: S × (1 + α(N−1) + βN(N−1))') },
      { key: 'uslBeta', label: L('一致性系数 β', 'Coherency β'), kind: 'number', default: 0.0005, min: 0, max: 0.05, step: 0.0001, group: 'usl', help: L('β > 0 时存在吞吐峰值 N* = √((1−α)/β)', 'With β > 0 throughput peaks at N* = √((1−α)/β)') },
    ],
    failures: [
      { kind: 'failover', label: L('主从切换', 'Failover'), help: L('切换期间主库请求全部失败', 'All requests to the primary fail during failover'), params: [], defaultDuration: 30 },
      { kind: 'slowQuery', label: L('慢查询', 'Slow queries'), help: L('查询时间放大 N 倍（缺索引、执行计划变化）', 'Query time × N (missing index, plan change)'), params: [{ key: 'multiplier', label: L('倍数', 'Multiplier'), default: 15, min: 1, max: 200 }], defaultDuration: 60 },
      { kind: 'lockContention', label: L('锁竞争', 'Lock contention'), help: L('USL 竞争系数 α 升高', 'Raises the USL contention coefficient α'), params: [{ key: 'alpha', label: L('α', 'α'), default: 0.2, min: 0, max: 1, step: 0.05 }], defaultDuration: 60 },
    ],
  },
  queue: {
    type: 'queue',
    label: L('消息队列', 'Message queue'),
    short: 'Kafka',
    blurb: L('异步解耦：生产者写入，消费者组拉取（出边指向消费者服务）', 'Async decoupling: producers write, a consumer group pulls (outgoing edge = consumer)'),
    params: [
      { key: 'partitions', label: L('分区数', 'Partitions'), kind: 'int', default: 12, min: 1, max: 1000, group: 'capacity' },
      { key: 'consumers', label: L('消费者数', 'Consumers'), kind: 'int', default: 6, min: 1, max: 1000, group: 'consume', help: L('有效并行度 = min(消费者数, 分区数)', 'Effective parallelism = min(consumers, partitions)') },
      { key: 'produceLatency', label: L('写入延迟', 'Produce latency'), kind: 'dist', default: ln(3, 20), group: 'produce' },
      { key: 'pollInterval', label: L('空闲轮询间隔', 'Idle poll interval'), kind: 'ms', default: 100, min: 1, max: 5000, group: 'consume' },
      { key: 'rebalancePause', label: L('Rebalance 暂停', 'Rebalance pause'), kind: 'seconds', default: 10, min: 0, max: 120, group: 'consume', help: L('消费者数量变化时，整个消费组暂停消费', 'The whole group stops consuming whenever membership changes') },
    ],
    failures: [
      { kind: 'consumerCrash', label: L('消费者崩溃', 'Consumer crash'), help: L('部分消费者退出并触发 rebalance', 'Some consumers exit and trigger a rebalance'), params: [{ key: 'count', label: L('数量', 'Count'), default: 3, min: 1, max: 100 }], defaultDuration: 60 },
    ],
  },
  external: {
    type: 'external',
    label: L('外部依赖', 'Third-party API'),
    short: 'API',
    blurb: L('不归你管的服务：支付、短信、地图、LLM。只能按它的延迟、错误率和配额来用，没法给它扩容', 'A service you don’t run: payments, SMS, maps, LLMs. You live with its latency, error rate and quota; you can’t add capacity to it'),
    params: [
      { key: 'latency', label: L('响应时间', 'Response time'), kind: 'dist', default: ln(150, 900), group: 'processing', help: L('从你这边看到的耗时（含网络）。对方内部怎么排队看不到，当成黑盒', 'As seen from your side, network included. Its internals are a black box') },
      { key: 'errorRate', label: L('错误率', 'Error rate'), kind: 'ratio', default: 0.002, min: 0, max: 1, step: 0.001, group: 'processing', help: L('正常情况下返回 5xx 的比例，可以参考对方的 SLA', 'Share of calls that fail with 5xx in normal operation; the provider’s SLA is a good guide') },
      { key: 'quotaRps', label: L('配额（每秒请求数）', 'Quota (requests per second)'), kind: 'number', default: 200, min: 0, max: 1000000, step: 10, group: 'quota', help: L('对方允许的速率，超出返回 429。0 表示不限', 'The rate the provider allows; calls above it get 429. 0 means unlimited') },
      { key: 'quotaBurst', label: L('突发额度', 'Burst allowance'), kind: 'int', default: 50, min: 1, max: 1000000, group: 'quota', showIf: (p) => Number(p.quotaRps) > 0, help: L('令牌桶容量：短时间内可以超出速率的请求数', 'Token bucket size: how many calls may briefly exceed the rate') },
      { key: 'maxConcurrent', label: L('并发上限', 'Concurrent request limit'), kind: 'int', default: 0, min: 0, max: 1000000, group: 'quota', help: L('同时在途的请求上限，超出返回 429。0 表示不限', 'Calls in flight at once; beyond it calls get 429. 0 means unlimited') },
      { key: 'costPer1k', label: L('每千次调用费用（$）', 'Cost per 1,000 calls ($)'), kind: 'number', default: 0, min: 0, max: 10000, step: 0.01, group: 'billing', help: L('按调用计费的 API（LLM、地图、短信）填这里，计入运行成本。被 429 拒绝的调用不计费', 'For APIs billed per call (LLMs, maps, SMS); added to the running cost. Calls rejected with 429 are not billed') },
    ],
    failures: [
      { kind: 'slow', label: L('对方变慢', 'Provider slowdown'), help: L('响应时间放大 N 倍', 'Response time × N'), params: [{ key: 'multiplier', label: L('倍数', 'Multiplier'), default: 5, min: 1, max: 100 }], defaultDuration: 60 },
      { kind: 'outage', label: L('对方不可用', 'Provider outage'), help: L('所有调用快速失败（连接被拒）', 'Every call fails fast (connection refused)'), params: [], defaultDuration: 60 },
      { kind: 'errorSpike', label: L('错误率飙升', 'Error spike'), help: L('返回 5xx 的比例上升', 'A higher share of calls return 5xx'), params: [{ key: 'rate', label: L('错误率', 'Error rate'), default: 0.3, min: 0, max: 1, step: 0.05 }], defaultDuration: 30 },
      { kind: 'quotaCut', label: L('配额下调', 'Quota cut'), help: L('对方临时限流，只剩原配额的一部分', 'The provider throttles you to a fraction of the quota'), params: [{ key: 'share', label: L('剩余比例', 'Share left'), default: 0.3, min: 0.01, max: 1, step: 0.05 }], defaultDuration: 60 },
    ],
  },
};

export const EDGE_SPECS: ParamSpec[] = [
  { key: 'match', label: L('路由路径前缀', 'Route path prefix'), kind: 'text', default: '', group: 'route', help: L('Gateway 按它把请求路由到这条线。服务的出边设了它，就只有这个路径的请求才会调用（比如单体里只有 /search 请求才调搜索）。留空表示所有路径', 'A Gateway routes requests down this line by it. On a service\u2019s call, only requests on this path make the call (say, a monolith calls search only for /search). Leave empty for every path') },
  { key: 'weight', label: L('分流权重', 'Split weight'), kind: 'number', default: 100, min: 0, max: 100000, step: 5, group: 'route', help: L('多条出边互斥分流时，按权重比例选一条。例如 90 和 10 就是 90% / 10%', 'When several edges share traffic, each request picks one in proportion to these weights, e.g. 90 and 10 give 90% / 10%') },
  { key: 'choice', label: L('互斥分流（按权重选一条）', 'Split traffic (pick one by weight)'), kind: 'bool', default: false, group: 'call', help: L('勾选后，同一调用顺序里所有勾选的出边每次只调用其中一条，按权重分配，适合金丝雀、A/B、多区域。不勾选则全部调用', 'Ticked edges in the same call order share traffic: each request calls just one of them, by weight (canary, A/B, multi-region). Unticked edges are all called') },
  { key: 'order', label: L('调用顺序', 'Call order'), kind: 'int', default: 0, min: 0, max: 20, group: 'call', help: L('顺序号相同的出边并行调用（fan-out），不同的按顺序串行', 'Edges with the same number run in parallel (fan-out); different numbers run in sequence') },
  { key: 'probability', label: L('调用概率', 'Call probability'), kind: 'ratio', default: 1, min: 0, max: 1, step: 0.05, group: 'call', help: L('条件调用：只有这个比例的请求会调用', 'Conditional call: only this share of requests makes it') },
  { key: 'callsPerRequest', label: L('每请求调用次数', 'Calls per request'), kind: 'int', default: 1, min: 1, max: 100, group: 'call', help: L('一个请求内串行调用多次（N+1 查询）', 'Sequential calls within one request (N+1 queries)') },
  { key: 'async', label: L('异步（不等待结果）', 'Async (fire and forget)'), kind: 'bool', default: false, group: 'call' },
  { key: 'network', label: L('网络往返', 'Network round trip'), kind: 'dist', default: ln(0.5, 3), group: 'call' },
  { key: 'timeout', label: L('单次超时', 'Timeout per attempt'), kind: 'ms', default: 1000, min: 1, max: 120000, group: 'retry' },
  { key: 'maxAttempts', label: L('最多尝试次数', 'Max attempts'), kind: 'int', default: 1, min: 1, max: 10, group: 'retry', help: L('1 表示不重试；3 表示最多重试 2 次', '1 means no retries; 3 means up to 2 retries') },
  { key: 'backoffBase', label: L('退避基数', 'Backoff base'), kind: 'ms', default: 50, min: 0, max: 10000, group: 'retry', showIf: (p) => Number(p.maxAttempts) > 1 },
  { key: 'backoffMax', label: L('退避上限', 'Backoff cap'), kind: 'ms', default: 1000, min: 0, max: 60000, group: 'retry', showIf: (p) => Number(p.maxAttempts) > 1 },
  { key: 'jitter', label: L('随机抖动（full jitter）', 'Full jitter'), kind: 'bool', default: true, group: 'retry', showIf: (p) => Number(p.maxAttempts) > 1 },
  { key: 'retryBudget', label: L('重试预算', 'Retry budget'), kind: 'ratio', default: 0, min: 0, max: 1, step: 0.05, group: 'retry', help: L('重试量不超过正常请求的这个比例；0 表示不限制', 'Retries capped at this share of normal requests; 0 means unlimited'), showIf: (p) => Number(p.maxAttempts) > 1 },
  { key: 'cbEnabled', label: L('熔断器', 'Circuit breaker'), kind: 'bool', default: false, group: 'breaker' },
  { key: 'cbThreshold', label: L('失败率阈值', 'Failure-rate threshold'), kind: 'ratio', default: 0.5, min: 0.05, max: 1, step: 0.05, group: 'breaker', showIf: (p) => !!p.cbEnabled },
  { key: 'cbMinRequests', label: L('最少请求数', 'Minimum requests'), kind: 'int', default: 20, min: 1, max: 10000, group: 'breaker', showIf: (p) => !!p.cbEnabled },
  { key: 'cbWindow', label: L('统计窗口', 'Window'), kind: 'seconds', default: 10, min: 1, max: 120, group: 'breaker', showIf: (p) => !!p.cbEnabled },
  { key: 'cbOpen', label: L('打开持续时间', 'Open duration'), kind: 'seconds', default: 15, min: 1, max: 300, group: 'breaker', showIf: (p) => !!p.cbEnabled },
  { key: 'cbFallback', label: L('熔断时', 'When open'), kind: 'enum', default: 'error', group: 'breaker', options: [
    { value: 'error', label: L('直接返回错误', 'Fail fast') }, { value: 'success', label: L('降级返回默认值', 'Return a fallback') },
  ], showIf: (p) => !!p.cbEnabled },
  { key: 'poolSize', label: L('每实例连接池大小', 'Pool size per instance'), kind: 'int', default: 20, min: 0, max: 10000, group: 'pool', help: L('仅对数据库 / 缓存目标生效；缓存回源到数据库时，按调用缓存的那个服务实例计；0 表示不限', 'Only for database and cache targets; for a cache fetching from its database, counted per calling service instance; 0 means unlimited') },
  { key: 'poolTimeout', label: L('获取连接超时', 'Acquire timeout'), kind: 'ms', default: 1000, min: 1, max: 60000, group: 'pool' },
];

export function defaultParams(specs: ParamSpec[]): Params {
  const p: Params = {};
  for (const s of specs) p[s.key] = typeof s.default === 'object' ? { ...(s.default as Dist) } : s.default;
  return p;
}

export function withDefaults(specs: ParamSpec[], params: Params): Params {
  return { ...defaultParams(specs), ...params };
}

export function edgeDefaultsFor(fromType: NodeType, toType: NodeType): Params {
  const p = defaultParams(EDGE_SPECS);
  if (fromType === 'client') p.timeout = 3000;
  if (toType === 'cache') p.timeout = 50;
  if (toType === 'database') p.timeout = 500;
  if (toType === 'external') p.timeout = 3000;
  if (fromType === 'queue') { p.timeout = 10000; p.maxAttempts = 3; }
  return p;
}
