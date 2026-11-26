// Lesson 6: autoscaling. It reacts after the fact (a decision period plus a cold start), so a sudden
// spike fails before new instances are ready; the target utilization trades that headroom against
// cost; a floor of 3 keeps N+1 and copes with the morning climb; over a day it saves money.
import { blankTopology, newEdge, newNode } from '../../engine/presets';
import { defaultLayer, isProgram, programFromLegacy, type TrafficLayer, type TrafficProgram } from '../../engine/traffic';
import { L, type Lang, type Topology } from '../../engine/types';
import { fmtAvail, fmtLatency, fmtPct } from '../../ui/format';
import type { BarGroup, Lesson, LessonCtx, Measure, PredictOption } from '../types';
import { mainService, reveal } from '../helpers';

const BASE = 200; // req/s: 2 instances × 2 cores at about 47% CPU, 3 at about 31%
const EXTRA = 300; // the spike adds this on top: 500 req/s, which 2 instances can't carry
const HOLD = 60; // seconds the spike lasts
const T_DEFAULT = 0.6; // the autoscaler's default target CPU
const T_LOW = 0.4;
const FLOOR = 3;
const PEAK = 800; // the compressed day's peak
const DAY = 300; // seconds in the compressed day (the editor's default)
const PERIOD = 15; // autoscaler decision period (default)
const COLD = 30; // cold start (default)
const M7I_LARGE_MONTH = 74; // $/month for a 2-vCPU m7i.large, as in lesson 3

const m = (c: LessonCtx, k: string): Measure | undefined => c.meas[k];
const svc = (c: LessonCtx) => mainService(c);
const p = (c: LessonCtx, k: string, d: number) => Number(svc(c)?.params[k] ?? d);
const asOn = (c: LessonCtx) => !!svc(c)?.params.asEnabled;
const target = (c: LessonCtx) => Math.round(p(c, 'asTarget', T_DEFAULT) * 100) / 100;
const asMin = (c: LessonCtx) => p(c, 'asMin', 2);

const program = (c: LessonCtx): TrafficProgram | null => {
  const client = c.topo.nodes.find((n) => n.type === 'client');
  if (!client) return null;
  return isProgram(client.params.traffic) ? client.params.traffic : programFromLegacy(client.params);
};
const baseKind = (c: LessonCtx) => program(c)?.base.kind;
const baseRate = (c: LessonCtx) => {
  const b = program(c)?.base;
  return b?.kind === 'constant' ? b.p.rps : NaN;
};
const spike = (c: LessonCtx): TrafficLayer | undefined => program(c)?.overlays.find((o) => o.kind === 'spike');
/** The spike is on now (rising, holding or falling). */
const spikeOn = (c: LessonCtx) => {
  const s = spike(c);
  if (!s) return false;
  const end = s.p.at + s.p.rise + s.p.hold + s.p.fall;
  return c.now >= s.p.at && c.now < end;
};
/** Instances running or starting right now. */
const live = (c: LessonCtx) => {
  const s = svc(c);
  const ns = s ? c.latest?.nodes[s.id] : undefined;
  return ns ? ns.instances + (ns.extra.starting ?? 0) : NaN;
};
const avgInst = (mm: Measure | undefined, c: LessonCtx) => {
  const s = svc(c);
  return mm && s ? mm.nodes[s.id]?.inst ?? 0 : 0;
};

const svcSelected = (c: LessonCtx) => { const s = svc(c); return !!s && c.selection?.kind === 'node' && c.selection.id === s.id; };
const clientSelected = (c: LessonCtx) => c.selection?.kind === 'node' && c.selection.id === 'client';
const svcField = (c: LessonCtx, sel: string) => { const s = svc(c); return svcSelected(c) ? `.inspector ${sel}` : s ? `.react-flow__node[data-id="${s.id}"] .sn` : null; };
const clientField = (c: LessonCtx, sel: string) => (clientSelected(c) ? `.inspector ${sel}` : '.react-flow__node[data-id="client"] .sn');
const runOrNull = (c: LessonCtx) => (c.running ? null : '[data-learn="run"]');
/** A field in the (collapsed by default) Autoscaling group: its header while closed, the field once open. */
const asField = (c: LessonCtx, key: string) =>
  svcField(c, `[data-sec="autoscale"]:not(.is-open) .ins-sec-head, .inspector [data-param="${key}"]`);

const SPIKE_OPTIONS: PredictOption[] = [
  // the measured value is availability over the first 45 s of the spike
  { label: L('几乎没影响，自动扩缩容马上补上', 'Hardly any effect: autoscaling catches it at once'), range: [0.995, Infinity] },
  { label: L('会慢一会儿，但请求基本不失败', 'Slower for a while, but almost nothing fails'), range: [0.97, 0.995] },
  { label: L('有一段时间相当一部分请求失败', 'For a while, a good share of requests fail'), range: [-Infinity, 0.97] },
];
const TARGET_OPTIONS: PredictOption[] = [
  // the measured value is availability over the first 45 s of the second spike
  { label: L('和刚才差不多', 'About the same as before'), range: [-Infinity, 0.97] },
  { label: L('失败少很多，但平时要多开实例', 'Far fewer failures, but more instances all the time'), range: [0.97, Infinity] },
];

function make(lang: Lang): Topology {
  const topo = blankTopology(lang);
  topo.name = L('第 6 课：自动扩缩容', 'Lesson 6: autoscaling')[lang];
  const client = topo.nodes[0];
  // a steady base plus a spike parked far in the future, to be fired from the traffic model
  const prog: TrafficProgram = {
    base: defaultLayer('constant', { rps: BASE }),
    overlays: [defaultLayer('spike', { at: 7200, extra: EXTRA, rise: 2, hold: HOLD, fall: 5 })],
  };
  client.params = { ...client.params, rps: BASE, traffic: prog };
  const s = newNode('service', client.x + 380, client.y, topo.nodes, lang);
  s.params = { ...s.params, instances: 3, cpuCores: 2, asEnabled: false };
  topo.nodes.push(s);
  topo.edges.push(newEdge(client, s, topo.edges));
  return topo;
}

function bars(c: LessonCtx): BarGroup[] {
  const groups: BarGroup[] = [];
  const s1 = m(c, 'spike'), s2 = m(c, 'spike40'), c1 = m(c, 'calm'), c2 = m(c, 'calm40'), day = m(c, 'day');
  if (s1 && s2 && c1 && c2) {
    groups.push({
      title: L('尖峰头 45 秒的可用性', 'Availability in the first 45 s of the spike'),
      max: 1,
      rows: [
        { label: L(`目标 ${pct(T_DEFAULT)}`, `Target ${pct(T_DEFAULT)}`), value: s1.avail, text: fmtAvail(s1.avail), bad: s1.avail < 0.99 },
        { label: L(`目标 ${pct(T_LOW)}`, `Target ${pct(T_LOW)}`), value: s2.avail, text: fmtAvail(s2.avail), bad: s2.avail < 0.99 },
      ],
    });
    groups.push({
      title: L('平时开着的实例数（成本）', 'Instances on a normal day (cost)'),
      rows: [
        { label: L(`目标 ${pct(T_DEFAULT)}`, `Target ${pct(T_DEFAULT)}`), value: avgInst(c1, c), text: avgInst(c1, c).toFixed(0) },
        { label: L(`目标 ${pct(T_LOW)}`, `Target ${pct(T_LOW)}`), value: avgInst(c2, c), text: avgInst(c2, c).toFixed(0) },
      ],
    });
  }
  if (day) {
    const s = svc(c);
    const n = s ? day.nodes[s.id] : undefined;
    if (n) groups.push({
      title: L('一整天的实例数', 'Instances over a whole day'),
      rows: [
        { label: L('按高峰固定', 'Fixed for the peak'), value: n.instMax, text: n.instMax.toFixed(0) },
        { label: L('自动扩缩容（平均）', 'Autoscaling (average)'), value: n.inst, text: n.inst.toFixed(1) },
      ],
    });
  }
  // while working through the lesson, show the latest comparison; at the end, all of them
  return day ? groups : groups.slice(0, 2);
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export const lesson06: Lesson = {
  id: 'l06-autoscale',
  num: 6,
  title: L('自动扩缩容', 'Autoscaling'),
  summary: L('流量突然翻倍，自动扩缩容要等将近一分钟才补上；目标利用率在余量和成本之间取舍。', 'Traffic doubles suddenly and autoscaling takes almost a minute to catch up; the target utilization trades headroom for cost.'),
  minutes: 14,
  speed: 5,
  make,
  bars,
  steps: [
    {
      id: 'predict-spike',
      kind: 'predict',
      title: L('先预测', 'Predict first'),
      body: L(
        `起点：每秒 ${BASE} 个请求，发给一个 3 个实例 × 2 核的微服务。第 3 课里扩容都是手动改实例数；这一课让系统自己扩缩容：盯着 CPU 利用率，高了就加实例，低了就减。\n\n打开自动扩缩容后，流量突然多出 ${EXTRA}/s（变成 ${BASE + EXTRA}/s，持续 1 分钟）。头 45 秒会怎样？`,
        `The start: ${BASE} requests a second to a service with 3 instances × 2 cores. In lesson 3 you scaled by changing the instance count yourself; here the system does it: it watches CPU utilization, adds instances when it is high and removes them when it is low.\n\nWith autoscaling on, traffic suddenly jumps by ${EXTRA}/s (to ${BASE + EXTRA}/s, for a minute). What happens in the first 45 seconds?`,
      ),
      options: SPIKE_OPTIONS,
    },
    {
      id: 'base',
      kind: 'do',
      title: L('先看平时', 'A normal day first'),
      body: L(
        '点"运行"，观察 15 秒。3 个实例的 CPU 利用率是多少？',
        'Press Run and watch for 15 seconds. How busy are the 3 instances?',
      ),
      highlight: runOrNull,
      check: (c) => baseRate(c) === BASE && !asOn(c) && p(c, 'instances', 0) === 3 && !spikeOn(c),
      hold: 15,
      settle: 3,
      measure: 'base',
      feedback: (c) => {
        const b = m(c, 'base');
        if (!b) return L('', '');
        return {
          zh: `CPU 利用率 ${fmtPct(b.cpu)}，p95 ${fmtLatency(b.p95)}。余量很大，3 个实例有点浪费。`,
          en: `CPU at ${fmtPct(b.cpu)}, p95 ${fmtLatency(b.p95)}. Plenty of headroom; 3 instances are more than this needs.`,
        };
      },
    },
    {
      id: 'enable',
      kind: 'do',
      title: L('打开自动扩缩容', 'Turn on autoscaling'),
      body: L(
        `点击微服务，在右侧"自动扩缩容"分组里打开开关，其余保持默认：目标 CPU 利用率 ${pct(T_DEFAULT)}，最少 2 个、最多 20 个实例，每 ${PERIOD} 秒做一次决定，新实例冷启动 ${COLD} 秒，缩容前要连续 60 秒都"该缩"才缩。\n\n然后等它自己把实例数调好。`,
        `Click the service and turn on the switch under Autoscaling on the right. Keep the defaults: target CPU ${pct(T_DEFAULT)}, 2 to 20 instances, a decision every ${PERIOD} seconds, a ${COLD}-second cold start for new instances, and it only scales down after 60 seconds of wanting to.\n\nThen wait for it to settle the instance count by itself.`,
      ),
      highlight: (c) => (asOn(c) ? runOrNull(c) : asField(c, 'asEnabled')),
      check: (c) => baseRate(c) === BASE && asOn(c) && target(c) === T_DEFAULT && live(c) === 2 && !spikeOn(c),
      hold: 10,
      settle: 2,
      measure: 'calm',
      feedback: (c) => {
        const k = m(c, 'calm');
        if (!k) return L('', '');
        return {
          zh: `它把实例从 3 个缩到了 2 个，CPU 利用率升到 ${fmtPct(k.cpu)}，接近目标 ${pct(T_DEFAULT)}，p95 ${fmtLatency(k.p95)}。少开一台，省了三分之一的钱。底部"事件"里能看到这次缩容。\n\n它的算法和 Kubernetes 的 HPA 一样：需要的实例数 = 向上取整（当前实例数 × 当前利用率 ÷ 目标利用率）。`,
          en: `It went from 3 instances to 2; CPU rose to ${fmtPct(k.cpu)}, close to the ${pct(T_DEFAULT)} target, with p95 ${fmtLatency(k.p95)}. One machine fewer, a third less money. The scale-down is in the Events tab at the bottom.\n\nIts rule is the one Kubernetes HPA uses: instances needed = round up (current instances × current utilization ÷ target utilization).`,
        };
      },
    },
    {
      id: 'spike',
      kind: 'do',
      title: L('流量尖峰', 'A traffic spike'),
      body: L(
        `点击"用户流量"，在右侧流量模型的"叠加层"里已经准备好一个"尖峰"：多出 ${EXTRA}/s、持续 ${HOLD} 秒。点它的"现在触发"，然后观察 45 秒，留意事件里什么时候扩容、微服务卡片上的新实例什么时候变成可用。`,
        `Click the traffic source. Under Overlays in its traffic model, a Spike is ready: ${EXTRA}/s extra for ${HOLD} seconds. Press its Fire now, then watch for 45 seconds: notice when Events says it scales up, and when the new instances on the service card become ready.`,
      ),
      highlight: (c) => (spikeOn(c) ? runOrNull(c) : clientField(c, '.tm-fire')),
      check: (c) => asOn(c) && target(c) === T_DEFAULT && spikeOn(c) && !!m(c, 'calm'),
      hold: 45,
      measure: 'spike',
      feedback: (c) => {
        const s = m(c, 'spike');
        if (!s) return L('', '');
        return {
          zh: `这 45 秒的可用性 ${fmtAvail(s.avail)}，p95 ${fmtLatency(s.p95)}。${reveal(c, 'predict-spike', s.avail, SPIKE_OPTIONS).zh}`,
          en: `Availability over these 45 seconds: ${fmtAvail(s.avail)}, p95 ${fmtLatency(s.p95)}. ${reveal(c, 'predict-spike', s.avail, SPIKE_OPTIONS).en}`,
        };
      },
    },
    {
      id: 'why-lag',
      kind: 'read',
      title: L('为什么跟不上', 'Why it lags behind'),
      body: L(
        `自动扩缩容是"事后反应"，从流量涨上来到新实例能干活，要走完这几步：\n\n• 发现：它每 ${PERIOD} 秒才看一次 CPU，最坏要等将近 ${PERIOD} 秒才发现。\n• 决定：算出要几个实例，开始创建。\n• 冷启动：新实例要拉镜像、启动进程、预热，${COLD} 秒后才能接流量。\n\n加起来，最快也要 ${PERIOD + COLD} 秒左右。这段时间里，原来的 2 个实例要扛 ${BASE + EXTRA}/s，CPU 早已打满，请求排队、超时、被拒绝。\n\n所以自动扩缩容管的是"几分钟级别"的变化，比如早晚高峰；对付不了秒级的突发。秒级突发要靠：平时留够余量（下一步就试）、限流和排队削峰、把冷启动做短（更小的镜像、预热好的实例池）、已知的高峰提前定时扩容（比如大促开始前）。`,
        `Autoscaling reacts after the fact. Between traffic rising and new instances doing work, it goes through:\n\n• Noticing: it only checks CPU every ${PERIOD} seconds, so it can take almost ${PERIOD} seconds to notice.\n• Deciding: it works out how many instances it needs and starts creating them.\n• Cold start: a new instance pulls its image, starts the process and warms up; it takes ${COLD} seconds before it can serve.\n\nAll together, about ${PERIOD + COLD} seconds at best. Meanwhile the 2 existing instances face ${BASE + EXTRA}/s with their CPUs maxed out: requests queue, time out, get turned away.\n\nSo autoscaling handles changes over minutes, like the morning and evening peaks, not bursts over seconds. For those you need: enough headroom all the time (the next step tries this), rate limiting and queues to flatten spikes, shorter cold starts (smaller images, a pool of warm instances), and scheduled scaling before peaks you know about (a sale starting at 8pm).`,
      ),
    },
    {
      id: 'predict-target',
      kind: 'predict',
      title: L('再预测', 'Predict again'),
      body: L(
        `把目标 CPU 利用率从 ${pct(T_DEFAULT)} 降到 ${pct(T_LOW)}，再来一次同样的尖峰，会怎样？`,
        `Lower the target CPU from ${pct(T_DEFAULT)} to ${pct(T_LOW)} and fire the same spike again. What happens?`,
      ),
      options: TARGET_OPTIONS,
    },
    {
      id: 'retune',
      kind: 'do',
      title: L('降低目标利用率', 'Lower the target'),
      body: L(
        `点击微服务，把"目标 CPU 利用率"改成 ${pct(T_LOW)}。然后等尖峰结束、实例数稳定下来（会停在 3 个）。`,
        `Click the service and set Target CPU utilization to ${pct(T_LOW)}. Then wait for the spike to end and the instance count to settle (it stops at 3).`,
      ),
      highlight: (c) => (target(c) === T_LOW ? runOrNull(c) : asField(c, 'asTarget')),
      check: (c) => baseRate(c) === BASE && asOn(c) && target(c) === T_LOW && live(c) === 3 && !spikeOn(c),
      hold: 10,
      settle: 2,
      measure: 'calm40',
      feedback: (c) => {
        const k = m(c, 'calm40');
        if (!k) return L('', '');
        return {
          zh: `平时稳定在 3 个实例，CPU ${fmtPct(k.cpu)}。比目标 ${pct(T_DEFAULT)} 时多开 1 台。`,
          en: `On a normal day it now keeps 3 instances, CPU at ${fmtPct(k.cpu)}: one more than with the ${pct(T_DEFAULT)} target.`,
        };
      },
    },
    {
      id: 'spike40',
      kind: 'do',
      title: L('再来一次尖峰', 'The spike again'),
      body: L(
        '点击"用户流量"，再点一次尖峰的"现在触发"，观察 45 秒。',
        'Click the traffic source, press the spike\'s Fire now again, and watch for 45 seconds.',
      ),
      highlight: (c) => (spikeOn(c) ? runOrNull(c) : clientField(c, '.tm-fire')),
      check: (c) => asOn(c) && target(c) === T_LOW && spikeOn(c) && !!m(c, 'calm40'),
      hold: 45,
      measure: 'spike40',
      feedback: (c) => {
        const a = m(c, 'spike'), b = m(c, 'spike40');
        if (!a || !b) return L('', '');
        return {
          zh: `这次可用性 ${fmtAvail(b.avail)}，p95 ${fmtLatency(b.p95)}（上次 ${fmtAvail(a.avail)}、${fmtLatency(a.p95)}）。${reveal(c, 'predict-target', b.avail, TARGET_OPTIONS).zh}\n\n平时多开的那 1 台就是余量：尖峰来时，3 个实例的 CPU 从 30% 左右涨到 80% 上下，忙但没打满，撑到新实例上线。代价是平时多付 50% 的机器钱（2 台变 3 台）。目标利用率就是在"突发时的余量"和"平时的成本"之间取舍；多数团队设在 50%–70%，流量越突发、冷启动越慢，设得越低。`,
          en: `Availability ${fmtAvail(b.avail)} this time, p95 ${fmtLatency(b.p95)} (last time ${fmtAvail(a.avail)} and ${fmtLatency(a.p95)}). ${reveal(c, 'predict-target', b.avail, TARGET_OPTIONS).en}\n\nThe extra instance is headroom: when the spike hits, 3 instances go from about 30% to around 80% CPU, busy but not maxed out, and hold on until new ones are up. The price is 50% more machines on a normal day (3 instead of 2). The target is a trade-off between headroom for bursts and cost on normal days; most teams pick 50%–70%, lower when traffic is spiky or cold starts are slow.`,
        };
      },
    },
    {
      id: 'floor',
      kind: 'do',
      title: L('最少实例数', 'The minimum'),
      body: L(
        `省钱时最容易犯的错，是把"最少实例"设得太低。最少 2 个时，半夜流量很低会缩到 2 个：这时挂一台，就只剩 1 个（第 3 课的单点问题）；早上流量开始爬坡，2 个实例要扛到新实例冷启动完，很容易跟不上。\n\n点击微服务，把"最少实例"改成 ${FLOOR}，保证任何时候挂一台还有 2 台（N+1）。`,
        `The easiest mistake when saving money is a minimum that is too low. With a minimum of 2, the service shrinks to 2 at night: lose one then and you are down to 1 (the single point of failure from lesson 3); and when traffic climbs in the morning, 2 instances must hold on until new ones finish their cold start, and often can't.\n\nClick the service and set Min instances to ${FLOOR}, so losing one always leaves 2 (N+1).`,
      ),
      highlight: (c) => (asMin(c) === FLOOR ? null : asField(c, 'asMin')),
      check: (c) => asOn(c) && asMin(c) === FLOOR,
    },
    {
      id: 'day',
      kind: 'do',
      title: L('一整天', 'A whole day'),
      body: L(
        `最后看自动扩缩容最擅长的事：跟着一天的高峰低谷走。\n\n点击"用户流量"，在流量模型的"基础模型"里选"日周期"，把"高峰"改成 ${PEAK}。这是压缩成 ${DAY / 60} 分钟的一天：从低谷爬到每秒 ${PEAK} 个请求，再回落。观察一整天（${DAY / 60} 分钟仿真时间，可以把速度调到 20× 少等一会儿）。`,
        `Last, what autoscaling is best at: following a day's peaks and troughs.\n\nClick the traffic source, choose Daily cycle under Base model in its traffic model, and set Peak to ${PEAK}. It is a day compressed into ${DAY / 60} minutes: from the trough up to ${PEAK} requests a second and back down. Watch a whole day (${DAY / 60} minutes of simulated time; set the speed to 20× to wait less).`,
      ),
      highlight: (c) => {
        if (baseKind(c) !== 'diurnal') return clientField(c, '[data-model="diurnal"]');
        if (program(c)?.base.p.peak !== PEAK) return clientField(c, '[data-param="tm-diurnal-peak"]');
        return runOrNull(c);
      },
      check: (c) => baseKind(c) === 'diurnal' && program(c)?.base.p.peak === PEAK && asOn(c) && target(c) === T_LOW && asMin(c) === FLOOR,
      hold: DAY,
      measure: 'day',
      feedback: (c) => {
        const d = m(c, 'day'), s = svc(c);
        const n = d && s ? d.nodes[s.id] : undefined;
        if (!d || !n) return L('', '');
        const saved = Math.max(0, Math.round((1 - n.inst / Math.max(1, n.instMax)) * 100));
        const fixed = Math.round(n.instMax * M7I_LARGE_MONTH);
        const auto = Math.round(n.inst * M7I_LARGE_MONTH);
        return {
          zh: `这一天里，实例数在 ${FLOOR} 到 ${n.instMax.toFixed(0)} 之间变化，平均 ${n.inst.toFixed(1)} 个，可用性 ${fmtAvail(d.avail)}。比按高峰固定开 ${n.instMax.toFixed(0)} 台省了约 ${saved}%。按第 3 课的价格（每台 m7i.large 约 $${M7I_LARGE_MONTH}/月），大约是每月 $${fixed} 和 $${auto} 的差别。\n\n这条压缩的"一天"里，高峰和低谷各占一半时间；真实业务的夜间低谷往往更长、更深，省得更多。`,
          en: `Over this day the instance count moved between ${FLOOR} and ${n.instMax.toFixed(0)}, averaging ${n.inst.toFixed(1)}, with ${fmtAvail(d.avail)} availability: about ${saved}% less than keeping ${n.instMax.toFixed(0)} running for the peak. At lesson 3's prices (an m7i.large at about $${M7I_LARGE_MONTH}/month), that is roughly $${fixed} against $${auto} a month.\n\nIn this compressed day, peak and trough take equal time; real nights are usually longer and quieter, so you save more.`,
        };
      },
    },
    {
      id: 'done',
      kind: 'read',
      title: L('小结', 'Wrap-up'),
      body: L(
        `记住四点：\n\n• 自动扩缩容是事后反应：发现要一个决策周期，新实例还要冷启动，加起来将近一分钟。它管得了早晚高峰，管不了秒级突发。\n• 目标利用率是余量和成本的取舍：设低一点，平时多花钱，突发时扛得住。\n• 最少实例数要满足 N+1，否则夜里挂一台就是单点，早上爬坡也跟不上。\n• 流量有高峰低谷时，它能省下可观的钱。\n\n调参时还要注意：\n• 扩容要快，缩容要慢。缩容稳定窗口设成 0，流量一波动实例数就来回抖，每次扩容都要再付一次冷启动。\n• 扩得了服务，扩不了下游。服务从 3 个扩到 10 个，连到数据库的连接池总数也变成 3 倍多（第 4 课），可能把数据库压垮。设"最多实例"时要算上下游扛得住多少。`,
        `Four things to remember:\n\n• Autoscaling reacts after the fact: one decision period to notice, then a cold start, close to a minute in all. It handles daily peaks, not bursts over seconds.\n• The target utilization trades headroom for cost: lower costs more on normal days and survives bursts.\n• The minimum must cover N+1, or losing one at night leaves a single point of failure and the morning climb outruns it.\n• When traffic has peaks and troughs, it saves real money.\n\nWhen tuning it, also:\n• Scale up fast, scale down slowly. With the scale-down stabilization at 0, the count flaps with every wobble in traffic, and every scale-up pays the cold start again.\n• You can scale the service, not what it depends on. Going from 3 to 10 instances multiplies the connection pools to the database by more than 3 (lesson 4) and can bring the database down. Set the maximum with what the downstream can take in mind.`,
      ),
    },
  ],
};
