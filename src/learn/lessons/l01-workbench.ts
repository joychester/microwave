// Lesson 1: meet the workbench. Build the smallest system, run it, read the numbers,
// change one parameter, inject one fault.
import { blankTopology } from '../../engine/presets';
import { L } from '../../engine/types';
import { fmtAvail, fmtLatency, fmtPct, fmtRate } from '../../ui/format';
import type { Lesson, LessonCtx, Measure, PredictOption } from '../types';
import { hasLink, mainService, reveal } from '../helpers';

const P95_OPTIONS: PredictOption[] = [
  { label: L('差不多一样（1–1.5 倍）', 'About the same (1–1.5×)'), range: [0, 1.5] },
  { label: L('约 2–3 倍', 'About 2–3×'), range: [1.5, 3.5] },
  { label: L('5 倍以上', '5× or more'), range: [3.5, Infinity] },
];

const CPU_OPTIONS: PredictOption[] = [
  { label: L('基本不变（约 30%）', 'About the same (around 30%)'), range: [0, 0.45] },
  { label: L('约 60%', 'Around 60%'), range: [0.45, 0.8] },
  { label: L('约 95%', 'Around 95%'), range: [0.8, Infinity] },
];

const instances = (c: LessonCtx) => Number(mainService(c)?.params.instances ?? 0);
const slowActive = (c: LessonCtx) => {
  const s = mainService(c);
  return !!s && c.failures.some((f) => f.nodeId === s.id && f.kind === 'slow' && (f.end < 0 || f.end > c.now * 1000));
};
const ratio = (m?: Measure) => (m && m.avg > 0 ? m.p95 / m.avg : NaN);
const x = (v: number) => `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}×`;

export const lesson01: Lesson = {
  id: 'l01-workbench',
  num: 1,
  title: L('认识工作台', 'Meet the workbench'),
  summary: L('搭一个最小系统，跑起来，读懂 QPS、可用性、平均延迟、p95 和 CPU。', 'Build the smallest system, run it, and read throughput, availability, average and p95 latency, and CPU.'),
  minutes: 6,
  speed: 5,
  make: (lang) => blankTopology(lang),
  steps: [
    {
      id: 'build',
      kind: 'do',
      title: L('搭一个最小系统', 'Build the smallest system'),
      body: L(
        '画布上已经有一个"用户流量"，每秒发出 200 个请求。从左侧组件栏把"微服务"拖到画布上（点一下也行）。然后按住"用户流量"右边的小圆点，拖到微服务上，连成一条线。',
        'The canvas already has a traffic source sending 200 requests a second. Drag a Service from the component bar onto the canvas (or click it). Then drag from the small dot on the right of the traffic source onto the service to connect them.',
      ),
      highlight: (c) => (c.topo.nodes.some((n) => n.type === 'service') ? '.react-flow__node[data-id="client"] .react-flow__handle-right' : '[data-learn="pal-service"]'),
      check: hasLink,
      feedback: L(
        '这条线表示"用户流量调用微服务"，箭头指向被调用的一方。新加的微服务用默认参数：3 个实例，每个 2 核，处理一个请求的时间中位数 10ms，最慢的 1% 约 60ms。',
        'The line means "traffic calls the service"; the arrow points at the one being called. The new service starts with defaults: 3 instances with 2 cores each, a median processing time of 10ms, and the slowest 1% around 60ms.',
      ),
    },
    {
      id: 'predict-p95',
      kind: 'predict',
      title: L('先预测', 'Predict first'),
      body: L(
        'p95 延迟的意思是：95% 的请求比它快，只有最慢的 5% 比它慢。运行之前先猜一下：p95 大约是平均延迟的几倍？',
        'p95 latency means 95% of requests are faster than it and only the slowest 5% are slower. Before running, guess: how many times the average latency will p95 be?',
      ),
      options: P95_OPTIONS,
    },
    {
      id: 'run',
      kind: 'do',
      title: L('运行并读数', 'Run it and read the numbers'),
      body: L(
        '点击顶栏的"运行"，让仿真跑 20 秒（仿真时间，5 倍速下只要 4 秒左右）。运行时留意顶栏的指标：可用性、p95 延迟、平均延迟、每秒成功数。',
        'Press Run in the top bar and let the simulation run for 20 seconds (simulated time; about 4 seconds at 5× speed). Watch the metrics in the top bar: availability, p95 latency, average latency and successful requests per second.',
      ),
      highlight: (c) => (c.running ? null : '[data-learn="run"]'),
      check: hasLink,
      hold: 20,
      settle: 5,
      measure: 'base',
      feedback: (c) => {
        const m = c.meas.base;
        if (!m) return L('', '');
        const k = ratio(m);
        return {
          zh: `每秒处理约 ${fmtRate(m.rps)} 个请求，可用性 ${fmtAvail(m.avail)}，平均延迟 ${fmtLatency(m.avg)}，p95 ${fmtLatency(m.p95)}，约为平均的 ${x(k)}。${reveal(c, 'predict-p95', k, P95_OPTIONS).zh}\n\n为什么差这么多？每个请求的处理时间本来就不一样：大部分很快，少数很慢（长尾）。平均值会把这些慢请求"摊平"藏起来，所以 SLO 通常用 p95 或 p99 来定。`,
          en: `About ${fmtRate(m.rps)} requests/s, availability ${fmtAvail(m.avail)}, average latency ${fmtLatency(m.avg)}, p95 ${fmtLatency(m.p95)}: about ${x(k)} the average. ${reveal(c, 'predict-p95', k, P95_OPTIONS).en}\n\nWhy the gap? Processing times vary: most requests are fast and a few are slow (the long tail). An average smooths those slow requests away, which is why SLOs are usually set on p95 or p99.`,
        };
      },
    },
    {
      id: 'inspect',
      kind: 'do',
      title: L('看一个组件', 'Look at one component'),
      body: L(
        '点击画布上的微服务。右侧检查器顶部会显示它自己的实时数据：到达速率、平均、p95、错误率和 CPU。',
        'Click the service on the canvas. The top of the inspector on the right shows its own live numbers: arrivals, average, p95, error rate and CPU.',
      ),
      highlight: (c) => { const s = mainService(c); return s ? `.react-flow__node[data-id="${s.id}"] .sn` : null; },
      check: (c) => { const s = mainService(c); return !!s && c.selection?.kind === 'node' && c.selection.id === s.id; },
      feedback: (c) => {
        const m = c.meas.base;
        const cpu = m ? fmtPct(m.cpu) : '—';
        return {
          zh: `CPU 约 ${cpu}。每个请求要占用一点 CPU 时间，200 个请求/秒加起来，摊到 3 个实例共 6 个核上，就是这个利用率。画布上线的粗细也跟着流量大小变化。`,
          en: `CPU is about ${cpu}. Each request uses a little CPU time; 200 requests a second, spread across 3 instances with 6 cores in total, comes to this utilization. The thickness of the line on the canvas follows the traffic, too.`,
        };
      },
    },
    {
      id: 'predict-cpu',
      kind: 'predict',
      title: L('再预测一次', 'Predict again'),
      body: L(
        '接下来要把实例从 3 个减到 1 个，流量不变。你觉得 CPU 利用率会变成多少？',
        'Next you will cut the instances from 3 to 1, with the same traffic. What do you think CPU utilization will become?',
      ),
      options: CPU_OPTIONS,
    },
    {
      id: 'scale-in',
      kind: 'do',
      title: L('改一个参数', 'Change one parameter'),
      body: L(
        '在检查器的"容量"分组里，把"实例数"改成 1。保持运行，再观察 20 秒。',
        'In the Capacity group of the inspector, set Instances to 1. Keep it running and watch for another 20 seconds.',
      ),
      highlight: (c) => (instances(c) === 1 ? null : '.inspector [data-param="instances"]'),
      check: (c) => instances(c) === 1,
      hold: 20,
      settle: 5,
      measure: 'one',
      feedback: (c) => {
        const a = c.meas.base, b = c.meas.one;
        if (!a || !b) return L('', '');
        const cpuX = b.cpu / Math.max(a.cpu, 1e-6), latX = b.avg / Math.max(a.avg, 1e-6);
        return {
          zh: `CPU 从 ${fmtPct(a.cpu)} 升到 ${fmtPct(b.cpu)}（约 ${x(cpuX)}）。${reveal(c, 'predict-cpu', b.cpu, CPU_OPTIONS).zh}\n\n再看延迟：平均从 ${fmtLatency(a.avg)} 变成 ${fmtLatency(b.avg)}，约 ${x(latX)}。资源只紧张了 ${x(cpuX)}，延迟却涨了 ${x(latX)}，两者不是线性关系。为什么会这样，第 2 课专门讲。`,
          en: `CPU went from ${fmtPct(a.cpu)} to ${fmtPct(b.cpu)} (about ${x(cpuX)}). ${reveal(c, 'predict-cpu', b.cpu, CPU_OPTIONS).en}\n\nNow the latency: the average went from ${fmtLatency(a.avg)} to ${fmtLatency(b.avg)}, about ${x(latX)}. Resources got ${x(cpuX)} tighter, but latency grew ${x(latX)}: the two don't move in proportion. Lesson 2 explains why.`,
        };
      },
    },
    {
      id: 'fault',
      kind: 'do',
      title: L('注入一个故障', 'Inject a fault'),
      body: L(
        '先把实例数改回 3。然后在检查器底部的"故障注入"里找到"变慢"，把倍数改成 3，点"注入"。保持运行，观察 15 秒。',
        'First set Instances back to 3. Then, under Fault injection at the bottom of the inspector, find Slowdown, set the multiplier to 3 and press Inject. Keep it running and watch for 15 seconds.',
      ),
      highlight: (c) => (instances(c) < 3 ? '.inspector [data-param="instances"]' : slowActive(c) ? null : '.inspector [data-fault="slow"]'),
      check: (c) => instances(c) >= 3 && slowActive(c),
      hold: 15,
      settle: 3,
      measure: 'slow',
      feedback: (c) => {
        const a = c.meas.base, b = c.meas.slow;
        if (!a || !b) return L('', '');
        const errs = b.avail < 0.99;
        return {
          zh: `p95 从 ${fmtLatency(a.p95)} 涨到 ${fmtLatency(b.p95)}，CPU 也从 ${fmtPct(a.cpu)} 涨到 ${fmtPct(b.cpu)}。${errs ? `可用性掉到了 ${fmtAvail(b.avail)}：CPU 不够用，请求开始失败。` : ''}\n\n"变慢"代表代码回归或者依赖变慢。每个请求占用 CPU 的时间变长了，同样的流量就要吃掉更多容量。所以变慢不只是延迟问题，也是容量问题：倍数再大一点，CPU 就会打满，开始出错。`,
          en: `p95 went from ${fmtLatency(a.p95)} to ${fmtLatency(b.p95)}, and CPU from ${fmtPct(a.cpu)} to ${fmtPct(b.cpu)}. ${errs ? `Availability fell to ${fmtAvail(b.avail)}: there isn't enough CPU, so requests start to fail.` : ''}\n\nA slowdown stands for a code regression or a slower dependency. Each request holds the CPU longer, so the same traffic uses more capacity. A slowdown is a capacity problem, not only a latency one: a slightly bigger multiplier would max out the CPU and errors would start.`,
        };
      },
    },
    {
      id: 'done',
      kind: 'read',
      title: L('小结', 'Wrap-up'),
      body: L(
        '你已经会搭系统、运行、读指标、改参数和注入故障了。记住三点：\n\n• 看系统要同时看流量、错误、延迟分位数和利用率，只看一个会被误导。\n• 平均延迟会藏起慢请求，SLO 要看 p95 或 p99。\n• 实例减到 1 个时，CPU 只升了 3 倍，延迟却涨了好几倍。这就是第 2 课的主题：排队与利用率。',
        'You can now build a system, run it, read the metrics, change parameters and inject faults. Three things to remember:\n\n• Look at traffic, errors, latency percentiles and utilization together; any one alone can mislead you.\n• Averages hide slow requests; set SLOs on p95 or p99.\n• With one instance, CPU only tripled but latency grew several times over. That is the subject of lesson 2: queueing and utilization.',
      ),
    },
  ],
};

