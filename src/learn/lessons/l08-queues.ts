// Lesson 8: async work and message queues. Sending the email inside the request makes users wait
// for it; fire-and-forget is fast but silently loses work when the email service fails; a queue
// is fast and keeps the work. Under a spike the API stays fast while the backlog grows, and the
// consumers drain it at their own pace; more consumers help only up to the partition count.
import { blankTopology, newEdge, newNode } from '../../engine/presets';
import { defaultLayer, isProgram, programFromLegacy, type TrafficLayer, type TrafficProgram } from '../../engine/traffic';
import { L, type EdgeCfg, type Lang, type NodeCfg, type Topology } from '../../engine/types';
import { fmtAvail, fmtCount, fmtLatency, fmtPct } from '../../ui/format';
import type { BarGroup, Lesson, LessonCtx, Measure, PredictOption } from '../types';
import { reveal } from '../helpers';

const BASE = 50; // orders per second
const EXTRA = 100; // the spike adds this: 150/s for a minute
const HOLD = 60;
const CONSUMERS = 6; // about 10 messages/s each: 60/s in all, just above BASE
const PARTITIONS = 12;
const MANY = 24;
const EMAIL_FAIL = 0.3; // the error spike's default rate

const m = (c: LessonCtx, k: string): Measure | undefined => c.meas[k];
const byName = (c: LessonCtx, type: string, i: number): NodeCfg | undefined =>
  c.topo.nodes.filter((n) => n.type === type).sort((a, b) => a.x - b.x)[i];
const orders = (c: LessonCtx) => byName(c, 'service', 0);
const email = (c: LessonCtx) => byName(c, 'service', 1);
const kafka = (c: LessonCtx) => byName(c, 'queue', 0);
const edge = (c: LessonCtx, from?: NodeCfg, to?: NodeCfg): EdgeCfg | undefined =>
  from && to ? c.topo.edges.find((e) => e.from === from.id && e.to === to.id) : undefined;
const direct = (c: LessonCtx) => edge(c, orders(c), email(c));
const produce = (c: LessonCtx) => edge(c, orders(c), kafka(c));
const consume = (c: LessonCtx) => edge(c, kafka(c), email(c));
const consumers = (c: LessonCtx) => Number(kafka(c)?.params.consumers ?? CONSUMERS);
const partitions = (c: LessonCtx) => Number(kafka(c)?.params.partitions ?? PARTITIONS);
/** Orders sends the email through the queue only. */
const viaQueue = (c: LessonCtx) => !direct(c) && !!produce(c) && !!consume(c);

const program = (c: LessonCtx): TrafficProgram | null => {
  const client = c.topo.nodes.find((n) => n.type === 'client');
  if (!client) return null;
  return isProgram(client.params.traffic) ? client.params.traffic : programFromLegacy(client.params);
};
const baseRate = (c: LessonCtx) => {
  const b = program(c)?.base;
  return b?.kind === 'constant' ? b.p.rps : NaN;
};
const spike = (c: LessonCtx): TrafficLayer | undefined => program(c)?.overlays.find((o) => o.kind === 'spike');
const spikeOn = (c: LessonCtx) => {
  const s = spike(c);
  if (!s) return false;
  const end = s.p.at + s.p.rise + s.p.hold + s.p.fall;
  return c.now >= s.p.at && c.now < end;
};

/** The email service's error spike that is on now, if any. */
const errFault = (c: LessonCtx) => {
  const e = email(c);
  return e ? c.failures.find((x) => x.nodeId === e.id && x.kind === 'errorSpike' && (x.end < 0 || x.end > c.now * 1000)) : undefined;
};

/** Live queue figures from the latest second. */
const liveLag = (c: LessonCtx) => { const q = kafka(c); return q ? c.latest?.nodes[q.id]?.extra.lag ?? 0 : 0; };
const liveDelay = (c: LessonCtx) => { const q = kafka(c); return q ? c.latest?.nodes[q.id]?.mean ?? NaN : NaN; };

const nm = (mm: Measure | undefined, n: NodeCfg | undefined) => (mm && n ? mm.nodes[n.id] : undefined);

const runOrNull = (c: LessonCtx) => (c.running ? null : '[data-learn="run"]');
const nodeField = (c: LessonCtx, n: NodeCfg | undefined, sel: string) =>
  !n ? null : c.selection?.kind === 'node' && c.selection.id === n.id ? `.inspector ${sel}` : `.react-flow__node[data-id="${n.id}"] .sn`;
const edgeField = (c: LessonCtx, e: EdgeCfg | undefined, sel: string) =>
  !e ? null : c.selection?.kind === 'edge' && c.selection.id === e.id ? `.inspector ${sel}` : `.fe-label[data-edge="${e.id}"]`;
const clientField = (c: LessonCtx, sel: string) =>
  (c.selection?.kind === 'node' && c.selection.id === 'client' ? `.inspector ${sel}` : '.react-flow__node[data-id="client"] .sn');

const SPIKE_OPTIONS: PredictOption[] = [
  // the measured value is the API's p95 during the spike divided by its p95 before
  { label: L('接口也明显变慢，p95 翻倍以上', 'The API slows down too: p95 more than doubles'), range: [2, Infinity] },
  { label: L('接口基本不受影响', 'The API hardly notices'), range: [-Infinity, 2] },
];
const SCALE_OPTIONS: PredictOption[] = [
  // the measured value is messages consumed per second with 24 consumers, divided by the rate with 6
  { label: L('大约快 4 倍', 'About 4 times faster'), range: [3, Infinity] },
  { label: L('大约快 2 倍', 'About twice as fast'), range: [1.5, 3] },
  { label: L('几乎没变化', 'Hardly any faster'), range: [-Infinity, 1.5] },
];

function make(lang: Lang): Topology {
  const topo = blankTopology(lang);
  topo.name = L('第 8 课：异步与消息队列', 'Lesson 8: async and message queues')[lang];
  const client = topo.nodes[0];
  const prog: TrafficProgram = {
    base: defaultLayer('constant', { rps: BASE }),
    overlays: [defaultLayer('spike', { at: 7200, extra: EXTRA, rise: 2, hold: HOLD, fall: 5 })],
  };
  client.params = { ...client.params, rps: BASE, traffic: prog };
  const o = newNode('service', client.x + 320, client.y, topo.nodes, lang);
  o.name = L('订单服务', 'Orders')[lang];
  o.params = { ...o.params, instances: 2 };
  topo.nodes.push(o);
  const em = newNode('service', client.x + 980, client.y, topo.nodes, lang);
  em.name = L('邮件服务', 'Email')[lang];
  // sending an email is mostly waiting on the mail provider: about 95ms on average, little CPU
  em.params = { ...em.params, instances: 2, serviceTime: { dist: 'lognormal', median: 80, p99: 300 }, cpuFraction: 0.1 };
  topo.nodes.push(em);
  const q = newNode('queue', client.x + 650, client.y + 190, topo.nodes, lang);
  q.name = 'Kafka';
  q.params = { ...q.params, partitions: PARTITIONS, consumers: CONSUMERS };
  topo.nodes.push(q);
  topo.edges.push(newEdge(client, o, topo.edges));
  topo.edges.push(newEdge(o, em, topo.edges));
  topo.edges.push(newEdge(q, em, topo.edges));
  return topo;
}

function bars(c: LessonCtx): BarGroup[] {
  const groups: BarGroup[] = [];
  const s = m(c, 'sync'), f = m(c, 'ff'), q = m(c, 'mq');
  if (s && f && q) {
    groups.push({
      title: L('用户看到的 p95', 'p95 as users see it'),
      rows: [
        { label: L('同步发邮件', 'Email sent in the request'), value: s.p95, text: fmtLatency(s.p95), bad: true },
        { label: L('发后不管', 'Fire and forget'), value: f.p95, text: fmtLatency(f.p95) },
        { label: L('写入消息队列', 'Through the queue'), value: q.p95, text: fmtLatency(q.p95) },
      ],
    });
  }
  const sp = m(c, 'spike'), many = m(c, 'many');
  const k = kafka(c);
  if (sp && many && k) {
    const a = sp.nodes[k.id]?.out ?? 0, b = many.nodes[k.id]?.out ?? 0;
    groups.push({
      title: L('积压时每秒消费的消息', 'Messages consumed per second with a backlog'),
      rows: [
        { label: L(`${CONSUMERS} 个消费者`, `${CONSUMERS} consumers`), value: a, text: `${Math.round(a)}/s` },
        { label: L(`${MANY} 个消费者（${PARTITIONS} 个分区）`, `${MANY} consumers (${PARTITIONS} partitions)`), value: b, text: `${Math.round(b)}/s` },
      ],
    });
  }
  return groups;
}

export const lesson08: Lesson = {
  id: 'l08-queues',
  num: 8,
  title: L('异步与消息队列', 'Async and message queues'),
  summary: L('不用等的事就别让用户等；接口很快的时候，积压可能正在悄悄增长。', 'Don’t make users wait for work they needn’t wait for; while the API is fast, the backlog may be quietly growing.'),
  minutes: 16,
  speed: 5,
  make,
  bars,
  steps: [
    {
      id: 'sync',
      kind: 'do',
      title: L('先看同步', 'The synchronous way first'),
      body: L(
        `每秒 ${BASE} 个下单请求。订单服务处理完，要调邮件服务发一封确认邮件；邮件服务要等邮件服务商回复，平均将近 100ms。现在是同步调用：邮件发完，才给用户返回"下单成功"。\n\n下面那个 Kafka 已经放好，也和邮件服务连上了（邮件服务是它的消费者），只是现在还没人往里写。先别管它。\n\n点"运行"，观察 15 秒，留意"用户流量"卡片上的 p95。`,
        `${BASE} orders a second. When Orders is done, it calls the email service to send a confirmation; that service waits for the mail provider, close to 100ms on average. The call is synchronous: users only get "order placed" once the email is sent.\n\nThe Kafka below is already in place and connected to the email service (which consumes from it), but nothing writes to it yet. Leave it for now.\n\nPress Run and watch for 15 seconds; keep an eye on p95 on the traffic source's card.`,
      ),
      highlight: runOrNull,
      check: (c) => baseRate(c) === BASE && !!direct(c) && !direct(c)?.params.async && !produce(c) && !spikeOn(c),
      hold: 15,
      settle: 3,
      measure: 'sync',
      feedback: (c) => {
        const s = m(c, 'sync');
        if (!s) return L('', '');
        return {
          zh: `用户看到的 p95 是 ${fmtLatency(s.p95)}，其中大半时间花在等邮件上。可用户点"下单"时，要的只是"订单成功了"；**邮件晚几秒到，根本没人在意**。`,
          en: `Users see a p95 of ${fmtLatency(s.p95)}, most of it waiting for the email. Yet when users press "Place order", all they need to know is that the order went through; **nobody minds an email arriving a few seconds later**.`,
        };
      },
    },
    {
      id: 'ff',
      kind: 'do',
      title: L('发后不管', 'Fire and forget'),
      body: L(
        '最省事的办法：调用邮件服务，但不等它回复。点击"订单服务 → 邮件服务"这条线，打开"异步（不等待结果）"开关，观察 15 秒。',
        'The quickest fix: call the email service without waiting for its reply. Click the Orders → Email line, switch on "Async (fire and forget)", and watch for 15 seconds.',
      ),
      highlight: (c) => (direct(c)?.params.async ? runOrNull(c) : edgeField(c, direct(c), '[data-param="async"]')),
      check: (c) => baseRate(c) === BASE && !!direct(c)?.params.async && !produce(c) && !spikeOn(c) && !!m(c, 'sync'),
      hold: 15,
      settle: 3,
      measure: 'ff',
      feedback: (c) => {
        const s = m(c, 'sync'), f = m(c, 'ff');
        if (!s || !f) return L('', '');
        return {
          zh: `p95 从 ${fmtLatency(s.p95)} 降到 ${fmtLatency(f.p95)}。看起来问题解决了。`,
          en: `p95 dropped from ${fmtLatency(s.p95)} to ${fmtLatency(f.p95)}. Looks solved.`,
        };
      },
    },
    {
      id: 'lost',
      kind: 'do',
      title: L('邮件服务出错了', 'The email service fails'),
      body: L(
        `点击邮件服务，在右侧"故障注入"里找到"错误率飙升"，保持默认（${fmtPct(EMAIL_FAIL)} 的请求失败，持续 30 秒），点"注入"。观察 20 秒，对比"用户流量"卡片上的可用性和邮件服务卡片上的错误率。`,
        `Click the email service, find Error spike under Fault injection on the right, keep the defaults (${fmtPct(EMAIL_FAIL)} of requests fail, for 30 seconds) and press Inject. Watch for 20 seconds; compare availability on the traffic source's card with the error rate on the email service's card.`,
      ),
      highlight: (c) => (errFault(c) ? runOrNull(c) : nodeField(c, email(c), '[data-fault="errorSpike"]')),
      check: (c) => !!direct(c)?.params.async && !produce(c) && !!errFault(c) && !!m(c, 'ff'),
      hold: 20,
      settle: 3,
      measure: 'lost',
      feedback: (c) => {
        const l = m(c, 'lost'), e = nm(m(c, 'lost'), email(c));
        if (!l || !e) return L('', '');
        const share = e.arr > 0 ? e.err / e.arr : 0;
        return {
          zh: `用户看到的可用性 ${fmtAvail(l.avail)}，一切正常；可邮件服务每秒有 ${e.err.toFixed(0)} 封邮件发送失败（约 ${fmtPct(share)}）。订单服务没在等结果，也就不知道失败了：**这些邮件就这么丢了，没有重试，也没有记录**。\n\n**发后不管只适合丢了也无所谓的事**，比如打点日志。确认邮件、扣库存、通知仓库发货，这些事不能丢。`,
          en: `Users see ${fmtAvail(l.avail)} availability, all fine; yet ${e.err.toFixed(0)} emails a second fail at the email service (about ${fmtPct(share)}). Orders isn't waiting for the result, so it never learns of it: **those emails are simply gone, never retried and never recorded**.\n\n**Fire and forget only suits work you can afford to lose**, such as analytics events. Confirmation emails, stock updates and shipping requests can't be lost.`,
        };
      },
    },
    {
      id: 'why-queue',
      kind: 'read',
      title: L('消息队列', 'Message queues'),
      body: L(
        `**消息队列（Kafka、RabbitMQ、SQS 这些）就是在中间放一个可靠的"收件箱"**：\n\n• 订单服务（生产者）只要把"给这个订单发邮件"这条消息写进队列，几毫秒就能返回，不用等邮件发完。\n• **消息写进去就落盘保存**，邮件服务暂时挂了也不会丢。\n• 邮件服务（消费者）按自己的节奏去取消息、处理。失败了可以重试；重试几次还失败，就放进"**死信队列"（DLQ）**，等人排查后再补发。\n\n**两边从此解耦**：生产者不用管消费者快慢、在不在线；消费者也不会被突然涌来的流量冲垮。`,
        `**A message queue (Kafka, RabbitMQ, SQS…) puts a reliable inbox in between**:\n\n• Orders (the producer) only writes a message, "send the email for this order", to the queue, and returns in a few milliseconds without waiting for the email.\n• **Once written, the message is stored on disk**; it survives the email service being down for a while.\n• The email service (the consumer) takes messages at its own pace and processes them. A failure can be retried; one that keeps failing goes to a **dead-letter queue (DLQ)** to be investigated and replayed.\n\n**The two sides are now decoupled**: the producer doesn't care how fast the consumer is, or whether it is up; the consumer isn't flattened by a sudden flood.`,
      ),
    },
    {
      id: 'rewire',
      kind: 'do',
      title: L('改成写消息队列', 'Send through the queue'),
      body: L(
        '等上一步的故障结束（30 秒），然后把调用改走队列：\n\n• 点击"订单服务 → 邮件服务"这条线，点右上角的垃圾桶删掉它（或者按 Delete 键）。\n• 按住订单服务右边的小圆点，拖到 Kafka 上，连成一条线。\n\n观察 20 秒。',
        'Once the fault from the last step is over (30 seconds), route the call through the queue:\n\n• Click the Orders → Email line and delete it with the bin icon at the top right (or press Delete).\n• Drag from the small dot on the right of Orders onto Kafka to connect them.\n\nWatch for 20 seconds.',
      ),
      highlight: (c) => {
        const d = direct(c);
        if (d) return c.selection?.kind === 'edge' && c.selection.id === d.id ? '.inspector [data-learn="del-edge"]' : `.fe-label[data-edge="${d.id}"]`;
        const o = orders(c);
        if (!produce(c) && o) return `.react-flow__node[data-id="${o.id}"] .react-flow__handle-right`;
        return runOrNull(c);
      },
      check: (c) => baseRate(c) === BASE && viaQueue(c) && !errFault(c) && consumers(c) === CONSUMERS && partitions(c) === PARTITIONS && !spikeOn(c) && !!m(c, 'lost'),
      hold: 20,
      settle: 5,
      measure: 'mq',
      feedback: (c) => {
        const s = m(c, 'sync'), q = m(c, 'mq'), k = nm(m(c, 'mq'), kafka(c));
        if (!s || !q || !k) return L('', '');
        return {
          zh: `用户看到的 p95 是 ${fmtLatency(q.p95)}（同步时 ${fmtLatency(s.p95)}），多出的只是写一次 Kafka 的几毫秒。Kafka 卡片上，每秒写入和消费都是 ${Math.round(k.out)} 条左右，积压 ${fmtCount(k.lag)} 条：进多少，出多少。从下单到邮件发出，平均 ${fmtLatency(k.lat)}。\n\n**这个"端到端延迟"才是邮件的真实体验，它不会出现在接口的 p95 里**。`,
          en: `Users see a p95 of ${fmtLatency(q.p95)} (synchronous: ${fmtLatency(s.p95)}); the extra is just the few milliseconds to write to Kafka. On the Kafka card, about ${Math.round(k.out)} messages a second go in and come out, with a backlog of ${fmtCount(k.lag)}: as many out as in. From order to email sent takes ${fmtLatency(k.lat)} on average.\n\n**That end-to-end delay is what the email actually feels like, and it never shows up in the API's p95**.`,
        };
      },
    },
    {
      id: 'predict-spike',
      kind: 'predict',
      title: L('先预测', 'Predict first'),
      body: L(
        `${CONSUMERS} 个消费者，每个大约每秒处理 10 条，合计每秒 60 条左右，比平时的 ${BASE} 条略多。\n\n现在下单量突然涨到每秒 ${BASE + EXTRA} 个，持续 1 分钟。接口（用户看到的 p95）会怎样？`,
        `${CONSUMERS} consumers handle about 10 messages a second each, roughly 60 a second in all, a little more than the usual ${BASE}.\n\nNow orders suddenly jump to ${BASE + EXTRA} a second for a minute. What happens to the API (the p95 users see)?`,
      ),
      options: SPIKE_OPTIONS,
    },
    {
      id: 'spike',
      kind: 'do',
      title: L('流量尖峰', 'A traffic spike'),
      body: L(
        `点击"用户流量"，在流量模型的"叠加层"里，已经准备好一个"尖峰"：每秒多 ${EXTRA} 个、持续 ${HOLD} 秒。点它的"现在触发"，观察 1 分钟，留意 Kafka 卡片上的积压，以及邮件服务每秒收到多少请求。`,
        `Click the traffic source. Under Overlays in its traffic model, a Spike is ready: ${EXTRA} a second extra for ${HOLD} seconds. Press its Fire now and watch for a minute: keep an eye on the backlog on the Kafka card, and on how many requests a second reach the email service.`,
      ),
      highlight: (c) => (spikeOn(c) ? runOrNull(c) : clientField(c, '.tm-fire')),
      check: (c) => viaQueue(c) && consumers(c) === CONSUMERS && spikeOn(c) && !!m(c, 'mq'),
      hold: HOLD,
      measure: 'spike',
      feedback: (c) => {
        const q = m(c, 'mq'), sp = m(c, 'spike'), e = nm(m(c, 'spike'), email(c));
        if (!q || !sp || !e) return L('', '');
        const r = reveal(c, 'predict-spike', sp.p95 / Math.max(1, q.p95), SPIKE_OPTIONS);
        return {
          zh: `尖峰期间接口 p95 是 ${fmtLatency(sp.p95)}（平时 ${fmtLatency(q.p95)}）。${r.zh}\n\n可积压已经涨到 ${fmtCount(liveLag(c))} 条。邮件服务一直按自己的节奏，每秒处理 ${Math.round(e.arr)} 条左右；多出来的消息都存在 Kafka 里排队，**这叫"削峰填谷"**。`,
          en: `During the spike the API's p95 was ${fmtLatency(sp.p95)} (normally ${fmtLatency(q.p95)}). ${r.en}\n\nBut the backlog has grown to ${fmtCount(liveLag(c))} messages. The email service kept its own pace, about ${Math.round(e.arr)} a second; everything extra is waiting in Kafka. **This is called load leveling**: the queue flattens the peak.`,
        };
      },
    },
    {
      id: 'lag',
      kind: 'read',
      title: L('接口很快，不等于没问题', 'A fast API doesn’t mean all is well'),
      body: (c) => {
        const lag = liveLag(c), delay = liveDelay(c);
        const k = nm(m(c, 'spike'), kafka(c));
        const out = k ? k.out : 60;
        const net = Math.max(1, out - BASE);
        const mins = Math.max(1, Math.round(lag / net / 60));
        const wait = Math.round(lag / Math.max(1, out));
        const delayZh = isFinite(delay) ? `此刻发出的邮件已经比下单晚了 ${fmtLatency(delay)}，而且还在变晚。` : '';
        const delayEn = isFinite(delay) ? `Emails going out right now are already ${fmtLatency(delay)} behind their orders, and falling further behind.` : '';
        return {
          zh: `尖峰过去了，接口一直很快，监控上的 p95 一片绿。可是：\n\n• 积压现在是 ${fmtCount(lag)} 条。消费速度每秒约 ${Math.round(out)} 条，平时每秒进来 ${BASE} 条，每秒只能净消化 ${Math.round(net)} 条：清空要 ${fmtCount(lag)} ÷ ${Math.round(net)} ≈ ${mins} 分钟。\n• 新下的单要排在这 ${fmtCount(lag)} 条后面，大约等 ${fmtCount(lag)} ÷ ${Math.round(out)} ≈ ${wait} 秒，邮件才会发出（第 2 课的利特尔定律：排队数 = 速率 × 等待时间）。${delayZh}\n\n所以用了队列，**要监控的不只是接口，还有积压（consumer lag）和端到端延迟**。真实系统里，积压持续上涨就该报警：消费者跟不上了。\n\n如果邮件是"验证码"，晚一分钟到，用户早就走了。**异步解决的是"不让用户等"，不是"让工作变少"**：消费能力不够，工作只是换了个地方排队。`,
          en: `The spike is over; the API stayed fast throughout, and p95 on the dashboard is all green. However:\n\n• The backlog is ${fmtCount(lag)} messages. Consumers manage about ${Math.round(out)} a second while ${BASE} keep arriving, so they gain only ${Math.round(net)} a second: clearing it takes ${fmtCount(lag)} ÷ ${Math.round(net)} ≈ ${mins} minutes.\n• A new order queues behind those ${fmtCount(lag)} messages, waiting about ${fmtCount(lag)} ÷ ${Math.round(out)} ≈ ${wait} seconds for its email (Little's law from lesson 2: queue length = rate × wait). ${delayEn}\n\nSo with a queue, **watch more than the API: watch the backlog (consumer lag) and the end-to-end delay**. In production, a backlog that keeps rising should page someone: the consumers can't keep up.\n\nIf the email were a login code, a minute late means the user is long gone. **Async stops users waiting; it doesn't make the work smaller**. Without enough consuming capacity, the work just queues somewhere else.`,
        };
      },
    },
    {
      id: 'predict-scale',
      kind: 'predict',
      title: L('再预测', 'Predict again'),
      body: L(
        `要更快清掉积压，最直接的办法是加消费者。把消费者从 ${CONSUMERS} 个加到 ${MANY} 个（4 倍），消费速度会怎样？`,
        `The obvious way to clear the backlog faster is more consumers. Going from ${CONSUMERS} to ${MANY} consumers (4 times as many), how much faster will messages be consumed?`,
      ),
      options: SCALE_OPTIONS,
    },
    {
      id: 'many',
      kind: 'do',
      title: L('加消费者', 'More consumers'),
      body: L(
        `点击 Kafka，把"消费者数"改成 ${MANY}，观察 20 秒，留意 Kafka 卡片上每秒消费多少条，以及底部"事件"里出现了什么。`,
        `Click Kafka, set Consumers to ${MANY}, and watch for 20 seconds: keep an eye on how many messages a second the Kafka card says are consumed, and on what appears in the Events tab at the bottom.`,
      ),
      highlight: (c) => (consumers(c) === MANY ? runOrNull(c) : nodeField(c, kafka(c), '[data-param="consumers"]')),
      check: (c) => viaQueue(c) && consumers(c) === MANY && partitions(c) === PARTITIONS && !spikeOn(c) && liveLag(c) > 300 && !!m(c, 'spike'),
      hold: 20,
      settle: 12,
      measure: 'many',
      feedback: (c) => {
        const k = kafka(c);
        const a = k ? m(c, 'spike')?.nodes[k.id]?.out ?? 0 : 0, b = k ? m(c, 'many')?.nodes[k.id]?.out ?? 0 : 0;
        if (!a || !b) return L('', '');
        const r = reveal(c, 'predict-scale', b / a, SCALE_OPTIONS);
        return {
          zh: `现在每秒消费 ${Math.round(b)} 条，之前 ${Math.round(a)} 条，只快了 ${(b / a).toFixed(1)} 倍。${r.zh}\n\n事件里有两条线索：一是消费组"rebalance"，暂停了 10 秒，这期间一条都没消费；二是"有效消费者 ${PARTITIONS}"，不是 ${MANY}。`,
          en: `Now ${Math.round(b)} messages a second, up from ${Math.round(a)}: only ${(b / a).toFixed(1)} times as fast. ${r.en}\n\nEvents holds two clues: the consumer group "rebalanced" and paused for 10 seconds, consuming nothing meanwhile; and it reports "${PARTITIONS} active consumers", not ${MANY}.`,
        };
      },
    },
    {
      id: 'partitions',
      kind: 'read',
      title: L('分区决定并行度', 'Partitions set the parallelism'),
      body: L(
        `Kafka 把一个主题分成若干分区，每个分区同一时刻只能由消费组里的一个消费者读，这样才能保证同一分区内的消息按顺序处理（比如同一个订单的"已下单""已付款"不会颠倒）。\n\n所以：**有效并行度 = min(消费者数, 分区数)**。这里只有 ${PARTITIONS} 个分区，加到 ${MANY} 个消费者，多出来的 ${MANY - PARTITIONS} 个只能闲着，白白占机器。\n\n几条经验：\n• **分区数要提前规划**，按预计最多需要的消费者数，再留些余量。事后再加分区，消息按 key 分到哪个分区会变，顺序保证就乱了。\n• **消费者数量一变，整个消费组就要 rebalance**，暂停消费一段时间。不要让消费者频繁上下线，用自动扩缩容管消费者时也要注意。\n• **消费者加多了，压力就转到下游**：现在邮件服务每秒要处理的邮件翻了一倍。如果下游是数据库或者有配额的邮件服务商，队列原本帮它挡住的洪峰，又被你放了进去。`,
        `Kafka splits a topic into partitions, and within a consumer group each partition is read by just one consumer at a time. That keeps messages in a partition in order (so "order placed" and "order paid" for the same order never swap).\n\nSo **the effective parallelism = min(consumers, partitions)**. With only ${PARTITIONS} partitions, ${MANY} consumers leave ${MANY - PARTITIONS} sitting idle, taking up machines for nothing.\n\nRules of thumb:\n• **Plan the partition count ahead**: the most consumers you expect to need, plus some room. Adding partitions later changes which partition each key goes to, and breaks the ordering.\n• **Whenever the number of consumers changes, the whole group rebalances** and stops consuming for a while. Don't let consumers come and go often; take care when autoscaling them.\n• **More consumers shift the load downstream**: the email service now handles twice as many emails a second. If the downstream is a database, or a mail provider with a quota, you have let back in the flood the queue was holding off.`,
      ),
    },
    {
      id: 'drain',
      kind: 'do',
      title: L('清空积压', 'Clear the backlog'),
      body: L(
        `把"消费者数"改回 ${PARTITIONS}，和分区数一样，不养闲人。然后等积压清空（降到 50 条以下）。`,
        `Set Consumers to ${PARTITIONS}, matching the partitions, so none sit idle. Then wait for the backlog to clear (under 50 messages).`,
      ),
      highlight: (c) => (consumers(c) === PARTITIONS ? runOrNull(c) : nodeField(c, kafka(c), '[data-param="consumers"]')),
      check: (c) => viaQueue(c) && consumers(c) === PARTITIONS && partitions(c) === PARTITIONS && liveLag(c) < 50 && !!m(c, 'many'),
      hold: 5,
      feedback: (c) => {
        const d = liveDelay(c);
        return {
          zh: `积压清空了${isFinite(d) ? `，从下单到发邮件又回到 ${fmtLatency(d)}` : ''}。消费者和分区一样多，没有闲着的，平时消费能力也有每秒 120 条左右，下一次同样的尖峰，积压很快就能消化掉。`,
          en: `The backlog is gone${isFinite(d) ? `, and order-to-email is back to ${fmtLatency(d)}` : ''}. With as many consumers as partitions, none sit idle, and there is capacity for about 120 a second: the next spike like this one will be cleared quickly.`,
        };
      },
    },
    {
      id: 'done',
      kind: 'read',
      title: L('小结', 'Wrap-up'),
      body: L(
        `记住五点：\n\n• **用户不需要等的事（发邮件、发通知、生成报表），不要放在请求里同步做**。\n• **发后不管很快，但失败了没人知道**，只适合丢了也无所谓的事。不能丢的事交给消息队列：落盘保存、失败重试、进死信队列。\n• **队列能削峰**：流量突增时接口照样快，下游按自己的节奏消费。代价是积压和延迟，要监控积压和端到端延迟，不能只看接口 p95。\n• **消费能力 = min(消费者数, 分区数) × 每个消费者的速度**。分区要提前规划；消费者加多了，压力会转到下游。\n• **什么时候不该异步**：用户必须马上知道结果的事，比如支付是否成功、库存够不够。\n\n还有一点这里没演示：消息队列一般保证**"至少一次"投递**，重试和 rebalance 都可能让同一条消息被处理两次。**消费者要做成幂等的**（比如按订单号去重），否则用户会收到两封邮件，或者被扣两次钱。`,
        `Five things to remember:\n\n• **Work users needn't wait for (emails, notifications, reports) doesn't belong inside the request**.\n• **Fire and forget is fast, but failures go unnoticed**; use it only for work you can afford to lose. Work that mustn't be lost goes through a queue: stored on disk, retried, sent to a dead-letter queue.\n• **A queue levels load**: during a surge the API stays fast and the downstream consumes at its own pace. The price is a backlog and a delay, so watch consumer lag and end-to-end delay, not just the API's p95.\n• **Consuming capacity = min(consumers, partitions) × each consumer's rate**. Plan partitions ahead; more consumers push the load downstream.\n• **When not to go async**: whenever users must know the result at once, such as whether a payment went through or an item is in stock.\n\nOne more thing not shown here: queues usually **deliver "at least once"**, and retries and rebalances can hand the same message to a consumer twice. **Make consumers idempotent** (say, deduplicate by order ID), or users get two emails, or are charged twice.`,
      ),
    },
  ],
};
