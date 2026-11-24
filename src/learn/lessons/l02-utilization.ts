// Lesson 2: queueing and utilization. Turn the traffic up step by step on a single instance,
// watch latency stay flat and then shoot up, explain it with the utilization law, then fix it.
import { blankTopology, newEdge, newNode } from '../../engine/presets';
import { L, type Lang, type Topology } from '../../engine/types';
import { fmtAvail, fmtLatency, fmtPct } from '../../ui/format';
import type { CurvePoint, Lesson, LessonCtx, Measure, PredictOption } from '../types';
import { mainService, reveal, trafficRate } from '../helpers';

const BASE = 100;
const RAMP = [130, 160, 180];
// 220/s is past the service's capacity (about 212/s), so the queue grows every time, not just sometimes
const KNEE = [200, 220];
const LEVELS = [BASE, ...RAMP, ...KNEE];

const rps = trafficRate;
const instances = (c: LessonCtx) => Number(mainService(c)?.params.instances ?? 0);
const at = (c: LessonCtx, v: number): Measure | undefined => c.meas[`r${v}`];
const x = (v: number) => `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}×`;
const clientSelected = (c: LessonCtx) => c.selection?.kind === 'node' && c.selection.id === 'client';
const svcSelected = (c: LessonCtx) => { const s = mainService(c); return !!s && c.selection?.kind === 'node' && c.selection.id === s.id; };
/** CPU milliseconds per request, from the baseline: utilization × cores × instances / rate. */
const cpuMs = (c: LessonCtx) => {
  const m = at(c, BASE);
  const s = mainService(c);
  if (!m || !s || m.rps <= 0) return NaN;
  return (m.cpu * Number(s.params.cpuCores ?? 2) * m.instances * 1000) / m.rps;
};

const DOUBLE_OPTIONS: PredictOption[] = [
  { label: L('基本不变', 'About the same'), range: [0, 1.5] },
  { label: L('大约翻倍', 'About double'), range: [1.5, 2.5] },
  { label: L('远不止翻倍', 'Far more than double'), range: [2.5, Infinity] },
];
const FIX_OPTIONS: PredictOption[] = [
  { label: L('回到和 100/s 时差不多', 'Back to about the 100/s level'), range: [0, 1.6] },
  { label: L('减半，但还是明显偏高', 'Halved, but still clearly high'), range: [1.6, 6] },
  { label: L('几乎没改善', 'Barely better'), range: [6, Infinity] },
];

function make(lang: Lang): Topology {
  const topo = blankTopology(lang);
  topo.name = L('第 2 课：排队与利用率', 'Lesson 2: queueing and utilization')[lang];
  const client = topo.nodes[0];
  client.params = { ...client.params, rps: BASE };
  const svc = newNode('service', client.x + 380, client.y, topo.nodes, lang);
  svc.params = { ...svc.params, instances: 1 };
  topo.nodes.push(svc);
  topo.edges.push(newEdge(client, svc, topo.edges));
  return topo;
}

/** Highlight the client while it isn't selected, then its traffic field. */
const pointAtTraffic = (c: LessonCtx, target: number | undefined) =>
  target === undefined || rps(c) === target ? null
    : clientSelected(c) ? '.inspector [data-param="tm-constant-rps"]'
      : '.react-flow__node[data-id="client"] .sn';

export const lesson02: Lesson = {
  id: 'l02-utilization',
  num: 2,
  title: L('排队与利用率', 'Queueing and utilization'),
  summary: L('一档一档加流量，亲眼看到利用率过了约 80% 后，延迟为什么突然飙升。', 'Turn the traffic up one step at a time and watch why, past about 80% utilization, latency suddenly shoots up.'),
  minutes: 8,
  speed: 5,
  make,
  challenge: 'scale-out',
  curve: (c) => LEVELS.flatMap((v): CurvePoint[] => { const m = at(c, v); return m ? [{ x: v, y: m.avg, cpu: m.cpu }] : []; }),
  steps: [
    {
      id: 'predict-double',
      kind: 'predict',
      title: L('先预测', 'Predict first'),
      body: L(
        '起点已经搭好："用户流量"每秒发 100 个请求，交给一个微服务处理。这个微服务只有 1 个实例、2 个核。\n\n先猜一下：如果流量翻倍到每秒 200 个，平均延迟会变成现在的几倍？',
        'The starting point is ready: the traffic source sends 100 requests a second to a service with just 1 instance and 2 cores.\n\nGuess first: if traffic doubles to 200 a second, how many times today\'s average latency will it be?',
      ),
      options: DOUBLE_OPTIONS,
    },
    {
      id: 'baseline',
      kind: 'do',
      title: L('测一个基线', 'Measure a baseline'),
      body: L(
        '点"运行"，在每秒 100 个请求下跑 20 秒，作为对比的基线。',
        'Press Run and let it run for 20 seconds at 100 requests a second. This is the baseline to compare against.',
      ),
      highlight: (c) => (c.running ? null : '[data-learn="run"]'),
      check: (c) => rps(c) === BASE && !!mainService(c),
      hold: 20,
      settle: 5,
      measure: `r${BASE}`,
      feedback: (c) => {
        const m = at(c, BASE);
        if (!m) return L('', '');
        return {
          zh: `基线：平均 ${fmtLatency(m.avg)}，p95 ${fmtLatency(m.p95)}，CPU ${fmtPct(m.cpu)}。CPU 还不到一半，看起来很宽裕。`,
          en: `Baseline: average ${fmtLatency(m.avg)}, p95 ${fmtLatency(m.p95)}, CPU ${fmtPct(m.cpu)}. CPU is under half, so there seems to be plenty of room.`,
        };
      },
    },
    {
      id: 'ramp',
      kind: 'do',
      title: L('一档一档加压', 'Turn it up step by step'),
      body: (c) => {
        const next = RAMP.find((v) => !at(c, v));
        const done = RAMP.filter((v) => at(c, v)).length;
        return {
          zh: `点击"用户流量"，在右侧"流量模型"里把"流量"改成 ${next ?? RAMP[RAMP.length - 1]}。保持运行，每档观察 20 秒，测完会提示下一档。依次是 ${RAMP.join('、')}（已完成 ${done} / ${RAMP.length}）。\n\n下面的曲线会随着你的测量逐点长出来。`,
          en: `Click the traffic source and, under Traffic model on the right, set Rate to ${next ?? RAMP[RAMP.length - 1]}. Keep it running; each level is watched for 20 seconds, then you are told the next. The levels are ${RAMP.join(', ')} (${done} of ${RAMP.length} done).\n\nThe chart below grows a point for each level you measure.`,
        };
      },
      highlight: (c) => pointAtTraffic(c, RAMP.find((v) => !at(c, v))),
      check: (c) => !!mainService(c),
      sweep: { values: RAMP, key: 'r', value: rps },
      hold: 20,
      settle: 5,
      feedback: (c) => {
        const base = at(c, BASE), b = at(c, 160), d = at(c, 180);
        if (!base || !b || !d) return L('', '');
        return {
          zh: `到 160/s 时，CPU 已经 ${fmtPct(b.cpu)}，平均延迟 ${fmtLatency(b.avg)}，和基线 ${fmtLatency(base.avg)} 相比变化不大。再加到 180/s，流量只多了约 12%，平均延迟却变成 ${fmtLatency(d.avg)}。曲线开始往上翘了。`,
          en: `At 160/s CPU is already ${fmtPct(b.cpu)} and average latency is ${fmtLatency(b.avg)}, not far from the ${fmtLatency(base.avg)} baseline. At 180/s, about 12% more traffic, the average is ${fmtLatency(d.avg)}. The curve has started to bend upward.`,
        };
      },
    },
    {
      id: 'knee',
      kind: 'do',
      title: L('越过拐点', 'Cross the knee'),
      body: (c) => {
        const next = KNEE.find((v) => !at(c, v));
        return {
          zh: `继续：把"流量"改成 ${next ?? KNEE[KNEE.length - 1]}。先测 200，再测 220，这两档各观察 30 秒。`,
          en: `Keep going: set Rate to ${next ?? KNEE[KNEE.length - 1]}. First 200, then 220, 30 seconds each.`,
        };
      },
      highlight: (c) => pointAtTraffic(c, KNEE.find((v) => !at(c, v))),
      check: (c) => !!mainService(c),
      sweep: { values: KNEE, key: 'r', value: rps },
      // near saturation latency swings a lot; a longer window keeps the result steady
      hold: 30,
      settle: 8,
      feedback: (c) => {
        const base = at(c, BASE), a = at(c, 200), b = at(c, 220);
        if (!base || !a || !b) return L('', '');
        const k = a.avg / base.avg;
        const errs = b.avail < 0.995;
        return {
          zh: `200/s 时，平均延迟 ${fmtLatency(a.avg)}，是基线的 ${x(k)}。${reveal(c, 'predict-double', k, DOUBLE_OPTIONS).zh}\n\n再看 220/s：流量只多了 10%，平均延迟却从 ${fmtLatency(a.avg)} 涨到 ${fmtLatency(b.avg)}。CPU 已经 ${fmtPct(b.cpu)}：来的请求比处理得了的多，多出来的只能排队，队伍越排越长。${errs ? `队列排满后，新请求直接被拒绝，可用性掉到了 ${fmtAvail(b.avail)}。` : ''}`,
          en: `At 200/s the average is ${fmtLatency(a.avg)}, ${x(k)} the baseline. ${reveal(c, 'predict-double', k, DOUBLE_OPTIONS).en}\n\nNow 220/s: only 10% more traffic, but the average went from ${fmtLatency(a.avg)} to ${fmtLatency(b.avg)}. CPU is at ${fmtPct(b.cpu)}: more requests arrive than it can handle, so the extra ones queue and the queue keeps growing.${errs ? ` Once the queue is full, new requests are turned away; availability fell to ${fmtAvail(b.avail)}.` : ''}`,
        };
      },
    },
    {
      id: 'explain',
      kind: 'read',
      title: L('为什么会这样', 'Why this happens'),
      body: (c) => {
        const ms = cpuMs(c);
        const ok = isFinite(ms);
        const u200 = ok ? (200 * ms) / 2000 : NaN;
        return {
          zh: `两条规律就能解释。\n\n第一条是利用率定律：利用率 = 流量 × 每个请求占用的 CPU 时间 ÷ 核数。${ok ? `从你的基线算，每个请求约占 ${ms.toFixed(1)}ms CPU，所以 200/s 时利用率约 200 × ${ms.toFixed(1)}ms ÷ 2 核 ≈ ${fmtPct(u200)}。` : ''}\n\n第二条是排队：请求是随机到达的，就算平均够用，也常常几个请求同时挤进来，后来的只能等。利用率越高，撞车越频繁，等待时间大致按 1 ÷ (1 − 利用率) 增长：\n\n• 50% 时约 2 倍\n• 80% 时约 5 倍\n• 90% 时约 10 倍\n• 95% 时约 20 倍\n\n这就是曲线前面平、后面陡的原因：从 50% 到 80% 只多等一点，从 90% 到 95% 等待却直接翻倍。`,
          en: `Two rules explain it.\n\nThe first is the utilization law: utilization = traffic × CPU time per request ÷ cores. ${ok ? `From your baseline each request uses about ${ms.toFixed(1)}ms of CPU, so at 200/s utilization is about 200 × ${ms.toFixed(1)}ms ÷ 2 cores ≈ ${fmtPct(u200)}.` : ''}\n\nThe second is queueing: requests arrive at random, so even when capacity is enough on average, several often arrive together and the later ones wait. The higher the utilization, the more often that happens; waiting grows roughly as 1 ÷ (1 − utilization):\n\n• about 2× at 50%\n• about 5× at 80%\n• about 10× at 90%\n• about 20× at 95%\n\nThat is why the curve is flat first and steep later: going from 50% to 80% adds a little waiting, but going from 90% to 95% doubles it.`,
        };
      },
    },
    {
      id: 'little',
      kind: 'read',
      title: L('利特尔定律', "Little's law"),
      body: (c) => {
        const s = mainService(c);
        const threads = Number(s?.params.workers ?? 50) * Math.max(1, instances(c));
        // the service's own time per request (W) and how busy its threads were, at two levels
        const pt = (v: number) => {
          const m = at(c, v);
          const n = m && s ? m.nodes[s.id] : undefined;
          if (!m || !n || !(n.lat > 0)) return null;
          return { rate: v, w: n.lat, l: (v * n.lat) / 1000, busy: n.util };
        };
        const lo = pt(BASE), hi = pt(200);
        const f = (v: number) => v.toFixed(1);
        const zhNums = lo
          ? `\n\n用你测到的数字算一下。${BASE}/s 时，每个请求在服务里平均待 ${f(lo.w)}ms，所以 L = ${BASE} × ${f(lo.w)}ms ≈ ${f(lo.l)}：平均同时有约 ${f(lo.l)} 个请求在服务里。每个请求占一个线程，这个实例有 ${threads} 个线程，平均应该有约 ${f(lo.l)} 个线程在忙；实测线程占用 ${(lo.busy * 100).toFixed(1)}%，也就是 ${threads} × ${(lo.busy * 100).toFixed(1)}% ≈ ${f(lo.busy * threads)} 个，对得上。${hi ? `\n\n200/s 时，每个请求平均待 ${f(hi.w)}ms，L = 200 × ${f(hi.w)}ms ≈ ${f(hi.l)}。流量只翻了一倍，同时在服务里的请求却是 ${f(hi.l / lo.l)} 倍：多出来的都是在排队等 CPU 的。` : ''}`
          : '';
        const enNums = lo
          ? `\n\nTry it with your own numbers. At ${BASE}/s each request spends ${f(lo.w)}ms in the service on average, so L = ${BASE} × ${f(lo.w)}ms ≈ ${f(lo.l)}: about ${f(lo.l)} requests are in the service at any moment. Each holds a thread, and this instance has ${threads}, so about ${f(lo.l)} threads should be busy on average; you measured ${(lo.busy * 100).toFixed(1)}% of them busy, ${threads} × ${(lo.busy * 100).toFixed(1)}% ≈ ${f(lo.busy * threads)}, a match.${hi ? `\n\nAt 200/s each request spends ${f(hi.w)}ms, so L = 200 × ${f(hi.w)}ms ≈ ${f(hi.l)}. Traffic only doubled, yet ${f(hi.l / lo.l)}× as many requests are in the service at once: the extra ones are waiting for CPU.` : ''}`
          : '';
        return {
          zh: `排队论里还有一条最常用的规律，叫利特尔定律（Little's law）：\n\nL = λ × W\n\n• L：系统里平均同时有多少个请求（正在处理的 + 正在排队的）\n• λ：每秒到达多少个请求\n• W：每个请求在系统里平均待多久（换成秒）${zhNums}\n\n它几乎不需要前提：不管请求怎么到达、处理时间怎么分布，只要系统稳定（长期看进来多少就出去多少）就成立。220/s 超过了上限，进来的比出去的多，队伍一直变长，所以那一档的延迟一直在涨，算不出一个稳定的平均值。\n\n"系统"可以随便划：整个服务、一个线程池、一个连接池、一个队列都行。所以它到处有用：\n\n• 池子要开多大：连接数 ≈ 每秒查询数 × 每次查询时间（第 4 课会用到）\n• 从积压算等待：队列里积压 6000 条、每秒处理 200 条，新消息大约要等 30 秒\n• 从并发上限算吞吐上限：50 个线程、每个请求 100ms，最多每秒处理 500 个`,
          en: `Queueing theory has one more rule you will use all the time, Little's law:\n\nL = λ × W\n\n• L: how many requests are in the system on average (being served plus waiting)\n• λ: how many requests arrive per second\n• W: how long each request spends in the system on average (in seconds)${enNums}\n\nIt needs almost no assumptions: however requests arrive and however long they take, it holds as long as the system is stable (in the long run, as many leave as arrive). 220/s is past the limit, more arrive than leave and the line keeps growing, which is why latency kept rising at that level and has no steady average.\n\nThe "system" can be anything you draw a box around: a whole service, a thread pool, a connection pool, a queue. So it is useful everywhere:\n\n• Sizing a pool: connections ≈ queries per second × time per query (you will use this in lesson 4)\n• Waiting from a backlog: 6,000 messages queued and 200 handled a second means a new one waits about 30 seconds\n• Throughput from a concurrency limit: 50 threads at 100ms per request handle at most 500 requests a second`,
        };
      },
    },
    {
      id: 'predict-fix',
      kind: 'predict',
      title: L('预测修复效果', 'Predict the fix'),
      body: L(
        '流量保持 220/s，把实例从 1 个加到 2 个，容量翻倍。你觉得平均延迟会怎样？',
        'Keep traffic at 220/s and add a second instance, doubling capacity. What will happen to average latency?',
      ),
      options: FIX_OPTIONS,
    },
    {
      id: 'fix',
      kind: 'do',
      title: L('修复', 'Fix it'),
      body: L(
        '点击微服务，在"容量"分组里把"实例数"改成 2。流量保持 220，观察 20 秒（前几秒在消化积压的队列）。',
        'Click the service and set Instances to 2 in the Capacity group. Keep traffic at 220 and watch for 20 seconds (the first few seconds clear the backlog).',
      ),
      highlight: (c) => (instances(c) >= 2 ? null : svcSelected(c) ? '.inspector [data-param="instances"]' : (() => { const s = mainService(c); return s ? `.react-flow__node[data-id="${s.id}"] .sn` : null; })()),
      check: (c) => instances(c) >= 2 && rps(c) >= 220,
      hold: 20,
      settle: 8,
      measure: 'fix',
      feedback: (c) => {
        const base = at(c, BASE), hot = at(c, 220), f = c.meas.fix;
        if (!base || !hot || !f) return L('', '');
        const k = f.avg / base.avg;
        return {
          zh: `CPU 从 ${fmtPct(hot.cpu)} 降到 ${fmtPct(f.cpu)}，平均延迟从 ${fmtLatency(hot.avg)} 回到 ${fmtLatency(f.avg)}，可用性 ${fmtAvail(f.avail)}。${reveal(c, 'predict-fix', k, FIX_OPTIONS).zh}\n\n容量只翻了一倍，延迟却降到几分之一：利用率回到了曲线平坦的那一段。`,
          en: `CPU fell from ${fmtPct(hot.cpu)} to ${fmtPct(f.cpu)} and average latency from ${fmtLatency(hot.avg)} back to ${fmtLatency(f.avg)}, availability ${fmtAvail(f.avail)}. ${reveal(c, 'predict-fix', k, FIX_OPTIONS).en}\n\nCapacity only doubled, yet latency dropped to a fraction: utilization is back on the flat part of the curve.`,
        };
      },
    },
    {
      id: 'capacity',
      kind: 'do',
      title: L('对照容量分析', 'Check the capacity view'),
      body: L(
        '打开底部的"容量分析"标签。它不跑仿真，直接用刚才的利用率定律估算每个组件。看看它算出的微服务利用率，和仿真测到的 CPU 是否对得上。',
        'Open the Capacity tab at the bottom. It doesn\'t simulate; it estimates each component with the utilization law you just used. See whether its estimate for the service matches the CPU the simulation measured.',
      ),
      highlight: '[data-learn="dock-capacity"]',
      check: (c) => c.dockOpen && c.dockTab === 'capacity',
      feedback: (c) => {
        const f = c.meas.fix;
        return {
          zh: `仿真测到的 CPU 约 ${f ? fmtPct(f.cpu) : '50%'}，估算也在这附近：设计阶段用公式就能算出个大概，不必每次都跑仿真。\n\n那平时把利用率控制在多少合适？业界常用的经验规则是 70% 左右。这不是定律，而是两方面的考虑：一是避开曲线变陡的区域；二是给突发流量和故障留余量。比如现在 2 个实例各 50%，如果挂掉一个，剩下那个就要扛 100%，正好回到刚才崩溃的状态。`,
          en: `The simulation measured about ${f ? fmtPct(f.cpu) : '50%'} CPU, and the estimate is close: at design time a formula gives you the rough answer without running a simulation.\n\nSo what utilization should you run at day to day? A common rule of thumb is around 70%. It isn't a law; it balances two things: staying off the steep part of the curve, and keeping headroom for bursts and failures. Right now 2 instances run at about 50% each; lose one and the other must carry 100%, exactly the meltdown you just saw.`,
        };
      },
    },
    {
      id: 'done',
      kind: 'read',
      title: L('小结', 'Wrap-up'),
      body: L(
        '记住三点：\n\n• 延迟不随流量线性增长：利用率低时几乎不变，过了 80% 左右急剧上升，到 100% 就开始无限排队。\n• 利用率 = 流量 × 每请求 CPU 时间 ÷ 核数，用它可以在设计阶段估算容量。\n• 平时留余量（常见经验值是 70% 左右），既避开陡峭区，也能扛住突发流量和单个实例故障。\n\n推荐接着打挑战第 1 关"第一次扩容"：流量会从 300/s 涨到 900/s，用这一课学到的东西决定要扩多少。',
        'Three things to remember:\n\n• Latency doesn\'t grow in proportion to traffic: it barely moves at low utilization, rises sharply past about 80%, and at 100% the queue grows without end.\n• Utilization = traffic × CPU time per request ÷ cores; use it to estimate capacity at design time.\n• Keep headroom day to day (around 70% is a common rule of thumb): it keeps you off the steep part and covers bursts and the loss of an instance.\n\nNext, try challenge level 1, "First scale-out": traffic climbs from 300/s to 900/s, and this lesson tells you how much to scale.',
      ),
    },
  ],
};

