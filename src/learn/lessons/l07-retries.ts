// Lesson 7: timeouts and retries. A dependency that slows down 2.5× still has CPU to spare, yet
// retries at two layers with a tight timeout turn it into a storm; a timeout that fits the
// dependency ends it. When the dependency truly can't cope (3.5×), fewer retries help a little and a
// circuit breaker with a fallback keeps most requests working.
import { blankTopology, newEdge, newNode } from '../../engine/presets';
import { L, type EdgeCfg, type Lang, type NodeCfg, type Topology } from '../../engine/types';
import { fmtAvail, fmtLatency, fmtPct } from '../../ui/format';
import type { BarGroup, Lesson, LessonCtx, Measure, PredictOption } from '../types';
import { reveal, trafficRate } from '../helpers';

const LOAD = 300;
const INSTANCES = 4;
const CLIENT_ATTEMPTS = 2; // the client retries once
const INNER_ATTEMPTS = 3; // Orders retries Catalog twice
const TIGHT = 300; // ms, the starting timeout on Orders → Catalog
const FIT = 1000; // ms, a timeout that fits the slowed-down Catalog
const SLOW = 2.5; // Catalog still has CPU to spare at this factor
const WORSE = 3.5; // and none at this one
const BUDGET = 0.1;

const m = (c: LessonCtx, k: string): Measure | undefined => c.meas[k];
const services = (c: LessonCtx): NodeCfg[] => c.topo.nodes.filter((n) => n.type === 'service').sort((a, b) => a.x - b.x);
const orders = (c: LessonCtx) => services(c)[0];
const catalog = (c: LessonCtx) => services(c)[1];
const edge = (c: LessonCtx, from?: NodeCfg, to?: NodeCfg): EdgeCfg | undefined =>
  from && to ? c.topo.edges.find((e) => e.from === from.id && e.to === to.id) : undefined;
const front = (c: LessonCtx) => edge(c, c.topo.nodes.find((n) => n.type === 'client'), orders(c));
const inner = (c: LessonCtx) => edge(c, orders(c), catalog(c));
const num = (e: EdgeCfg | undefined, k: string, d: number) => Number(e?.params[k] ?? d);
const frontAttempts = (c: LessonCtx) => num(front(c), 'maxAttempts', CLIENT_ATTEMPTS);
const innerAttempts = (c: LessonCtx) => num(inner(c), 'maxAttempts', INNER_ATTEMPTS);
const innerTimeout = (c: LessonCtx) => num(inner(c), 'timeout', TIGHT);
const innerBudget = (c: LessonCtx) => Math.round(num(inner(c), 'retryBudget', 0) * 100) / 100;
const breaker = (c: LessonCtx) => !!inner(c)?.params.cbEnabled;
const fallback = (c: LessonCtx) => inner(c)?.params.cbFallback === 'success';

/** The slowdown on Catalog that is on now, if any. */
const slowFault = (c: LessonCtx) => {
  const k = catalog(c);
  return k ? c.failures.find((x) => x.nodeId === k.id && x.kind === 'slow' && (x.end < 0 || x.end > c.now * 1000)) : undefined;
};
const slowNow = (c: LessonCtx): number => Number(slowFault(c)?.params.multiplier ?? 0);
// the slowdown that set off the storm: the timeout comparison needs a fresh one, because a storm
// that is already raging can keep itself going for a while after the timeout is fixed
let stormFault: string | null = null;
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

const catArr = (mm: Measure | undefined, c: LessonCtx) => { const k = catalog(c); return mm && k ? mm.nodes[k.id]?.arr ?? 0 : 0; };
const catCpu = (mm: Measure | undefined, c: LessonCtx) => { const k = catalog(c); return mm && k ? mm.nodes[k.id]?.cpu ?? 0 : 0; };

const runOrNull = (c: LessonCtx) => (c.running ? null : '[data-learn="run"]');
const nodeField = (c: LessonCtx, n: NodeCfg | undefined, sel: string) =>
  !n ? null : c.selection?.kind === 'node' && c.selection.id === n.id ? `.inspector ${sel}` : `.react-flow__node[data-id="${n.id}"] .sn`;
const edgeField = (c: LessonCtx, e: EdgeCfg | undefined, sel: string) =>
  !e ? null : c.selection?.kind === 'edge' && c.selection.id === e.id ? `.inspector ${sel}` : `.fe-label[data-edge="${e.id}"]`;

const SLOW_OPTIONS: PredictOption[] = [
  // the measured value is availability while Catalog is 2.5× slower
  { label: L('基本正常，商品服务的 CPU 还没满', 'Mostly fine: Catalog still has CPU to spare'), range: [0.99, Infinity] },
  { label: L('慢一些，少量请求失败', 'Slower, with a few failures'), range: [0.8, 0.99] },
  { label: L('大面积失败', 'Widespread failure'), range: [-Infinity, 0.8] },
];
const BUDGET_OPTIONS: PredictOption[] = [
  // the measured value is availability with fewer retries while Catalog is 3.5× slower
  { label: L('能恢复到 90% 以上', 'Back above 90%'), range: [0.9, Infinity] },
  { label: L('好一些，但大部分请求还是失败', 'Better, but most requests still fail'), range: [0.1, 0.9] },
  { label: L('几乎没变化', 'Hardly any change'), range: [-Infinity, 0.1] },
];

function make(lang: Lang): Topology {
  const topo = blankTopology(lang);
  topo.name = L('第 7 课：超时与重试', 'Lesson 7: timeouts and retries')[lang];
  const client = topo.nodes[0];
  client.params = { ...client.params, rps: LOAD };
  const o = newNode('service', client.x + 330, client.y, topo.nodes, lang);
  o.name = L('订单服务', 'Orders')[lang];
  o.params = { ...o.params, instances: INSTANCES, cpuCores: 2 };
  const k = newNode('service', o.x + 330, o.y, [...topo.nodes, o], lang);
  k.name = L('商品服务', 'Catalog')[lang];
  k.params = { ...k.params, instances: INSTANCES, cpuCores: 2 };
  topo.nodes.push(o, k);
  const e1 = newEdge(client, o, topo.edges);
  e1.params = { ...e1.params, maxAttempts: CLIENT_ATTEMPTS };
  topo.edges.push(e1);
  const e2 = newEdge(o, k, topo.edges);
  e2.params = { ...e2.params, timeout: TIGHT, maxAttempts: INNER_ATTEMPTS };
  topo.edges.push(e2);
  return topo;
}

function bars(c: LessonCtx): BarGroup[] {
  const groups: BarGroup[] = [];
  const st = m(c, 'storm'), to = m(c, 'fixto'), w = m(c, 'worse'), b = m(c, 'budget'), br = m(c, 'breaker');
  if (st && to) {
    groups.push({
      title: L(`商品服务慢 ${SLOW} 倍时的可用性`, `Availability with Catalog ${SLOW}× slower`),
      max: 1,
      rows: [
        { label: L(`超时 ${TIGHT}ms`, `Timeout ${TIGHT}ms`), value: st.avail, text: fmtAvail(st.avail), bad: st.avail < 0.99 },
        { label: L(`超时 ${FIT}ms`, `Timeout ${FIT}ms`), value: to.avail, text: fmtAvail(to.avail), bad: to.avail < 0.99 },
      ],
    });
    groups.push({
      title: L('商品服务每秒收到的请求', 'Requests per second reaching Catalog'),
      rows: [
        { label: L('平时', 'Normally'), value: LOAD, text: `${LOAD}/s` },
        { label: L(`超时 ${TIGHT}ms`, `Timeout ${TIGHT}ms`), value: catArr(st, c), text: `${Math.round(catArr(st, c))}/s`, bad: true },
        { label: L(`超时 ${FIT}ms`, `Timeout ${FIT}ms`), value: catArr(to, c), text: `${Math.round(catArr(to, c))}/s` },
      ],
    });
  }
  if (w && b && br) {
    groups.push({
      title: L(`商品服务慢 ${WORSE} 倍时的可用性`, `Availability with Catalog ${WORSE}× slower`),
      max: 1,
      rows: [
        { label: L('两层都重试', 'Retries at both layers'), value: w.avail, text: fmtAvail(w.avail), bad: w.avail < 0.9 },
        { label: L('少重试 + 预算', 'Fewer retries + budget'), value: b.avail, text: fmtAvail(b.avail), bad: b.avail < 0.9 },
        { label: L('再加熔断降级', 'Plus breaker + fallback'), value: br.avail, text: fmtAvail(br.avail), bad: br.avail < 0.9 },
      ],
    });
  }
  // while working through the lesson, show the latest comparison; at the end, all of them
  if (br) return groups;
  return groups.slice(0, 2);
}

export const lesson07: Lesson = {
  id: 'l07-retries',
  num: 7,
  title: L('超时与重试', 'Timeouts and retries'),
  summary: L('下游慢一点，两层重试加上太短的超时就能掀起重试风暴；超时要配得上下游，下游真扛不住时靠熔断降级。', 'A little slowness downstream, retries at two layers and a timeout that is too short add up to a retry storm; fit the timeout to the dependency, and when it truly can\'t cope, break the circuit and fall back.'),
  minutes: 14,
  speed: 5,
  make,
  bars,
  steps: [
    {
      id: 'predict-slow',
      kind: 'predict',
      title: L('先预测', 'Predict first'),
      body: L(
        `起点：每秒 ${LOAD} 个请求 → 订单服务 → 商品服务，各 ${INSTANCES} 个实例 × 2 核。调用都设了重试，这在线上很常见：\n\n• 用户流量 → 订单服务：最多尝试 ${CLIENT_ATTEMPTS} 次（失败重试 1 次）\n• 订单服务 → 商品服务：单次超时 ${TIGHT}ms，最多尝试 ${INNER_ATTEMPTS} 次（重试 2 次）\n\n平时商品服务的 CPU 只有 35% 左右。假设它的一个依赖退化，处理变慢 ${SLOW} 倍，CPU 会升到 90% 左右，但还没满。系统会怎样？`,
        `The start: ${LOAD} requests a second → Orders → Catalog, each ${INSTANCES} instances × 2 cores. The calls retry, as they often do in production:\n\n• Traffic → Orders: up to ${CLIENT_ATTEMPTS} attempts (one retry)\n• Orders → Catalog: ${TIGHT}ms timeout per attempt, up to ${INNER_ATTEMPTS} attempts (two retries)\n\nNormally Catalog's CPU is around 35%. Say one of its dependencies degrades and it gets ${SLOW}× slower: its CPU would rise to around 90%, high but not full. What happens to the system?`,
      ),
      options: SLOW_OPTIONS,
    },
    {
      id: 'base',
      kind: 'do',
      title: L('先看平时', 'A normal day first'),
      body: L('点"运行"，观察 15 秒。', 'Press Run and watch for 15 seconds.'),
      highlight: runOrNull,
      check: (c) => trafficRate(c) === LOAD && slowNow(c) === 0 && innerTimeout(c) === TIGHT && innerAttempts(c) === INNER_ATTEMPTS && frontAttempts(c) === CLIENT_ATTEMPTS,
      hold: 15,
      settle: 3,
      measure: 'base',
      feedback: (c) => {
        const b = m(c, 'base');
        if (!b) return L('', '');
        return {
          zh: `可用性 ${fmtAvail(b.avail)}，p95 ${fmtLatency(b.p95)}。商品服务每秒收到 ${Math.round(catArr(b, c))} 个请求，CPU ${fmtPct(catCpu(b, c))}。重试一次都没触发。`,
          en: `Availability ${fmtAvail(b.avail)}, p95 ${fmtLatency(b.p95)}. Catalog gets ${Math.round(catArr(b, c))} requests a second at ${fmtPct(catCpu(b, c))} CPU. Not a single retry yet.`,
        };
      },
    },
    {
      id: 'storm',
      kind: 'do',
      title: L('商品服务变慢', 'Catalog slows down'),
      body: L(
        `点击商品服务，在右侧"故障注入"里找到"变慢"：倍数填 ${SLOW}，持续时长填 0（一直生效，直到你手动结束），点"注入"。然后观察 30 秒，留意商品服务每秒收到多少请求。`,
        `Click Catalog and find Slowdown under Fault injection on the right: set the multiplier to ${SLOW} and the duration to 0 (on until you end it), and press Inject. Then watch for 30 seconds; notice how many requests a second reach Catalog.`,
      ),
      highlight: (c) => (slowNow(c) ? runOrNull(c) : nodeField(c, catalog(c), '[data-fault="slow"]')),
      check: (c) => {
        const ok = near(slowNow(c), SLOW) && innerTimeout(c) === TIGHT && innerAttempts(c) === INNER_ATTEMPTS && frontAttempts(c) === CLIENT_ATTEMPTS;
        if (ok) stormFault = slowFault(c)?.id ?? null;
        return ok;
      },
      hold: 30,
      settle: 10,
      measure: 'storm',
      feedback: (c) => {
        const s = m(c, 'storm');
        if (!s) return L('', '');
        const x = catArr(s, c) / LOAD;
        return {
          zh: `可用性 ${fmtAvail(s.avail)}，p95 ${fmtLatency(s.p95)}。${reveal(c, 'predict-slow', s.avail, SLOW_OPTIONS).zh}\n\n用户还是每秒 ${LOAD} 个请求，商品服务却每秒收到 ${Math.round(catArr(s, c))} 个，是平时的 ${x.toFixed(1)} 倍，CPU 打满到 ${fmtPct(catCpu(s, c))}。这就是重试风暴。`,
          en: `Availability ${fmtAvail(s.avail)}, p95 ${fmtLatency(s.p95)}. ${reveal(c, 'predict-slow', s.avail, SLOW_OPTIONS).en}\n\nUsers still send ${LOAD} requests a second, yet Catalog receives ${Math.round(catArr(s, c))}: ${x.toFixed(1)}× normal, its CPU maxed at ${fmtPct(catCpu(s, c))}. This is a retry storm.`,
        };
      },
    },
    {
      id: 'why-storm',
      kind: 'read',
      title: L('风暴是怎么起来的', 'How the storm starts'),
      body: L(
        `商品服务变慢后，它的 p95 升到 250ms 左右，而订单服务只等 ${TIGHT}ms。于是：\n\n• 一部分本来能成功的请求被判超时。可商品服务已经做了这份工作，白做了。\n• 订单服务马上重试，商品服务多了一份工作，变得更慢，更多请求超时，更多重试……这是一个自我加强的循环。\n• 两层重试还会相乘：用户最多发 ${CLIENT_ATTEMPTS} 次，每次订单服务最多试 ${INNER_ATTEMPTS} 次，一个用户请求最坏会变成 ${CLIENT_ATTEMPTS} × ${INNER_ATTEMPTS} = ${CLIENT_ATTEMPTS * INNER_ATTEMPTS} 次商品服务调用。\n\n本来只是"慢一点"，被重试放大成了"全挂"。重试只该对付偶发的、短暂的失败；下游整体变慢时，重试只会火上浇油。\n\n还有一点：风暴一旦起来，就算马上把配置改对，堆积的请求和重试也可能让它自己再维持好一阵。线上处理时通常要先限流或暂时摘掉流量，让系统喘口气。`,
        `Once Catalog slows down, its p95 rises to about 250ms, but Orders only waits ${TIGHT}ms. So:\n\n• Some requests that would have succeeded are declared timed out, even though Catalog already did the work, now wasted.\n• Orders retries at once; Catalog has more work, gets slower, more requests time out, more retries… a loop that feeds itself.\n• Retries at two layers multiply: users try up to ${CLIENT_ATTEMPTS} times, and each time Orders tries up to ${INNER_ATTEMPTS} times, so one user request can become ${CLIENT_ATTEMPTS} × ${INNER_ATTEMPTS} = ${CLIENT_ATTEMPTS * INNER_ATTEMPTS} calls to Catalog.\n\nWhat was only "a bit slower" is amplified into "all down". Retries are for occasional, brief failures; when a dependency is slow across the board, they pour fuel on the fire.\n\nOne more thing: once a storm is raging, even fixing the settings at once may not end it; the piled-up requests and retries can keep it going for a good while. In production you usually shed load or take traffic away first, to let the system breathe.`,
      ),
    },
    {
      id: 'timeout',
      kind: 'do',
      title: L('把超时设得合理', 'A timeout that fits'),
      body: L(
        `为了公平比较，先让系统恢复，再用新的超时重来一遍：\n\n1. 点击商品服务，在"变慢"那一行点"结束"。\n2. 点击订单服务和商品服务之间那条连线上的标签，在右侧"超时与重试"里把"单次超时"改成 ${FIT}ms，其他不动。\n3. 回到商品服务，重新注入同样的变慢（倍数 ${SLOW}，持续时长 0），观察 30 秒。`,
        `For a fair comparison, let the system recover first, then go again with the new timeout:\n\n1. Click Catalog and press End on the Slowdown row.\n2. Click the label on the line between Orders and Catalog, and under Timeouts & retries on the right set Timeout per attempt to ${FIT}ms; leave the rest.\n3. Back on Catalog, inject the same slowdown again (multiplier ${SLOW}, duration 0) and watch for 30 seconds.`,
      ),
      highlight: (c) => {
        const f = slowFault(c);
        if (f && f.id === stormFault) return nodeField(c, catalog(c), '[data-fault="slow"]');
        if (innerTimeout(c) !== FIT) return edgeField(c, inner(c), '[data-param="timeout"]');
        if (!f) return nodeField(c, catalog(c), '[data-fault="slow"]');
        return runOrNull(c);
      },
      check: (c) => near(slowNow(c), SLOW) && slowFault(c)?.id !== stormFault && innerTimeout(c) === FIT && innerAttempts(c) === INNER_ATTEMPTS && frontAttempts(c) === CLIENT_ATTEMPTS,
      hold: 30,
      settle: 10,
      measure: 'fixto',
      feedback: (c) => {
        const s = m(c, 'storm'), f = m(c, 'fixto');
        if (!s || !f) return L('', '');
        return {
          zh: `可用性回到 ${fmtAvail(f.avail)}，p95 ${fmtLatency(f.p95)}（刚才 ${fmtAvail(s.avail)}）。商品服务每秒收到 ${Math.round(catArr(f, c))} 个请求，回到正常，CPU ${fmtPct(catCpu(f, c))}：慢，但扛得住。重试设置一点没改，只是不再被错误地触发。`,
          en: `Availability is back to ${fmtAvail(f.avail)}, p95 ${fmtLatency(f.p95)} (was ${fmtAvail(s.avail)}). Catalog gets ${Math.round(catArr(f, c))} requests a second, back to normal, at ${fmtPct(catCpu(f, c))} CPU: slow, but coping. The retry settings didn't change at all; they just aren't triggered by mistake any more.`,
        };
      },
    },
    {
      id: 'timeout-rules',
      kind: 'read',
      title: L('超时该设多大', 'How long a timeout should be'),
      body: L(
        `超时太短，下游正常的波动就会被当成失败，还会触发重试，就像刚才。\n\n超时太长也有代价。用第 2 课的利特尔定律算：同时卡在订单服务里的请求 = 每秒请求数 × 每个请求等待的时间。下游真的挂了时，超时 10 秒意味着每秒 ${LOAD} 个请求 × 10 秒 = ${LOAD * 10} 个请求同时占着线程等，线程很快耗尽，订单服务自己也跟着挂。\n\n经验做法：\n• 超时略高于下游正常时的 p99（这里平时 p99 几十毫秒，变慢后 300ms 左右，${FIT}ms 有余量）。\n• 每一层的超时都要比上一层短，留出重试的时间；最外层的总时限（截止时间）往下传，快到时限就别再重试了。\n• 重试只放在一层，通常是离失败最近的那一层；其他层不重试。`,
        `Too short a timeout turns normal wobbles downstream into failures, and triggers retries, as you just saw.\n\nToo long has a cost too. By Little's law from lesson 2, requests stuck in Orders = requests per second × how long each waits. If the dependency really dies, a 10-second timeout means ${LOAD} requests a second × 10 seconds = ${LOAD * 10} requests holding threads at once; the threads run out and Orders goes down with it.\n\nRules of thumb:\n• Set the timeout a little above the dependency's normal p99 (here tens of milliseconds normally, about 300ms when slow; ${FIT}ms leaves room).\n• Each layer's timeout is shorter than the one above it, leaving room for a retry; pass the overall deadline down, and stop retrying when it is close.\n• Retry at one layer only, usually the one closest to the failure; the others don't.`,
      ),
    },
    {
      id: 'worse',
      kind: 'do',
      title: L('下游真的扛不住', 'When the dependency truly can\'t cope'),
      body: L(
        `现在让商品服务慢 ${WORSE} 倍：这时它的 CPU 怎么都不够用了，合理的超时也救不了。\n\n点击商品服务，在"变慢"那一行点"结束"，再把倍数改成 ${WORSE}、持续时长 0，重新注入。观察 30 秒。`,
        `Now make Catalog ${WORSE}× slower: at this point it doesn't have the CPU however you set the timeout.\n\nClick Catalog, press End on the Slowdown row, then set the multiplier to ${WORSE} with a duration of 0 and inject it again. Watch for 30 seconds.`,
      ),
      highlight: (c) => (near(slowNow(c), WORSE) ? runOrNull(c) : nodeField(c, catalog(c), '[data-fault="slow"]')),
      check: (c) => near(slowNow(c), WORSE) && innerTimeout(c) === FIT && innerAttempts(c) === INNER_ATTEMPTS && frontAttempts(c) === CLIENT_ATTEMPTS && !breaker(c),
      hold: 30,
      settle: 10,
      measure: 'worse',
      feedback: (c) => {
        const w = m(c, 'worse');
        if (!w) return L('', '');
        return {
          zh: `可用性掉到 ${fmtAvail(w.avail)}，p95 ${fmtLatency(w.p95)}。商品服务 CPU ${fmtPct(catCpu(w, c))}，订单服务的线程也被等待的请求占满了。用户那一层的重试还让订单服务收到双倍的请求。`,
          en: `Availability drops to ${fmtAvail(w.avail)}, p95 ${fmtLatency(w.p95)}. Catalog's CPU is at ${fmtPct(catCpu(w, c))}, and Orders' threads are all taken by requests waiting on it. The retries at the user layer double what Orders receives as well.`,
        };
      },
    },
    {
      id: 'predict-budget',
      kind: 'predict',
      title: L('再预测', 'Predict again'),
      body: L(
        `按上一步的经验收紧重试：用户那一层不再重试，订单服务 → 商品服务加 ${pct(BUDGET)} 的重试预算（重试量最多是正常请求的 ${pct(BUDGET)}）。能救回来吗？`,
        `Tighten the retries as the rules say: no retries at the user layer, and a ${pct(BUDGET)} retry budget on Orders → Catalog (retries at most ${pct(BUDGET)} of normal requests). Will that save it?`,
      ),
      options: BUDGET_OPTIONS,
    },
    {
      id: 'budget',
      kind: 'do',
      title: L('收紧重试', 'Tighten the retries'),
      body: L(
        `点击"用户流量 → 订单服务"连线的标签，把"最多尝试次数"改成 1。再点击"订单服务 → 商品服务"连线的标签，把"重试预算"改成 ${pct(BUDGET)}。观察 30 秒。`,
        `Click the label on the Traffic → Orders line and set Max attempts to 1. Then click the label on the Orders → Catalog line and set Retry budget to ${pct(BUDGET)}. Watch for 30 seconds.`,
      ),
      highlight: (c) => {
        if (frontAttempts(c) !== 1) return edgeField(c, front(c), '[data-param="maxAttempts"]');
        if (innerBudget(c) !== BUDGET) return edgeField(c, inner(c), '[data-param="retryBudget"]');
        return runOrNull(c);
      },
      check: (c) => near(slowNow(c), WORSE) && frontAttempts(c) === 1 && innerBudget(c) === BUDGET && innerTimeout(c) === FIT && !breaker(c),
      hold: 30,
      settle: 10,
      measure: 'budget',
      feedback: (c) => {
        const w = m(c, 'worse'), b = m(c, 'budget');
        if (!w || !b) return L('', '');
        return {
          zh: `可用性 ${fmtAvail(b.avail)}（刚才 ${fmtAvail(w.avail)}）。${reveal(c, 'predict-budget', b.avail, BUDGET_OPTIONS).zh}\n\n重试不再放大负载了，可商品服务本身的处理能力就不够：请求在它那里排长队，等到超时。少重试只是"不添乱"，救不了一个真的扛不住的下游。`,
          en: `Availability ${fmtAvail(b.avail)} (was ${fmtAvail(w.avail)}). ${reveal(c, 'predict-budget', b.avail, BUDGET_OPTIONS).en}\n\nRetries no longer multiply the load, but Catalog simply lacks the capacity: requests queue there until they time out. Fewer retries only stop making it worse; they can't rescue a dependency that truly can't cope.`,
        };
      },
    },
    {
      id: 'breaker',
      kind: 'do',
      title: L('熔断与降级', 'Break the circuit, fall back'),
      body: L(
        `在"订单服务 → 商品服务"连线上打开"熔断器"，"熔断时"选"降级返回默认值"，其余保持默认（10 秒内失败率超过 50% 就熔断 15 秒）。观察 40 秒。\n\n熔断器打开后，订单服务不再调用商品服务，直接返回一个默认结果，比如商品详情页先显示缓存的价格、不显示推荐。过一会儿它会放少量请求去试探，商品服务好了就自动恢复。`,
        `On the Orders → Catalog line, turn on Circuit breaker and set When open to Return a fallback; keep the rest (it opens for 15 seconds once more than 50% fail within 10 seconds). Watch for 40 seconds.\n\nWhile the breaker is open, Orders stops calling Catalog and returns a default result at once, such as a product page with a cached price and no recommendations. After a while it lets a few requests through to probe, and closes again once Catalog is healthy.`,
      ),
      highlight: (c) => {
        if (!breaker(c)) return edgeField(c, inner(c), '[data-param="cbEnabled"]');
        if (!fallback(c)) return edgeField(c, inner(c), '[data-param="cbFallback"]');
        return runOrNull(c);
      },
      check: (c) => near(slowNow(c), WORSE) && breaker(c) && fallback(c) && frontAttempts(c) === 1,
      hold: 40,
      settle: 10,
      measure: 'breaker',
      feedback: (c) => {
        const b = m(c, 'budget'), br = m(c, 'breaker');
        if (!b || !br) return L('', '');
        return {
          zh: `可用性 ${fmtAvail(br.avail)}（刚才 ${fmtAvail(b.avail)}），其中相当一部分是降级返回的默认结果。商品服务每秒只收到 ${Math.round(catArr(br, c))} 个请求，CPU 降到 ${fmtPct(catCpu(br, c))}，有了喘息的空间；订单服务的线程也不再被卡住。底部"事件"里能看到熔断器打开、半开、关闭的过程。\n\n剩下的失败发生在熔断器打开之前，以及半开试探的时候。降级的结果不完美，但"能用、少了点东西"远好过"整个页面报错"。`,
          en: `Availability ${fmtAvail(br.avail)} (was ${fmtAvail(b.avail)}), a good part of it fallback results. Catalog now gets only ${Math.round(catArr(br, c))} requests a second, its CPU down to ${fmtPct(catCpu(br, c))}: room to breathe. Orders' threads aren't stuck any more either. The Events tab shows the breaker opening, half-opening and closing.\n\nThe remaining failures happen before the breaker opens and while it probes. A fallback isn't perfect, but "works, with something missing" beats "the whole page errors out".`,
        };
      },
    },
    {
      id: 'done',
      kind: 'read',
      title: L('小结', 'Wrap-up'),
      body: L(
        `记住四点：\n\n• 重试会放大负载，而且层层相乘。只在一层重试，用指数退避和随机抖动把重试错开，再设重试预算封顶。\n• 超时要配得上下游：略高于它正常时的 p99。太短会把"慢"误判成"失败"，触发风暴；太长会让等待的请求占满线程（利特尔定律）。\n• 下游真的扛不住时，少重试只是不添乱；熔断器快速失败，给下游喘息的时间，再配上降级，让用户还能用。\n• 这些设置平时看不出差别，只有出事时才见分晓，所以值得像今天这样先演练一遍。\n\n别忘了在商品服务上点"结束"，结束这次变慢。`,
        `Four things to remember:\n\n• Retries multiply load, layer upon layer. Retry at one layer, spread retries out with exponential backoff and jitter, and cap them with a retry budget.\n• Fit the timeout to the dependency: a little above its normal p99. Too short turns "slow" into "failed" and sets off a storm; too long lets waiting requests take every thread (Little's law).\n• When the dependency truly can't cope, fewer retries only stop making it worse; a circuit breaker fails fast and gives it room to recover, and a fallback keeps users going.\n• None of these settings show a difference on a normal day, only when something goes wrong, which is why it pays to rehearse it like this.\n\nDon't forget to press End on Catalog's slowdown.`,
      ),
    },
  ],
};

function pct(v: number) {
  return `${Math.round(v * 100)}%`;
}
