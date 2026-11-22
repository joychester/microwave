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
  minutes: 10,
  // starts at 1×: one of the first steps is switching to 5× yourself
  speed: 1,
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
      id: 'duration',
      kind: 'do',
      title: L('设置运行时长', 'Set the run length'),
      body: L(
        '运行之前，先认识顶栏的两个设置。\n\n顶栏中间的时钟显示"已运行 / 运行时长"。运行时长决定一次测试跑多久（按仿真时间算）：时间一到会自动停止，并在底部生成一份运行报告。课程开始时默认是 30 分钟。点一下时钟，把运行时长改成 5 分钟，用来观察结果已经足够。\n\n如果课程做到一半，运行到时自动停了，再点"运行"就会开始下一次运行，课程可以接着做。',
        'Before running, get to know two settings in the top bar.\n\nThe clock in the middle shows "elapsed / run length". The run length is how long one test runs, in simulated time: when it is up the run stops on its own and writes a run report at the bottom. Lessons start with 30 minutes. Click the clock and set the run length to 5 minutes, which is plenty to see the results.\n\nIf a run stops on time halfway through the lesson, press Run again: a new run starts and the lesson carries on.',
      ),
      // the clock's menu, once it is open; otherwise the clock itself
      highlight: (c) => (c.duration === 300 ? null : typeof document !== 'undefined' && document.querySelector('[data-learn="dur-300"]') ? '[data-learn="dur-300"]' : '[data-learn="clock"]'),
      check: (c) => c.duration === 300,
      feedback: L(
        '运行时长改成 5 分钟了，时钟会显示"已运行 / 5:00"。',
        'The run length is now 5 minutes; the clock shows "elapsed / 5:00".',
      ),
    },
    {
      id: 'speed',
      kind: 'do',
      title: L('设置仿真速度', 'Set the simulation speed'),
      body: L(
        '时钟左边的 1× 2× 5× 10× 20× 是仿真速度：真实的 1 秒里，仿真走几秒。1× 和真实时间一样快；5× 时，5 分钟的测试真实只要 1 分钟。\n\n速度只影响你要等多久，不影响结果：同样的配置，用 1× 和 5× 跑出来的指标基本一样。速度太快时浏览器可能跟不上，时钟旁会显示实际达到的倍数。\n\n现在是 1×。把它改成 5×，更快看到运行状态和结果。',
        'The 1× 2× 5× 10× 20× buttons left of the clock set the simulation speed: how many simulated seconds pass in one real second. 1× runs in real time; at 5×, a 5-minute test takes 1 real minute.\n\nSpeed only changes how long you wait, not the results: the same setup gives essentially the same numbers at 1× and at 5×. If the speed is too high for the browser, the clock shows the speed it actually reached.\n\nIt is at 1× now. Switch to 5× to see the run and its results sooner.',
      ),
      highlight: (c) => (c.speed === 5 ? null : '[data-learn="speed-5"]'),
      check: (c) => c.speed === 5,
      feedback: L(
        '5×：真实 1 秒，仿真走 5 秒。后面跑 20 秒的仿真，大约只要 4 秒。',
        '5×: 5 simulated seconds per real second. The 20 simulated seconds in the next steps take about 4 real seconds.',
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
      // as soon as the measurement is in: suggest pausing to read it
      afterHighlight: (c) => (c.running ? '[data-learn="run"]' : null),
      feedback: (c) => {
        const m = c.meas.base;
        if (!m) return L('', '');
        const k = ratio(m);
        return {
          zh: `每秒处理约 ${fmtRate(m.rps)} 个请求，可用性 ${fmtAvail(m.avail)}，平均延迟 ${fmtLatency(m.avg)}，p95 ${fmtLatency(m.p95)}，约为平均的 ${x(k)}。${reveal(c, 'predict-p95', k, P95_OPTIONS).zh}\n\n为什么差这么多？每个请求的处理时间本来就不一样：大部分很快，少数很慢（长尾）。平均值会把这些慢请求"摊平"藏起来，所以 SLO 通常用 p95 或 p99 来定。\n\n先点顶栏闪烁的"暂停"（就是刚才的"运行"按钮），让数字停下来慢慢读。暂停时所有数字停在当前这一刻，运行时长也不消耗；之后需要时点"继续"，仿真从停下的地方接着跑。按空格键也可以暂停或继续。`,
          en: `About ${fmtRate(m.rps)} requests/s, availability ${fmtAvail(m.avail)}, average latency ${fmtLatency(m.avg)}, p95 ${fmtLatency(m.p95)}: about ${x(k)} the average. ${reveal(c, 'predict-p95', k, P95_OPTIONS).en}\n\nWhy the gap? Processing times vary: most requests are fast and a few are slow (the long tail). An average smooths those slow requests away, which is why SLOs are usually set on p95 or p99.\n\nFirst press the flashing Pause in the top bar (the button that said Run) so the numbers hold still while you read. While paused every number stays put and the run length stops counting down; press Resume later and the simulation carries on from where it stopped. The space bar pauses and resumes, too.`,
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
        '在检查器的"容量"分组里，把"实例数"改成 1。然后点顶栏的"继续"让仿真接着跑，观察 20 秒。',
        'In the Capacity group of the inspector, set Instances to 1. Then press Resume in the top bar and watch for 20 seconds.',
      ),
      // after the instances, the Run button in case the run has reached its length and stopped
      highlight: (c) => (instances(c) !== 1 ? '.inspector [data-param="instances"]' : c.running ? null : '[data-learn="run"]'),
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
        '先把实例数改回 3。然后在检查器底部的"故障注入"里找到"变慢"，把倍数改成 3，点"注入"。保持运行，观察 15 秒（如果暂停了，点"继续"）。',
        'First set Instances back to 3. Then, under Fault injection at the bottom of the inspector, find Slowdown, set the multiplier to 3 and press Inject. Keep it running and watch for 15 seconds (press Resume if it is paused).',
      ),
      highlight: (c) => (instances(c) < 3 ? '.inspector [data-param="instances"]' : !slowActive(c) ? '.inspector [data-fault="slow"]' : c.running ? null : '[data-learn="run"]'),
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
      id: 'stop',
      kind: 'do',
      title: L('结束这次运行', 'End the run'),
      body: L(
        '实验做完了，结束这次运行。\n\n运行可以等到设定的时长自动结束，也可以随时手动结束：点开顶栏的时钟，选"立即结束并生成报告"。两种方式都会生成一份运行报告。',
        'The experiment is done; end this run.\n\nA run ends on its own when its length is up, or you can end it at any time: open the clock in the top bar and choose "Stop now and write the report". Either way you get a run report.',
      ),
      // the clock's menu item once the menu is open, otherwise the clock
      highlight: (c) => (!c.runActive ? null : typeof document !== 'undefined' && document.querySelector('[data-learn="stop-now"]') ? '[data-learn="stop-now"]' : '[data-learn="clock"]'),
      check: (c) => !c.runActive && !!c.report,
      feedback: (c) => {
        const r = c.report;
        const early = !!r && r.seconds < r.duration - 1;
        return early
          ? L('运行已结束，报告已经生成，底部的"报告"标签自动打开了。', 'The run has ended and its report is ready; the Report tab at the bottom opened by itself.')
          : L('这次运行已经到时自动结束，报告早就生成好了。', 'This run already reached its length and ended on its own, so its report is ready.');
      },
    },
    {
      id: 'report',
      kind: 'do',
      title: L('读运行报告', 'Read the run report'),
      body: L(
        '运行报告在底部的"报告"标签里（结束运行时会自动打开）。如果没看到，点一下"报告"标签。',
        'The run report is in the Report tab at the bottom (it opens when a run ends). If you don\'t see it, click the Report tab.',
      ),
      highlight: (c) => (c.dockOpen && c.dockTab === 'report' ? null : '[data-learn="dock-report"]'),
      check: (c) => c.dockOpen && c.dockTab === 'report' && !!c.report,
      feedback: (c) => {
        const r = c.report;
        if (!r) return L('', '');
        const mins = Math.floor(r.seconds / 60), secs = Math.round(r.seconds % 60);
        const durZh = mins ? `${mins} 分 ${secs} 秒` : `${secs} 秒`;
        const durEn = mins ? `${mins} min ${secs} s` : `${secs} s`;
        const slo = Math.round(r.sloSeconds);
        return {
          zh: `这次运行跑了 ${durZh}，可用性 ${fmtAvail(r.avail)}，平均延迟 ${fmtLatency(r.latAvg)}，${r.pct} ${fmtLatency(r.pctAll)}，其中 ${slo} 秒达到了 SLO。\n\n报告和顶栏的区别：顶栏是最近 5 秒，报告统计的是整次运行的所有请求。${r.editedMidRun ? '\n\n报告里有一条"注意：运行中改过参数"。你在这次运行里改过实例数，所以这份结果是几种配置混在一起的。做实验时，一次运行只改一个变量，结果才好对比。' : ''}\n\n往下看，"组件"表列出每个组件的峰值利用率和失败数，"失败原因"说明请求为什么失败。同一个拓扑再跑一次，就能在报告顶部选择和这一次对比，报告会列出两次之间改了哪些配置。报告还可以复制或导出成 Markdown，贴到文档里。`,
          en: `This run lasted ${durEn}: availability ${fmtAvail(r.avail)}, average latency ${fmtLatency(r.latAvg)}, ${r.pct} ${fmtLatency(r.pctAll)}, and ${slo} seconds met the SLO.\n\nThe report differs from the top bar: the top bar shows the last 5 seconds, the report covers every request in the whole run.${r.editedMidRun ? '\n\nThe report carries a note: "parameters were edited during this run". You changed the instances during this run, so the result mixes several setups. When you experiment, change one thing per run so the results are easy to compare.' : ''}\n\nFurther down, the Components table lists each component\'s peak utilization and failures, and Failure causes explain why requests failed. Run the same topology again and you can compare it with this run at the top of the report, including what configuration changed between the two. You can also copy or export the report as Markdown to paste into a document.`,
        };
      },
    },
    {
      id: 'done',
      kind: 'read',
      title: L('小结', 'Wrap-up'),
      body: L(
        '你已经会搭系统、设置运行、读指标、改参数、注入故障和看报告了。记住三点：\n\n• 看系统要同时看流量、错误、延迟分位数和利用率，只看一个会被误导。\n• 平均延迟会藏起慢请求，SLO 要看 p95 或 p99。\n• 实例减到 1 个时，CPU 只升了 3 倍，延迟却涨了好几倍。这就是第 2 课的主题：排队与利用率。',
        'You can now build a system, set up and run it, read the metrics, change parameters, inject faults and read the report. Three things to remember:\n\n• Look at traffic, errors, latency percentiles and utilization together; any one alone can mislead you.\n• Averages hide slow requests; set SLOs on p95 or p99.\n• With one instance, CPU only tripled but latency grew several times over. That is the subject of lesson 2: queueing and utilization.',
      ),
    },
  ],
};

