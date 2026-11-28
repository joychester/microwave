// Lesson 9: monolith vs microservices. The same shop is built twice side by side, with the same
// traffic and the same 10 cores each, sharing one search provider and one database. Splitting keeps
// one feature's trouble from taking the others down (a slow search provider fills the monolith's
// shared threads, so ordering fails too), but splitting also cuts the capacity into pieces that
// can't lend to each other: when search gets hot, the monolith pools its CPU while the search
// service drowns next to an idle orders service, and holding the load takes more cores split.
import { blankTopology, newEdge, newNode } from '../../engine/presets';
import { L, type EdgeCfg, type Lang, type NodeCfg, type Params, type Topology } from '../../engine/types';
import { fmtAvail, fmtLatency, fmtPct } from '../../ui/format';
import type { BarGroup, Lesson, LessonCtx, Measure, PredictOption, SplitMeasure } from '../types';
import { reveal } from '../helpers';

const RPS = 800; // split 50/50: each architecture gets 400 a second
const MIX = '/search:30,/orders:70';
const HOT = { search: 70, orders: 30 };
const MONO = 5; // × 2 cores
const SEARCH = 3, ORDERS = 2; // × 2 cores: 10 cores, the same as the monolith
const MONO_FIX = 7, SEARCH_FIX = 6; // what each needs to hold the hot mix at about 70% CPU
const THREADS = 40;
const SEARCH_MS = 30, ORDER_MS = 5; // local processing, mostly CPU
const SLOW = 100; // the search provider: about 20ms → about 2s
const CORES = 2;

const svcs = (c: LessonCtx) => c.topo.nodes.filter((n) => n.type === 'service');
const gateway = (c: LessonCtx) => c.topo.nodes.find((n) => n.type === 'gateway');
const provider = (c: LessonCtx) => c.topo.nodes.find((n) => n.type === 'external');
const client = (c: LessonCtx) => c.topo.nodes.find((n) => n.type === 'client');
/** The monolith: the service the traffic source calls directly. */
const mono = (c: LessonCtx): NodeCfg | undefined => {
  const cl = client(c);
  const ids = new Set(c.topo.edges.filter((e) => e.from === cl?.id).map((e) => e.to));
  return svcs(c).find((n) => ids.has(n.id));
};
/** A microservice, by the path prefix the gateway routes to it. */
const micro = (c: LessonCtx, prefix: string): NodeCfg | undefined => {
  const g = gateway(c);
  const e = c.topo.edges.find((x) => x.from === g?.id && String(x.params.match ?? '') === prefix);
  return e ? c.topo.nodes.find((n) => n.id === e.to) : undefined;
};
const searchSvc = (c: LessonCtx) => micro(c, '/search');
const ordersSvc = (c: LessonCtx) => micro(c, '/orders');
const inst = (n?: NodeCfg) => Number(n?.params.instances ?? 0);
/** The traffic source's lines to each architecture. */
const lineTo = (c: LessonCtx, to?: NodeCfg): EdgeCfg | undefined =>
  to ? c.topo.edges.find((e) => e.from === client(c)?.id && e.to === to.id) : undefined;

/** The search share of the request mix, in percent. */
const searchShare = (c: LessonCtx) => {
  const mix = String(client(c)?.params.mix ?? '');
  let s = 0, total = 0;
  for (const part of mix.split(',')) {
    const [p, w] = part.split(':');
    const v = Number(w);
    if (!isFinite(v)) continue;
    total += v;
    if ((p ?? '').trim().startsWith('/search')) s += v;
  }
  return total > 0 ? (s / total) * 100 : NaN;
};
const providerSlow = (c: LessonCtx) => {
  const p = provider(c);
  return p ? c.failures.find((f) => f.nodeId === p.id && f.kind === 'slow' && (f.end < 0 || f.end > c.now * 1000)) : undefined;
};
const baseSetup = (c: LessonCtx) => inst(mono(c)) === MONO && inst(searchSvc(c)) === SEARCH && inst(ordersSvc(c)) === ORDERS;

/** One architecture's result on one path, from a measurement. */
const res = (c: LessonCtx, mm: Measure | undefined, arch: 'mono' | 'micro', path: '/search' | '/orders'): SplitMeasure | undefined => {
  const e = lineTo(c, arch === 'mono' ? mono(c) : gateway(c));
  return mm && e ? mm.split[`${e.id}|${path}`] : undefined;
};
const m = (c: LessonCtx, k: string): Measure | undefined => c.meas[k];

const runOrNull = (c: LessonCtx) => (c.running ? null : '[data-learn="run"]');
const nodeField = (c: LessonCtx, n: NodeCfg | undefined, sel: string) =>
  !n ? null : c.selection?.kind === 'node' && c.selection.id === n.id ? `.inspector ${sel}` : `.react-flow__node[data-id="${n.id}"] .sn`;

const BASE_OPTIONS: PredictOption[] = [
  // the measured value is the microservices' /orders p95 divided by the monolith's
  { label: L('微服务更慢：多了一跳网络', 'Microservices are slower: there is an extra network hop'), range: [1.1, Infinity] },
  { label: L('差不多', 'About the same'), range: [0.8, 1.1] },
  { label: L('微服务更快', 'Microservices are faster'), range: [-Infinity, 0.8] },
];
const SLOW_OPTIONS: PredictOption[] = [
  // the measured value counts which side's ordering suffered: 1 the monolith, 2 the microservices
  { label: L('两边的下单都不受影响', 'Ordering is fine on both sides'), range: [-Infinity, 0.5] },
  { label: L('单体的下单受影响，微服务的不受影响', 'The monolith’s ordering suffers, the microservices’ doesn’t'), range: [0.5, 1.5] },
  { label: L('微服务的下单受影响，单体的不受影响', 'The microservices’ ordering suffers, the monolith’s doesn’t'), range: [1.5, 2.5] },
  { label: L('两边的下单都受影响', 'Ordering suffers on both sides'), range: [2.5, Infinity] },
];
const SURGE_OPTIONS: PredictOption[] = [
  // the measured value is the monolith's search availability minus the microservices'
  { label: L('单体扛得更好', 'The monolith copes better'), range: [0.05, Infinity] },
  { label: L('差不多', 'About the same'), range: [-0.05, 0.05] },
  { label: L('微服务扛得更好', 'The microservices cope better'), range: [-Infinity, -0.05] },
];
const SCALE_OPTIONS: PredictOption[] = [
  // the measured value is the cores added to the microservices minus those added to the monolith
  { label: L('单体要加的更多', 'The monolith needs more'), range: [-Infinity, -0.5] },
  { label: L('一样多', 'The same'), range: [-0.5, 0.5] },
  { label: L('微服务要加的更多', 'The microservices need more'), range: [0.5, Infinity] },
];

const ln = (median: number, p99: number) => ({ dist: 'lognormal' as const, median, p99 });

function make(lang: Lang): Topology {
  const topo = blankTopology(lang);
  topo.name = L('第 9 课：单体与微服务', 'Lesson 9: monolith vs microservices')[lang];
  const cl = topo.nodes[0];
  cl.params = { ...cl.params, rps: RPS, mix: MIX };
  delete cl.params.traffic;
  const x = cl.x, y = cl.y;
  const svc = (name: string, nx: number, ny: number, instances: number, ms: number, pathCost = '') => {
    const n = newNode('service', nx, ny, topo.nodes, lang);
    n.name = name;
    n.params = { ...n.params, instances, cpuCores: CORES, workers: THREADS, serviceTime: ln(ms, ms * 4), cpuFraction: 0.9, ...(pathCost ? { pathCost } : {}) };
    topo.nodes.push(n);
    return n;
  };
  const m1 = svc(L('商城（单体）', 'Shop (monolith)')[lang], x + 340, y - 190, MONO, ORDER_MS, `/search:${SEARCH_MS / ORDER_MS}`);
  const gw = newNode('gateway', x + 340, y + 170, topo.nodes, lang);
  topo.nodes.push(gw);
  const ss = svc(L('搜索服务', 'Search')[lang], x + 660, y + 80, SEARCH, SEARCH_MS);
  const os = svc(L('订单服务', 'Orders')[lang], x + 660, y + 290, ORDERS, ORDER_MS);
  const pv = newNode('external', x + 1000, y - 60, topo.nodes, lang);
  pv.name = L('搜索服务商', 'Search provider')[lang];
  pv.params = { ...pv.params, latency: ln(20, 80), errorRate: 0, quotaRps: 0 };
  topo.nodes.push(pv);
  const db = newNode('database', x + 1000, y + 200, topo.nodes, lang);
  db.name = 'Postgres';
  topo.nodes.push(db);
  const link = (a: NodeCfg, b: NodeCfg, p: Params = {}) => {
    const e = newEdge(a, b, topo.edges);
    e.params = { ...e.params, ...p };
    topo.edges.push(e);
  };
  link(cl, m1, { weight: 50 });
  link(cl, gw, { weight: 50 });
  link(gw, ss, { match: '/search', timeout: 3000 });
  link(gw, os, { match: '/orders', timeout: 3000 });
  link(m1, pv, { match: '/search' });
  link(m1, db, { match: '/orders' });
  link(ss, pv);
  link(os, db);
  return topo;
}

function bars(c: LessonCtx): BarGroup[] {
  const groups: BarGroup[] = [];
  const b = m(c, 'base');
  const bm = res(c, b, 'mono', '/orders'), bu = res(c, b, 'micro', '/orders');
  if (bm && bu) {
    groups.push({
      title: L('平时下单的 p95', 'Ordering p95 on a normal day'),
      rows: [
        { label: L('单体', 'Monolith'), value: bm.p95, text: fmtLatency(bm.p95) },
        { label: L('微服务', 'Microservices'), value: bu.p95, text: fmtLatency(bu.p95) },
      ],
    });
  }
  const s = m(c, 'slow');
  const sm = res(c, s, 'mono', '/orders'), su = res(c, s, 'micro', '/orders');
  if (sm && su) {
    groups.push({
      title: L('搜索服务商变慢时，下单的可用性', 'Ordering availability with a slow search provider'),
      rows: [
        { label: L('单体', 'Monolith'), value: sm.avail, text: fmtAvail(sm.avail), bad: sm.avail < 0.99 },
        { label: L('微服务', 'Microservices'), value: su.avail, text: fmtAvail(su.avail), bad: su.avail < 0.99 },
      ],
    });
  }
  if (m(c, 'scaled')) {
    const a = inst(mono(c)) * CORES, d = (inst(searchSvc(c)) + inst(ordersSvc(c))) * CORES;
    groups.push({
      title: L('扛住热门搜索用的核数', 'Cores to hold the search rush'),
      rows: [
        { label: L('单体', 'Monolith'), value: a, text: `${a}` },
        { label: L('微服务（不含 Gateway）', 'Microservices (not counting the gateway)'), value: d, text: `${d}` },
      ],
    });
  }
  return groups;
}

export const lesson09: Lesson = {
  id: 'l09-monolith',
  num: 9,
  title: L('单体与微服务', 'Monolith vs microservices'),
  summary: L('拆分能把故障关在一个服务里，却也把容量切成了借不动的小块。', 'Splitting keeps a failure inside one service, but also cuts capacity into pieces that can’t lend to each other.'),
  minutes: 15,
  speed: 5,
  make,
  bars,
  steps: [
    {
      id: 'tour',
      kind: 'read',
      title: L('同一个商城，两种架构', 'One shop, built two ways'),
      body: L(
        `前 8 课都默认系统已经拆成了微服务。这一课退一步：同一个商城，用两种架构各建一遍，并排放在画布上。\n\n• **单体**（上面）：一个"商城"服务包含所有功能，${MONO} 个实例 × ${CORES} 核。搜索请求在进程里调搜索模块，下单请求调订单模块，模块之间是函数调用。\n• **微服务**（下面）：API Gateway 按路径把 /search 交给"搜索服务"（${SEARCH} × ${CORES} 核），把 /orders 交给"订单服务"（${ORDERS} × ${CORES} 核），各自独立部署。\n\n两边的功能一样，总核数也一样，都是 10 核。"用户流量"每秒 ${RPS} 个请求，一半给单体，一半给微服务，所以两边看到的流量完全一样：30% 是搜索，70% 是下单。搜索比下单重得多：每次搜索约 ${SEARCH_MS}ms CPU，下单约 ${ORDER_MS}ms。\n\n右边的"搜索服务商"和 Postgres 两边共用。这样注入一次故障，两边同时受到影响，正好对比。`,
        `The first 8 lessons all assumed a system already split into microservices. This one steps back: the same shop, built both ways, side by side on the canvas.\n\n• **Monolith** (top): one "Shop" service holds every feature, ${MONO} instances × ${CORES} cores. A search request calls the search module in-process, an order calls the orders module: plain function calls.\n• **Microservices** (bottom): an API Gateway sends /search to a Search service (${SEARCH} × ${CORES} cores) and /orders to an Orders service (${ORDERS} × ${CORES} cores), each deployed on its own.\n\nThe features are the same, and so are the cores: 10 each. The traffic source sends ${RPS} requests a second, half to each, so both see exactly the same traffic: 30% searches, 70% orders. A search is much heavier than an order: about ${SEARCH_MS}ms of CPU against about ${ORDER_MS}ms.\n\nThe search provider and Postgres on the right are shared, so one injected fault hits both sides at once, ready to compare.`,
      ),
    },
    {
      id: 'predict-base',
      kind: 'predict',
      title: L('先预测', 'Predict first'),
      body: L(
        '微服务这边，每个请求要多经过一跳 Gateway 和一次网络调用。平时，微服务的下单（/orders）p95 和单体比会怎样？',
        'On the microservices side every request takes an extra hop through the gateway and over the network. On a normal day, how does ordering (/orders) p95 compare with the monolith?',
      ),
      options: BASE_OPTIONS,
    },
    {
      id: 'base',
      kind: 'do',
      title: L('平时', 'A normal day'),
      body: L('点"运行"，观察 20 秒。', 'Press Run and watch for 20 seconds.'),
      highlight: runOrNull,
      check: (c) => baseSetup(c) && Math.abs(searchShare(c) - 30) < 1 && !providerSlow(c),
      hold: 20,
      settle: 5,
      measure: 'base',
      feedback: (c) => {
        const b = m(c, 'base');
        const so = res(c, b, 'mono', '/search'), su = res(c, b, 'micro', '/search');
        const oo = res(c, b, 'mono', '/orders'), ou = res(c, b, 'micro', '/orders');
        if (!so || !su || !oo || !ou) return L('', '');
        const r = reveal(c, 'predict-base', ou.p95 / Math.max(1, oo.p95), BASE_OPTIONS);
        return {
          zh: `p95：\n\n• 搜索：单体 ${fmtLatency(so.p95)}，微服务 ${fmtLatency(su.p95)}。微服务多了一跳网络，确实慢一点。\n• 下单：单体 ${fmtLatency(oo.p95)}，微服务 ${fmtLatency(ou.p95)}。\n\n${r.zh}\n\n下单在微服务里反而更快。原因是**在单体里，轻的下单请求要和重的搜索请求抢同一批 CPU**：一个下单只要 ${ORDER_MS}ms，却常常排在几个 ${SEARCH_MS}ms 的搜索后面等核。拆开以后，下单有自己的 CPU，不再被搜索拖累。网络那一跳只多了几毫秒。`,
          en: `p95:\n\n• Search: monolith ${fmtLatency(so.p95)}, microservices ${fmtLatency(su.p95)}. The extra network hop does cost a little.\n• Ordering: monolith ${fmtLatency(oo.p95)}, microservices ${fmtLatency(ou.p95)}.\n\n${r.en}\n\nOrdering is actually faster split. **In the monolith, light orders compete with heavy searches for the same CPU**: an order needs just ${ORDER_MS}ms but often waits behind a few ${SEARCH_MS}ms searches for a core. Split, orders have their own CPU and searches no longer hold them up. The network hop adds only a few milliseconds.`,
        };
      },
    },
    {
      id: 'what',
      kind: 'read',
      title: L('两种架构各想解决什么', 'What each one is for'),
      body: L(
        `**单体**：所有功能在一个进程里，一起构建、一起部署。\n• 好处：开发和部署都简单；模块之间是函数调用，又快又不会"网络超时"；一个数据库事务就能保证数据一致；出了问题只看一个地方。\n• 难处：代码和团队变大以后，任何改动都要整体重新部署，大家互相等；一个模块出问题，整个进程跟着受影响；只能整体扩容。\n\n**微服务**：按业务拆成多个服务，每个独立部署、独立扩缩容，通过网络调用。\n• 想解决的问题：团队各自独立开发和发布，互不阻塞；**故障隔离**，一个服务挂了不连累别的；**按需扩展**，哪个服务热就只扩哪个；每个服务可以用最合适的技术和机器规格。\n• 代价下面再讲。\n\n接下来两个实验，各看一个方面：先看故障隔离，再看扩展。`,
        `**Monolith**: every feature in one process, built and deployed together.\n• Strengths: simple to build and deploy; modules call each other as functions, fast and never "timing out over the network"; one database transaction keeps data consistent; when something breaks there is one place to look.\n• Struggles: as the code and the team grow, every change means redeploying the whole thing and people wait on each other; trouble in one module affects the whole process; it can only scale as a whole.\n\n**Microservices**: split by business area into services, each deployed and scaled on its own, calling each other over the network.\n• What they set out to solve: teams build and release independently without blocking each other; **fault isolation**, so one service failing doesn't drag the rest down; **scaling what is hot**, only that service; each service can use the technology and machine size that suits it.\n• The costs come later.\n\nThe next two experiments look at one side each: first fault isolation, then scaling.`,
      ),
    },
    {
      id: 'predict-slow',
      kind: 'predict',
      title: L('再预测', 'Predict again'),
      body: L(
        `现在让搜索服务商卡住：每次搜索要等 2 秒左右（平时约 20ms）。下单根本不调用搜索服务商。两边的下单会怎样？`,
        `Now the search provider stalls: each search waits about 2 seconds (normally about 20ms). Ordering never calls the search provider. What happens to ordering on each side?`,
      ),
      options: SLOW_OPTIONS,
    },
    {
      id: 'slow',
      kind: 'do',
      title: L('搜索服务商变慢', 'The search provider slows down'),
      body: L(
        `点击"搜索服务商"，在右侧"故障注入"里找到"对方变慢"：倍数填 ${SLOW}，持续时长填 0（一直生效，直到你手动结束），点"注入"。观察 30 秒。`,
        `Click the search provider, find Provider slowdown under Fault injection on the right, set the multiplier to ${SLOW} and the duration to 0 (until you end it), and press Inject. Watch for 30 seconds.`,
      ),
      highlight: (c) => (providerSlow(c) ? runOrNull(c) : nodeField(c, provider(c), '[data-fault="slow"]')),
      check: (c) => {
        const f = providerSlow(c);
        return baseSetup(c) && Math.abs(searchShare(c) - 30) < 1 && !!f && (f.params.multiplier ?? 0) >= SLOW / 2 && !!m(c, 'base');
      },
      hold: 30,
      settle: 10,
      measure: 'slow',
      feedback: (c) => {
        const s = m(c, 'slow');
        const so = res(c, s, 'mono', '/search'), su = res(c, s, 'micro', '/search');
        const oo = res(c, s, 'mono', '/orders'), ou = res(c, s, 'micro', '/orders');
        if (!so || !su || !oo || !ou) return L('', '');
        const hurt = (oo.avail < 0.98 ? 1 : 0) + (ou.avail < 0.98 ? 2 : 0);
        const r = reveal(c, 'predict-slow', hurt, SLOW_OPTIONS);
        return {
          zh: `可用性：\n\n• 单体：搜索 ${fmtAvail(so.avail)}，**下单 ${fmtAvail(oo.avail)}**，下单 p95 ${fmtLatency(oo.p95)}。\n• 微服务：搜索 ${fmtAvail(su.avail)}，**下单 ${fmtAvail(ou.avail)}**，下单 p95 ${fmtLatency(ou.p95)}。\n\n${r.zh}\n\n下单明明不调用搜索服务商，单体里的下单却也失败了。单体的 ${MONO * THREADS} 个线程是所有功能共用的：每秒上百个搜索请求，每个都占着线程等 2 秒，线程很快被占满，下单请求只能排队、超时。**一个功能的问题，拖垮了整个应用。**\n\n微服务这边，搜索服务只有 ${SEARCH * THREADS} 个线程，挂得比单体的搜索还彻底；但**订单服务有自己的线程，一点没受影响**。`,
          en: `Availability:\n\n• Monolith: search ${fmtAvail(so.avail)}, **ordering ${fmtAvail(oo.avail)}**, ordering p95 ${fmtLatency(oo.p95)}.\n• Microservices: search ${fmtAvail(su.avail)}, **ordering ${fmtAvail(ou.avail)}**, ordering p95 ${fmtLatency(ou.p95)}.\n\n${r.en}\n\nOrdering never calls the search provider, yet in the monolith it failed too. The monolith's ${MONO * THREADS} threads are shared by every feature: over a hundred searches a second, each holding a thread for 2 seconds, soon take them all, and orders queue and time out. **One feature's problem took down the whole application.**\n\nOn the microservices side the search service has only ${SEARCH * THREADS} threads and fails even harder than the monolith's search; but **the orders service has threads of its own and is untouched**.`,
        };
      },
    },
    {
      id: 'blast',
      kind: 'read',
      title: L('爆炸半径', 'Blast radius'),
      body: L(
        `一个故障能波及多大范围，叫**爆炸半径**。单体里所有功能共用线程、内存、CPU 和数据库连接，任何一个功能出事，都可能拖垮全部。微服务把这些资源按服务分开，故障默认就被关在一个服务里。\n\n不过两点要说清楚：\n\n• **单体也能做隔离**：给每个功能单独的线程池（这叫**舱壁**，bulkhead，像船舱的隔板，一个舱进水不会淹整条船），再给调用搜索服务商设合理的超时。只是单体里要自己记得做，微服务是默认就有。\n• **微服务也会连锁故障**：订单服务如果同步调用搜索服务，问题照样会传过去，第 7 课的重试风暴就是这样。隔离要靠超时、熔断和降级一起守住。\n\n先结束这次变慢：点击搜索服务商，在"对方变慢"那一行点"结束"。`,
        `How far one failure spreads is its **blast radius**. In a monolith every feature shares threads, memory, CPU and database connections, so trouble in any one of them can take everything down. Microservices split those resources by service, so by default a failure stays inside one service.\n\nTwo things to be clear about:\n\n• **A monolith can isolate too**: give each feature its own thread pool (a **bulkhead**, like the walls between a ship's compartments, so one flooding doesn't sink the ship), and set a sensible timeout on the search provider. In a monolith you have to remember to do it; microservices have it by default.\n• **Microservices can still cascade**: if Orders called Search synchronously, the trouble would travel along, as in lesson 7's retry storm. Isolation holds only with timeouts, circuit breakers and fallbacks.\n\nNow end the slowdown: click the search provider and press End on the Provider slowdown row.`,
      ),
    },
    {
      id: 'predict-surge',
      kind: 'predict',
      title: L('再预测', 'Predict again'),
      body: L(
        `搞促销，大家都在搜：搜索请求从 30% 涨到 ${HOT.search}%，总流量不变。两边都还是 10 核。哪边扛得更好？`,
        `A sale is on and everyone is searching: searches go from 30% to ${HOT.search}% of the traffic, with the same total. Both sides still have 10 cores. Which copes better?`,
      ),
      options: SURGE_OPTIONS,
    },
    {
      id: 'surge',
      kind: 'do',
      title: L('搜索变热', 'Search gets hot'),
      body: L(
        `确认搜索服务商的变慢已经结束。然后点击"用户流量"，在"请求路径组成"里把 /search 改成 ${HOT.search}%，/orders 改成 ${HOT.orders}%。观察 30 秒。`,
        `Make sure the search provider's slowdown has ended. Then click the traffic source and, under Request path mix, set /search to ${HOT.search}% and /orders to ${HOT.orders}%. Watch for 30 seconds.`,
      ),
      highlight: (c) => (providerSlow(c) ? nodeField(c, provider(c), '[data-fault="slow"]') : Math.abs(searchShare(c) - HOT.search) < 1 ? runOrNull(c) : nodeField(c, client(c), '[data-param="mix"]')),
      check: (c) => baseSetup(c) && Math.abs(searchShare(c) - HOT.search) < 1 && !providerSlow(c) && !!m(c, 'slow'),
      hold: 30,
      settle: 10,
      measure: 'surge',
      feedback: (c) => {
        const s = m(c, 'surge');
        const so = res(c, s, 'mono', '/search'), su = res(c, s, 'micro', '/search');
        const oo = res(c, s, 'mono', '/orders'), ou = res(c, s, 'micro', '/orders');
        const mn = mono(c), os = ordersSvc(c), ss = searchSvc(c);
        if (!s || !so || !su || !oo || !ou || !mn || !os || !ss) return L('', '');
        const r = reveal(c, 'predict-surge', so.avail - su.avail, SURGE_OPTIONS);
        const cpu = (n: NodeCfg) => fmtPct(s.nodes[n.id]?.cpu ?? 0);
        return {
          zh: `• 单体：CPU ${cpu(mn)}。搜索 ${fmtAvail(so.avail)}、p95 ${fmtLatency(so.p95)}；下单 ${fmtAvail(oo.avail)}、p95 ${fmtLatency(oo.p95)}。\n• 微服务：搜索服务 CPU ${cpu(ss)}，搜索只有 ${fmtAvail(su.avail)}、p95 ${fmtLatency(su.p95)}；订单服务 CPU 只有 ${cpu(os)}，下单 p95 ${fmtLatency(ou.p95)}。\n\n${r.zh}\n\n这次单体扛得更好。**单体的 10 核是一个共享的池子**（第 3 课讲过池化），搜索多了，就用上原本下单在用的 CPU：大家都慢一点，但都还能用。微服务把 10 核切成了 6 + 4，**订单服务闲着的核，借不给搜索服务**：搜索服务被压垮，旁边的订单服务却很闲。\n\n反过来看，微服务的下单全程稳稳当当，单体的下单却跟着慢了。拆分保护的是"别的功能不受牵连"，代价是"容量不能互相借用"。`,
          en: `• Monolith: CPU ${cpu(mn)}. Search ${fmtAvail(so.avail)}, p95 ${fmtLatency(so.p95)}; ordering ${fmtAvail(oo.avail)}, p95 ${fmtLatency(oo.p95)}.\n• Microservices: the search service's CPU is ${cpu(ss)}, with search at only ${fmtAvail(su.avail)} and p95 ${fmtLatency(su.p95)}; the orders service's CPU is only ${cpu(os)}, ordering p95 ${fmtLatency(ou.p95)}.\n\n${r.en}\n\nThis time the monolith copes better. **The monolith's 10 cores are one shared pool** (pooling, from lesson 3): with more searches, they use CPU that orders were using. Everyone is a bit slower, but everything works. The microservices cut the 10 cores into 6 + 4, and **the orders service's idle cores can't be lent to search**: the search service is swamped next to an idle orders service.\n\nLooked at the other way, the microservices' ordering stayed rock steady while the monolith's slowed down too. Splitting protects the other features from being dragged in; the price is capacity that can't be shared.`,
        };
      },
    },
    {
      id: 'predict-scale',
      kind: 'predict',
      title: L('再预测', 'Predict again'),
      body: L(
        '现在两边都加机器，让 CPU 回到 70% 左右。哪边要加的核更多？',
        'Now add machines on both sides to bring CPU back to about 70%. Which side needs more cores added?',
      ),
      options: SCALE_OPTIONS,
    },
    {
      id: 'scale',
      kind: 'do',
      title: L('扩容', 'Scale out'),
      body: L(
          `按需要的 CPU 算：搜索每秒 ${(RPS / 2) * HOT.search / 100} 个，每个约 ${SEARCH_MS}ms 多一点，约要 9 核；下单还要 0.6 核左右。\n\n• 单体是一个池子，总共要约 9.6 核，按 70% 算要 14 核：把"商城（单体）"的实例数从 ${MONO} 改成 ${MONO_FIX}（多 ${(MONO_FIX - MONO) * CORES} 核）。\n• 微服务里，订单服务的 4 核帮不上忙，搜索服务自己要约 9 核，按 70% 算要 12 核：把"搜索服务"的实例数从 ${SEARCH} 改成 ${SEARCH_FIX}（多 ${(SEARCH_FIX - SEARCH) * CORES} 核）。\n\n改完观察 30 秒。`,
          `Work it out from the CPU needed: ${(RPS / 2) * HOT.search / 100} searches a second at a little over ${SEARCH_MS}ms each take about 9 cores; orders need about 0.6 more.\n\n• The monolith is one pool needing about 9.6 cores, so 14 cores at 70%: set Shop (monolith) instances from ${MONO} to ${MONO_FIX} (${(MONO_FIX - MONO) * CORES} more cores).\n• In the microservices, the orders service's 4 cores can't help, and the search service alone needs about 9, so 12 at 70%: set Search instances from ${SEARCH} to ${SEARCH_FIX} (${(SEARCH_FIX - SEARCH) * CORES} more cores).\n\nThen watch for 30 seconds.`,
      ),
      highlight: (c) => (inst(mono(c)) !== MONO_FIX ? nodeField(c, mono(c), '[data-param="instances"]') : inst(searchSvc(c)) !== SEARCH_FIX ? nodeField(c, searchSvc(c), '[data-param="instances"]') : runOrNull(c)),
      check: (c) => inst(mono(c)) === MONO_FIX && inst(searchSvc(c)) === SEARCH_FIX && inst(ordersSvc(c)) === ORDERS && Math.abs(searchShare(c) - HOT.search) < 1 && !providerSlow(c) && !!m(c, 'surge'),
      hold: 30,
      // the search service's backlog from the rush needs a moment to clear
      settle: 15,
      measure: 'scaled',
      feedback: (c) => {
        const s = m(c, 'scaled');
        const so = res(c, s, 'mono', '/search'), su = res(c, s, 'micro', '/search');
        const oo = res(c, s, 'mono', '/orders'), ou = res(c, s, 'micro', '/orders');
        if (!so || !su || !oo || !ou) return L('', '');
        const added = (inst(searchSvc(c)) - SEARCH) * CORES - (inst(mono(c)) - MONO) * CORES;
        const r = reveal(c, 'predict-scale', added, SCALE_OPTIONS);
        const a = inst(mono(c)) * CORES, d = (inst(searchSvc(c)) + inst(ordersSvc(c))) * CORES;
        const low = Math.min(so.avail, su.avail, oo.avail, ou.avail);
        return {
          zh: `两边都恢复了：单体搜索 p95 ${fmtLatency(so.p95)}、下单 ${fmtLatency(oo.p95)}；微服务搜索 ${fmtLatency(su.p95)}、下单 ${fmtLatency(ou.p95)}，${low >= 0.9995 ? '可用性都是 100%' : `可用性最低的也有 ${fmtAvail(low)}`}。\n\n${r.zh}\n\n扛同样的流量，单体用 ${a} 核，微服务用 ${d} 核，还没算 Gateway。**拆分本身不省算力，常常还更费**：每个服务各自要留余量，一个服务闲着的核，别的服务用不上。`,
          en: `Both have recovered: monolith search p95 ${fmtLatency(so.p95)}, ordering ${fmtLatency(oo.p95)}; microservices search ${fmtLatency(su.p95)}, ordering ${fmtLatency(ou.p95)}, ${low >= 0.9995 ? 'all at 100% availability' : `with availability no lower than ${fmtAvail(low)}`}.\n\n${r.en}\n\nFor the same traffic, the monolith uses ${a} cores and the microservices ${d}, not counting the gateway. **Splitting doesn't save computing power, and often costs more**: each service keeps its own headroom, and one service's idle cores are no use to another.`,
        };
      },
    },
    {
      id: 'savings',
      kind: 'read',
      title: L('那拆分到底省了什么', 'So what does splitting save?'),
      body: L(
        `不省 CPU 总量，但省了别的东西：\n\n• **只扩热点**：刚才只加了搜索服务，订单服务没动。真实系统里，单体的每个实例都要装下全部代码和内存，启动慢；小服务启动快，扩容更及时（第 6 课的冷启动）。\n• **按需选规格**：搜索吃 CPU，可以用计算优化型机器；别的服务吃内存，就用内存优化型。单体只能选一种，按最挑剔的那个功能来。\n• **发布和回滚的范围小**：改搜索只发布搜索服务，出了问题也只回滚它，不影响下单。\n• **故障被关在一个服务里**：刚才那次变慢，下单毫发无损。\n\n所以拆不拆，不是看"哪个更快、更省"，而是看这些好处值不值得付出下面这些代价。`,
        `Not total CPU, but other things:\n\n• **Scale only what is hot**: you just grew the search service and left orders alone. In real systems every monolith instance carries all the code and memory and starts slowly; small services start fast and scale in time (cold starts, lesson 6).\n• **Pick the right machine**: search eats CPU, so give it compute-optimized machines; a memory-hungry service gets memory-optimized ones. A monolith gets one kind, sized for its most demanding feature.\n• **Smaller releases and rollbacks**: a search change ships only the search service, and if it goes wrong only that rolls back, with ordering unaffected.\n• **Failures stay inside one service**: in the slowdown, ordering came through untouched.\n\nSo the question isn't which is faster or cheaper, but whether these gains are worth the costs below.`,
      ),
    },
    {
      id: 'costs',
      kind: 'read',
      title: L('微服务的代价', 'What microservices cost'),
      body: L(
        `• **网络开销**：每次服务间调用都要序列化、走网络，延迟多几毫秒，还可能超时、失败。\n• **更多故障点**：调用链越长，出问题的地方越多，超时、重试、熔断都要配好（第 4、7 课）。\n• **数据一致性变难**：每个服务有自己的数据库，跨服务没有一个本地事务可用，要靠消息队列、补偿、最终一致（第 8 课）。\n• **运维成本**：几十个服务要各自部署、监控、扩缩容，排查一个请求要靠链路追踪把十几个服务串起来。\n• **组织要匹配**：**康威定律**说，系统的结构会照着组织的沟通结构长。服务边界要和团队边界对得上，否则一个需求要好几个团队一起改，比单体还慢。`,
        `• **Network overhead**: every call between services is serialized and crosses the network, adding milliseconds and the chance of timeouts and failures.\n• **More places to fail**: the longer the call chain, the more can go wrong, and timeouts, retries and circuit breakers must all be set well (lessons 4 and 7).\n• **Consistency gets harder**: each service owns its database, so there is no local transaction across services; you rely on queues, compensation and eventual consistency (lesson 8).\n• **Operations**: dozens of services to deploy, monitor and scale, and following one request means tracing it across a dozen services.\n• **The organization has to fit**: **Conway's law** says a system grows in the shape of the organization's communication. Service boundaries need to match team boundaries, or one feature needs several teams to change it, slower than a monolith.`,
      ),
    },
    {
      id: 'done',
      kind: 'read',
      title: L('小结', 'Wrap-up'),
      body: L(
        `记住四点：\n\n• **拆分换来的是隔离**：故障关在一个服务里，热点可以单独扩，发布互不影响。\n• **拆分的代价是容量和复杂度**：容量切开后不能互借，常常要更多机器；还要付出网络、一致性和运维的代价。\n• **大多数团队可以先做模块化单体**：一个部署单元，但内部按业务划清模块边界，用构建检查守住，还能给关键功能做舱壁隔离。等某个模块真的需要独立扩展、独立发布或故障隔离时，再沿着已有的边界拆出去。\n• **拆的时候按业务边界拆**（订单、搜索、支付），不要按技术分层拆（前端层、逻辑层、数据层）。\n\n最后说一下 AI 编程带来的变化：AI 写代码让改动越来越便宜，而编码代理在一个能整体读懂、能在本地跑起来的代码库里效率最高，这让模块化单体和 monorepo 重新受欢迎。但这一课的实验结果不会因此改变：线程会被占满，故障会扩散，容量切开就不能互借。所以要把"**代码边界**"和"**部署边界**"分开考虑：代码边界对人和 AI 都必须清晰，部署边界只在运行时需求真的不同时才拆。\n\n别忘了把搜索比例和实例数改回来，或者直接重新开始本课。`,
        `Four things to remember:\n\n• **Splitting buys isolation**: failures stay inside one service, hot spots scale on their own, releases don't affect each other.\n• **Splitting costs capacity and complexity**: capacity cut into pieces can't be shared and often needs more machines; then there are the network, consistency and operations costs.\n• **Most teams can start with a modular monolith**: one deployable, with business modules cleanly separated inside and the boundaries enforced by build checks, plus bulkheads for critical features. When a module truly needs to scale, ship or fail on its own, split it out along the boundary that is already there.\n• **Split along business lines** (orders, search, payments), not technical layers (front end, logic, data).\n\nA last note on AI coding: AI makes changing code ever cheaper, and coding agents work best in a codebase they can read as a whole and run locally, which is bringing modular monoliths and monorepos back into favor. None of this changes what these experiments showed: threads still fill up, failures still spread, and split capacity still can't be shared. So treat **code boundaries** and **deployment boundaries** separately: code boundaries must be clear for people and AI alike; split deployments only where runtime needs really differ.\n\nRemember to set the search share and instance counts back, or just restart the lesson.`,
      ),
    },
  ],
};
