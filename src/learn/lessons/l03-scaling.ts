// Lesson 3: scaling up vs scaling out. Same 4 cores, one big instance or several small ones:
// the big one queues better (lower p95), the small ones survive a crash, and more cores add
// throughput but don't make a single request faster.
import { blankTopology, newEdge, newNode } from '../../engine/presets';
import { L, type Lang, type Topology } from '../../engine/types';
import { fmtAvail, fmtLatency, fmtPct } from '../../ui/format';
import type { BarGroup, Lesson, LessonCtx, Measure, PredictOption } from '../types';
import { mainService, reveal, trafficRate } from '../helpers';

const LOAD = 340; // 4 cores at about 80%; 2 cores (about 210/s) are overloaded
const DAILY = 250; // 4 cores at about 60%; 3 cores still cope after a crash
const LOW = 50; // hardly any queueing, so only processing time is left

const rps = trafficRate;
const svcParam = (c: LessonCtx, k: string, d: number) => Number(mainService(c)?.params[k] ?? d);
const inst = (c: LessonCtx) => svcParam(c, 'instances', 0);
const cores = (c: LessonCtx) => svcParam(c, 'cpuCores', 2);
const shape = (c: LessonCtx, i: number, k: number) => inst(c) === i && cores(c) === k;
const m = (c: LessonCtx, k: string): Measure | undefined => c.meas[k];
const x = (v: number) => `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}×`;

const svcSelected = (c: LessonCtx) => { const s = mainService(c); return !!s && c.selection?.kind === 'node' && c.selection.id === s.id; };
const clientSelected = (c: LessonCtx) => c.selection?.kind === 'node' && c.selection.id === 'client';
const svcCard = (c: LessonCtx) => { const s = mainService(c); return s ? `.react-flow__node[data-id="${s.id}"] .sn` : null; };
/** Point at a field in the service's inspector, or at the service first if it isn't open. */
const svcField = (c: LessonCtx, sel: string) => (svcSelected(c) ? `.inspector ${sel}` : svcCard(c));
const trafficField = (c: LessonCtx) => (clientSelected(c) ? '.inspector [data-param="tm-constant-rps"]' : '.react-flow__node[data-id="client"] .sn');

const downNow = (c: LessonCtx) => {
  const s = mainService(c);
  return s ? c.failures.filter((f) => f.nodeId === s.id && f.kind === 'instanceDown' && (f.end < 0 || f.end > c.now * 1000)) : [];
};
/** An instance crash injected within the last 40 s: a fault left over from an earlier step doesn't count. */
const freshDown = (c: LessonCtx) => downNow(c).some((f) => c.now * 1000 - f.start <= 40_000);

/** Walks the learner through a target setup: traffic, then instances, then cores, then the fault. */
function pointAtSetup(c: LessonCtx, rate: number, i: number, k: number, fault: boolean): string | null {
  if (rps(c) !== rate) return trafficField(c);
  if (inst(c) !== i) return svcField(c, '[data-param="instances"]');
  if (cores(c) !== k) return svcField(c, '[data-param="cpuCores"]');
  if (fault && !freshDown(c)) return svcField(c, '[data-fault="instanceDown"]');
  if (!fault && downNow(c).length) return svcField(c, '[data-fault="instanceDown"]');
  return c.running ? null : '[data-learn="run"]';
}

const WHICH_OPTIONS: PredictOption[] = [
  // the measured value is p95(2 × 2 cores) ÷ p95(1 × 4 cores)
  { label: L('垂直扩展（1 个 × 4 核）更低', 'Scaling up (1 × 4 cores) is lower'), range: [1.15, Infinity] },
  { label: L('差不多', 'About the same'), range: [0.87, 1.15] },
  { label: L('水平扩展（2 个 × 2 核）更低', 'Scaling out (2 × 2 cores) is lower'), range: [0, 0.87] },
];
const CRASH_OPTIONS: PredictOption[] = [
  { label: L('几乎全挂（接近 0%）', 'Almost everything fails (near 0%)'), range: [0, 0.5] },
  { label: L('先掉一截，然后恢复', 'A dip, then it recovers'), range: [0.5, 0.97] },
  { label: L('几乎不受影响', 'Hardly affected'), range: [0.97, Infinity] },
];
const FLOOR_OPTIONS: PredictOption[] = [
  // the measured value is average(4 cores) ÷ average(1 core)
  { label: L('明显变快（降一半左右）', 'Much faster (about half)'), range: [0, 0.6] },
  { label: L('快一些（降 15%–40%）', 'Somewhat faster (15–40% lower)'), range: [0.6, 0.85] },
  { label: L('几乎不变', 'About the same'), range: [0.85, Infinity] },
];

function make(lang: Lang): Topology {
  const topo = blankTopology(lang);
  topo.name = L('第 3 课：垂直扩展与水平扩展', 'Lesson 3: scaling up and scaling out')[lang];
  const client = topo.nodes[0];
  client.params = { ...client.params, rps: LOAD };
  const svc = newNode('service', client.x + 380, client.y, topo.nodes, lang);
  svc.params = { ...svc.params, instances: 1, cpuCores: 2 };
  topo.nodes.push(svc);
  topo.edges.push(newEdge(client, svc, topo.edges));
  return topo;
}

const one = L('1 个 × 4 核', '1 × 4 cores');

// AWS EC2 on-demand, us-east-1 (checked November 2026). One simulated core is taken as one vCPU.
const AWS = { large: 0.1008, xlarge: 0.2016, alb: 0.0225 }; // m7i.large 2 vCPU, m7i.xlarge 4 vCPU, ALB per hour
const MONTH = 730; // hours
const perMonth = (hourly: number) => `$${Math.round(hourly * MONTH)}`;
const COST = {
  up: AWS.xlarge, // 1 × m7i.xlarge, no load balancer needed
  out: 2 * AWS.large + AWS.alb, // 2 × m7i.large behind an ALB
  upN1: 2 * AWS.xlarge + AWS.alb, // survive one crash: a second big one
  outN1: 3 * AWS.large + AWS.alb, // survive one crash: a third small one
};

function bars(c: LessonCtx): BarGroup[] {
  const up = m(c, 'up'), out = m(c, 'out'), dv = m(c, 'downV'), dh = m(c, 'downH'), c1 = m(c, 'c1'), c4 = m(c, 'c4');
  const groups: BarGroup[] = [];
  if (up && out) groups.push({
    title: L(`同样 4 个核，${LOAD}/s 时的 p95 延迟`, `Same 4 cores: p95 latency at ${LOAD}/s`),
    rows: [
      { label: one, value: up.p95, text: fmtLatency(up.p95) },
      { label: L('2 个 × 2 核', '2 × 2 cores'), value: out.p95, text: fmtLatency(out.p95) },
    ],
  });
  // the AWS bill, next to the latency comparison it goes with
  if (up && out && !dv) groups.push({
    title: L('AWS 每月成本（us-east-1 按需价）', 'AWS cost per month (us-east-1, on-demand)'),
    rows: [
      { label: L('1 × 4 vCPU', '1 × 4 vCPU'), value: COST.up, text: perMonth(COST.up) },
      { label: L('2 × 2 vCPU', '2 × 2 vCPU'), value: COST.out, text: perMonth(COST.out) },
      { label: L('N+1：2 × 4', 'N+1: 2 × 4'), value: COST.upN1, text: perMonth(COST.upN1), bad: true },
      { label: L('N+1：3 × 2', 'N+1: 3 × 2'), value: COST.outN1, text: perMonth(COST.outN1) },
    ],
  });
  if (dv && dh) groups.push({
    title: L('挂掉 1 个实例时的可用性', 'Availability with one instance crashed'),
    max: 1,
    rows: [
      { label: one, value: dv.avail, text: fmtAvail(dv.avail), bad: dv.avail < 0.5 },
      { label: L('4 个 × 1 核', '4 × 1 core'), value: dh.avail, text: fmtAvail(dh.avail), bad: dh.avail < 0.5 },
    ],
  });
  if (c1 && c4) groups.push({
    title: L(`${LOW}/s 时的平均延迟`, `Average latency at ${LOW}/s`),
    rows: [
      { label: L('每实例 1 核', '1 core each'), value: c1.avg, text: fmtLatency(c1.avg) },
      { label: L('每实例 4 核', '4 cores each'), value: c4.avg, text: fmtLatency(c4.avg) },
    ],
  });
  // while working through the lesson, show only the latest comparison (the cost next to the latency
  // it goes with); at the end, all of them
  if (c1 && c4) return groups;
  return up && out && !dv ? groups.slice(-2) : groups.slice(-1);
}

export const lesson03: Lesson = {
  id: 'l03-scaling',
  num: 3,
  title: L('垂直扩展与水平扩展', 'Scaling up and scaling out'),
  summary: L('同样 4 个核，做成一个大实例还是几个小实例？比较延迟、实例故障的影响，以及加核到底加了什么。', 'Same 4 cores: one big instance or several small ones? Compare latency, what a crash does, and what more cores really buy.'),
  minutes: 9,
  speed: 5,
  make,
  bars,
  steps: [
    {
      id: 'predict-which',
      kind: 'predict',
      title: L('先预测', 'Predict first'),
      body: L(
        `起点已经搭好："用户流量"每秒发 ${LOAD} 个请求，交给一个只有 1 个实例、2 个核的微服务。上一课算过，2 个核每秒大约只能处理 210 个请求，所以它会过载。\n\n要扛住，算力至少得翻倍。有两种做法：\n\n• 垂直扩展：还是 1 个实例，每个实例从 2 核加到 4 核。\n• 水平扩展：每个实例还是 2 核，实例从 1 个加到 2 个。\n\n两种做法总共都是 4 个核。先猜一下：哪种做法的 p95 延迟更低？`,
        `The starting point is ready: the traffic source sends ${LOAD} requests a second to a service with 1 instance and 2 cores. As lesson 2 worked out, 2 cores handle only about 210 a second, so it is overloaded.\n\nTo cope, capacity has to at least double. There are two ways:\n\n• Scale up: keep 1 instance and give it 4 cores instead of 2.\n• Scale out: keep 2 cores per instance and run 2 instances instead of 1.\n\nBoth add up to 4 cores. Guess first: which one has the lower p95 latency?`,
      ),
      options: WHICH_OPTIONS,
    },
    {
      id: 'base',
      kind: 'do',
      title: L('先看过载', 'See the overload'),
      body: L('点"运行"，先看 15 秒过载的样子。', 'Press Run and watch the overload for 15 seconds.'),
      highlight: (c) => (c.running ? null : '[data-learn="run"]'),
      check: (c) => rps(c) === LOAD && shape(c, 1, 2),
      hold: 12,
      settle: 4,
      measure: 'base',
      feedback: (c) => {
        const b = m(c, 'base');
        if (!b) return L('', '');
        return {
          zh: `CPU ${fmtPct(b.cpu)}，可用性 ${fmtAvail(b.avail)}，p95 ${fmtLatency(b.p95)}：请求来得比处理得快，队列越排越长，排满后新请求被拒绝。`,
          en: `CPU ${fmtPct(b.cpu)}, availability ${fmtAvail(b.avail)}, p95 ${fmtLatency(b.p95)}: requests arrive faster than they are handled, the queue keeps growing, and once it is full new requests are turned away.`,
        };
      },
    },
    {
      id: 'up',
      kind: 'do',
      title: L('垂直扩展', 'Scale up'),
      body: L(
        '点击微服务，在"处理"分组里把"每实例 CPU 核数"改成 4，实例数保持 1。保持运行，观察 30 秒（前几秒在消化积压的队列）。',
        'Click the service and, in the Processing group, set CPU cores per instance to 4. Keep 1 instance. Keep it running and watch for 30 seconds (the first few seconds clear the backlog).',
      ),
      highlight: (c) => pointAtSetup(c, LOAD, 1, 4, false),
      check: (c) => rps(c) === LOAD && shape(c, 1, 4),
      hold: 30,
      settle: 8,
      measure: 'up',
      feedback: (c) => {
        const u = m(c, 'up');
        if (!u) return L('', '');
        return {
          zh: `1 个实例 × 4 核：CPU ${fmtPct(u.cpu)}，p95 ${fmtLatency(u.p95)}，可用性 ${fmtAvail(u.avail)}。扛住了。`,
          en: `1 instance × 4 cores: CPU ${fmtPct(u.cpu)}, p95 ${fmtLatency(u.p95)}, availability ${fmtAvail(u.avail)}. It copes.`,
        };
      },
    },
    {
      id: 'out',
      kind: 'do',
      title: L('水平扩展', 'Scale out'),
      body: L(
        '换另一种做法：把"每实例 CPU 核数"改回 2，再把"实例数"改成 2。总共还是 4 个核。同样观察 30 秒。',
        'Now the other way: set CPU cores per instance back to 2, then set Instances to 2. Still 4 cores in total. Watch for 30 seconds again.',
      ),
      highlight: (c) => (cores(c) !== 2 ? svcField(c, '[data-param="cpuCores"]') : pointAtSetup(c, LOAD, 2, 2, false)),
      check: (c) => rps(c) === LOAD && shape(c, 2, 2),
      hold: 30,
      settle: 8,
      measure: 'out',
      feedback: (c) => {
        const u = m(c, 'up'), o = m(c, 'out');
        if (!u || !o) return L('', '');
        const r = o.p95 / u.p95;
        return {
          zh: `2 个实例 × 2 核：CPU ${fmtPct(o.cpu)}，和垂直扩展几乎一样；p95 却是 ${fmtLatency(o.p95)}，垂直扩展是 ${fmtLatency(u.p95)}，约为它的 ${x(r)}。${reveal(c, 'predict-which', r, WHICH_OPTIONS).zh}`,
          en: `2 instances × 2 cores: CPU ${fmtPct(o.cpu)}, almost the same as scaling up; but p95 is ${fmtLatency(o.p95)} against ${fmtLatency(u.p95)}, about ${x(r)}. ${reveal(c, 'predict-which', r, WHICH_OPTIONS).en}`,
        };
      },
    },
    {
      id: 'why-pool',
      kind: 'read',
      title: L('为什么大实例排队更少', 'Why the big instance queues less'),
      body: L(
        '想想超市收银。4 个收银员共用一条队伍，谁先空下来谁接下一位；换成各排各的 4 条队，常常一条排得很长，旁边的收银员却闲着。\n\n1 个 4 核实例就像共用一条队：只要 4 个核里有一个空着，新请求就能马上处理。2 个 2 核实例是两条队：请求被平均分过去，但请求是随机到达的，常常一边忙不过来，另一边却有空闲的核。\n\n平均利用率一样，排队却不一样，差距在 p95 这种"慢的那批请求"上最明显，而且越接近满载差距越大。排队论把这叫做资源池化的效率。\n\n这么看，实例好像越大越好。下一步看它的代价。',
        'Think of supermarket checkouts. Four cashiers sharing one line: whoever is free takes the next customer. Four separate lines: one line is often long while the cashier next to it sits idle.\n\nOne 4-core instance is the shared line: as long as any of its 4 cores is free, a new request starts at once. Two 2-core instances are two lines: requests are split evenly, but they arrive at random, so one side is often swamped while the other has an idle core.\n\nSame average utilization, different queueing. The gap shows most in p95, the slow tail, and it widens as you approach full load. Queueing theory calls this the efficiency of pooling.\n\nSo bigger instances look better. Next, see what they cost.',
      ),
    },
    {
      id: 'cost',
      kind: 'read',
      title: L('算一笔 AWS 的账', 'Now the AWS bill'),
      body: L(
        `性能比完了，再看钱。以 AWS EC2 的 m7i 系列为例（us-east-1 按需价，2026 年 11 月），把仿真里的 1 个核当作 1 个 vCPU：\n\n• m7i.large：2 vCPU，$${AWS.large}/小时，约 ${perMonth(AWS.large)}/月\n• m7i.xlarge：4 vCPU，$${AWS.xlarge}/小时，约 ${perMonth(AWS.xlarge)}/月\n\n同一系列里，价格和 vCPU 数成正比，每个 vCPU 都是约 $0.05/小时。所以总核数一样时，垂直和水平的机器钱是一样的。差别在别处：\n\n• 水平扩展要有负载均衡器分流量。AWS 的 ALB 每小时 $${AWS.alb}（约 ${perMonth(AWS.alb)}/月），另加按流量计的 LCU 费用。所以 2 × 2 vCPU 每月约 ${perMonth(COST.out)}，比 1 × 4 vCPU 的 ${perMonth(COST.up)} 略贵。\n• 每个实例都要跑操作系统、监控代理之类的东西，这部分开销按实例数算，实例越小占比越大。\n• 真正拉开差距的是"挂一台还扛得住"（N+1）。要在 ${LOAD}/s 下挂掉一台后还剩 4 个 vCPU：垂直扩展得准备 2 台 m7i.xlarge，共 8 个 vCPU，每月约 ${perMonth(COST.upN1)}；水平扩展 3 台 m7i.large，共 6 个 vCPU 就够，每月约 ${perMonth(COST.outN1)}。同样扛得住挂一台，便宜约 ${Math.round((1 - COST.outN1 / COST.upN1) * 100)}%。实例越小，多准备的那一台就越便宜。\n\n后面两步就来看挂一台会怎样。\n\n注意：m7i 最小的型号是 2 vCPU，后面实验里的 1 核实例在这个系列里没有对应型号。工作台右上角的"成本"是简化模型（每核每小时 $0.10），用来比较方案之间的相对高低，不是 AWS 账单。实际价格因区域、Savings Plans、Spot 而不同。`,
        `So much for performance; now the money. Take AWS EC2's m7i family (us-east-1 on-demand, November 2026), counting one simulated core as one vCPU:\n\n• m7i.large: 2 vCPU, $${AWS.large}/hour, about ${perMonth(AWS.large)}/month\n• m7i.xlarge: 4 vCPU, $${AWS.xlarge}/hour, about ${perMonth(AWS.xlarge)}/month\n\nWithin a family the price is proportional to vCPUs, about $0.05 per vCPU-hour. So for the same total cores, scaling up and scaling out cost the same in machines. The differences are elsewhere:\n\n• Scaling out needs a load balancer to split traffic. An AWS ALB is $${AWS.alb}/hour (about ${perMonth(AWS.alb)}/month), plus LCU charges by traffic. So 2 × 2 vCPU is about ${perMonth(COST.out)}/month, a little more than ${perMonth(COST.up)} for 1 × 4 vCPU.\n• Every instance runs an operating system, monitoring agents and so on; that overhead is per instance and weighs more on small instances.\n• The real gap is surviving the loss of one machine (N+1). To keep 4 vCPUs at ${LOAD}/s after one crash, scaling up needs 2 × m7i.xlarge, 8 vCPUs, about ${perMonth(COST.upN1)}/month; scaling out needs 3 × m7i.large, 6 vCPUs, about ${perMonth(COST.outN1)}/month. The same resilience for about ${Math.round((1 - COST.outN1 / COST.upN1) * 100)}% less. The smaller the instances, the cheaper the spare one.\n\nThe next two steps show what happens when one crashes.\n\nNote: the smallest m7i is 2 vCPU, so the 1-core instances later in this lesson have no m7i equivalent. The Cost in the top-right corner of the workbench is a simplified model ($0.10 per core-hour) for comparing options with each other, not an AWS bill. Real prices vary with region, Savings Plans and Spot.`,
      ),
    },
    {
      id: 'crash-big',
      kind: 'do',
      title: L('大实例挂了', 'The big instance crashes'),
      body: L(
        `先把流量降到平时的水平：点击"用户流量"，把"流量"改成 ${DAILY}。然后点击微服务，改回 1 个实例 × 4 核，在检查器下方"故障注入"里找到"实例宕机"，数量 1，点"注入"。观察 15 秒。`,
        `First bring traffic down to a normal day: click the traffic source and set Rate to ${DAILY}. Then click the service, set it back to 1 instance × 4 cores, find Instance crash under Fault injection at the bottom of the inspector, keep the count at 1 and press Inject. Watch for 15 seconds.`,
      ),
      highlight: (c) => pointAtSetup(c, DAILY, 1, 4, true),
      check: (c) => rps(c) === DAILY && shape(c, 1, 4) && freshDown(c),
      hold: 15,
      settle: 1,
      measure: 'downV',
      feedback: (c) => {
        const d = m(c, 'downV');
        if (!d) return L('', '');
        return {
          zh: `可用性 ${fmtAvail(d.avail)}：唯一的实例挂了，所有请求都失败，直到它重新拉起。这就是单点故障。`,
          en: `Availability ${fmtAvail(d.avail)}: the only instance is down, so every request fails until it restarts. That is a single point of failure.`,
        };
      },
    },
    {
      id: 'predict-crash',
      kind: 'predict',
      title: L('再预测', 'Predict again'),
      body: L(
        `换成 4 个实例 × 1 核：总共还是 4 个核，流量还是 ${DAILY}/s。同样挂掉 1 个实例，可用性会怎样？`,
        `Switch to 4 instances × 1 core: still 4 cores in total, still ${DAILY}/s. Crash one instance the same way. What happens to availability?`,
      ),
      options: CRASH_OPTIONS,
    },
    {
      id: 'crash-small',
      kind: 'do',
      title: L('小实例挂一个', 'One small instance crashes'),
      body: L(
        '如果上一次的故障还在生效，先在"实例宕机"那里点"结束"。然后把"实例数"改成 4、"每实例 CPU 核数"改成 1，再注入一次"实例宕机"（数量 1）。观察 20 秒。',
        'If the last crash is still active, press End on Instance crash first. Then set Instances to 4 and CPU cores per instance to 1, and inject Instance crash again (count 1). Watch for 20 seconds.',
      ),
      highlight: (c) => (downNow(c).length && !freshDown(c) ? svcField(c, '[data-fault="instanceDown"]') : pointAtSetup(c, DAILY, 4, 1, true)),
      check: (c) => rps(c) === DAILY && shape(c, 4, 1) && freshDown(c),
      hold: 20,
      settle: 1,
      measure: 'downH',
      feedback: (c) => {
        const d = m(c, 'downH');
        if (!d) return L('', '');
        return {
          zh: `可用性 ${fmtAvail(d.avail)}。${reveal(c, 'predict-crash', d.avail, CRASH_OPTIONS).zh}\n\n掉的那部分几乎都发生在头 10 秒左右：健康检查还没发现实例挂了，大约四分之一的请求仍然发给它。它被摘掉以后，剩下 3 个实例的算力仍然够处理 ${DAILY}/s，可用性回到 100%。\n\n所以生产环境里，无状态服务通常至少跑 3 个实例，并且留够余量：挂掉一个，剩下的还能扛住。这叫 N+1。`,
          en: `Availability ${fmtAvail(d.avail)}. ${reveal(c, 'predict-crash', d.avail, CRASH_OPTIONS).en}\n\nAlmost all of the loss happens in the first 10 seconds or so: health checks haven't noticed the crash yet, so about a quarter of requests still go to the dead instance. Once it is taken out, the other 3 instances have enough capacity for ${DAILY}/s and availability is back to 100%.\n\nThat is why stateless services in production usually run at least 3 instances with enough headroom that losing one is fine. This is called N+1.`,
        };
      },
    },
    {
      id: 'predict-floor',
      kind: 'predict',
      title: L('最后一个问题', 'One last question'),
      body: L(
        `加核能不能让单个请求变快？\n\n把流量降到很低（${LOW}/s），每个实例从 1 核加到 4 核。平均延迟会怎样？`,
        `Do more cores make a single request faster?\n\nAt very low traffic (${LOW}/s), go from 1 core to 4 cores per instance. What happens to average latency?`,
      ),
      options: FLOOR_OPTIONS,
    },
    {
      id: 'floor',
      kind: 'do',
      title: L('低负载下加核', 'More cores at low load'),
      body: (c) => {
        const next = !m(c, 'c1') ? 1 : 4;
        const done = (m(c, 'c1') ? 1 : 0) + (m(c, 'c4') ? 1 : 0);
        return {
          zh: `把"流量"改成 ${LOW}（如果"实例宕机"还在生效，先点"结束"），实例保持 4 个。先在每实例 1 核下观察 20 秒，再把核数改成 4，再观察 20 秒。现在请把核数设为 ${next}（已完成 ${done} / 2）。`,
          en: `Set Rate to ${LOW} (if Instance crash is still active, press End first) and keep 4 instances. Watch for 20 seconds at 1 core per instance, then set cores to 4 and watch another 20 seconds. Set cores to ${next} now (${done} of 2 done).`,
        };
      },
      highlight: (c) => pointAtSetup(c, LOW, 4, !m(c, 'c1') ? 1 : 4, false),
      check: (c) => rps(c) === LOW && inst(c) === 4 && downNow(c).length === 0,
      sweep: { values: [1, 4], key: 'c', value: cores },
      hold: 20,
      settle: 4,
      feedback: (c) => {
        const a = m(c, 'c1'), b = m(c, 'c4');
        if (!a || !b) return L('', '');
        const r = b.avg / a.avg;
        const faster = Math.max(0, Math.round((1 - r) * 100));
        return {
          zh: `1 核时平均 ${fmtLatency(a.avg)}，4 核时平均 ${fmtLatency(b.avg)}，只快了约 ${faster}%。${reveal(c, 'predict-floor', r, FLOOR_OPTIONS).zh}\n\n一个请求同一时刻只在一个核上运行，处理本身要花的时间不会因为核多而缩短。负载低时几乎不用排队，所以加核几乎没用。核数加的是"同时能处理多少个"，也就是吞吐。要让单个请求变快，得优化代码，或者换单核更快的 CPU。`,
          en: `Average ${fmtLatency(a.avg)} with 1 core, ${fmtLatency(b.avg)} with 4: only about ${faster}% faster. ${reveal(c, 'predict-floor', r, FLOOR_OPTIONS).en}\n\nA request runs on one core at a time, so the processing it needs doesn't shrink with more cores. At low load there is hardly any queueing, so extra cores barely help. Cores add how many requests can run at once, that is, throughput. To make one request faster you optimize the code or use a CPU with faster cores.`,
        };
      },
    },
    {
      id: 'done',
      kind: 'read',
      title: L('小结', 'Wrap-up'),
      body: L(
        '记住四点：\n\n• 同样的总算力，大实例共用一条队，排队更少、尾延迟更低；负载越高，差距越大。\n• 但一个实例就是一个故障点。无状态服务通常至少跑 3 个实例并留够余量，挂掉一个还能扛住（N+1）；健康检查发现之前，还会有一小段时间请求失败。\n• 云上同一系列按 vCPU 计价，总核数一样，机器钱就一样；水平扩展多一个负载均衡器的钱，但要留 N+1 余量时，小实例多准备一台便宜得多。\n• 加核加的是吞吐，不会缩短单个请求的处理时间；单个实例的核数也有上限（这里是 64 核）。\n\n实际做法通常是两者结合：先把单个实例定在合适的规格，再靠实例数扩容，并留出 N+1 的余量。',
        'Four things to remember:\n\n• For the same total capacity, a big instance shares one queue, so it queues less and has a lower tail latency; the gap widens with load.\n• But one instance is one point of failure. Stateless services usually run at least 3 instances with enough headroom to lose one (N+1); until health checks notice, some requests still fail for a short while.\n• In the cloud a family is priced per vCPU, so the same total cores cost the same; scaling out adds a load balancer, but once you keep N+1 headroom, a spare small instance is far cheaper than a spare big one.\n• Cores add throughput; they don\'t shorten the processing of a single request. And one instance can only have so many cores (64 here).\n\nIn practice you combine the two: pick a sensible size for one instance, then scale with the number of instances, keeping N+1 headroom.',
      ),
    },
  ],
};
