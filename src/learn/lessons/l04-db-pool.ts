// Lesson 4: databases and connection pools. A service with idle CPU is slow because its threads wait
// for database connections; size the pool with Little's law; a bigger pool adds nothing; and when the
// database slows down, a small pool is what keeps it working.
import { blankTopology, newEdge, newNode } from '../../engine/presets';
import { L, type Lang, type Topology } from '../../engine/types';
import { fmtAvail, fmtLatency, fmtPct } from '../../ui/format';
import type { BarGroup, Lesson, LessonCtx, Measure, PredictOption } from '../types';
import { edgeBetween, firstOfType, mainService, reveal, trafficRate } from '../helpers';

const LOAD = 300; // 100/s per instance
const INSTANCES = 3;
const SMALL = 2; // below the ~2 connections each instance keeps busy, so requests wait for one
const FIX = 10;
const BIG = 100;
const SLOW = 2; // queries twice as slow: the database runs at its limit

const ln = (median: number, p99: number) => ({ dist: 'lognormal' as const, median, p99 });

const rps = trafficRate;
const db = (c: LessonCtx) => firstOfType(c, 'database');
const dbEdge = (c: LessonCtx) => edgeBetween(c, mainService(c), db(c));
const pool = (c: LessonCtx) => Number(dbEdge(c)?.params.poolSize ?? 20);
const m = (c: LessonCtx, k: string): Measure | undefined => c.meas[k];
const x = (v: number) => `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}×`;

const slowFault = (c: LessonCtx) => {
  const d = db(c);
  return d ? c.failures.find((f) => f.nodeId === d.id && f.kind === 'slowQuery' && (f.end < 0 || f.end > c.now * 1000)) : undefined;
};
const slowAtTwo = (c: LessonCtx) => slowFault(c)?.params.multiplier === SLOW;

/** Point at the pool field, selecting the service → database connection first. */
function pointAtPool(c: LessonCtx, target: number): string | null {
  const e = dbEdge(c);
  if (!e || pool(c) === target) return null;
  return c.selection?.kind === 'edge' && c.selection.id === e.id ? '.inspector [data-param="poolSize"]' : `.fe-label[data-edge="${e.id}"]`;
}
function pointAtDbFault(c: LessonCtx): string | null {
  const d = db(c);
  if (!d) return null;
  return c.selection?.kind === 'node' && c.selection.id === d.id ? '.inspector [data-fault="slowQuery"]' : `.react-flow__node[data-id="${d.id}"] .sn`;
}

/** Where the trouble shows up in a measurement: 0.5 = service CPU, 1.5 = the database, 2.5 = neither (waiting on connections). */
function bottleneckCode(c: LessonCtx, mm: Measure): number {
  const s = mainService(c), d = db(c);
  if (s && (mm.nodes[s.id]?.cpu ?? 0) >= 0.85) return 0.5;
  if (d && (mm.nodes[d.id]?.util ?? 0) >= 0.85) return 1.5;
  return 2.5;
}

const WHERE_OPTIONS: PredictOption[] = [
  { label: L('微服务的 CPU 不够', 'The service is short of CPU'), range: [0, 1] },
  { label: L('数据库本身忙不过来', 'The database itself is overloaded'), range: [1, 2] },
  { label: L('服务拿不到数据库连接', 'The service can\'t get database connections'), range: [2, 3] },
];
const BIG_OPTIONS: PredictOption[] = [
  // the measured value is p95(pool 100) ÷ p95(pool 10)
  { label: L('明显变快', 'Clearly faster'), range: [0, 0.8] },
  { label: L('差不多', 'About the same'), range: [0.8, 1.25] },
  { label: L('变慢', 'Slower'), range: [1.25, Infinity] },
];
const INCIDENT_OPTIONS: PredictOption[] = [
  // the measured value is availability(pool 10) − availability(pool 100)
  { label: L(`连接池 ${BIG} 扛得更好`, `Pool ${BIG} copes better`), range: [-Infinity, -0.15] },
  { label: L('差不多', 'About the same'), range: [-0.15, 0.15] },
  { label: L(`连接池 ${FIX} 扛得更好`, `Pool ${FIX} copes better`), range: [0.15, Infinity] },
];

function make(lang: Lang): Topology {
  const topo = blankTopology(lang);
  topo.name = L('第 4 课：数据库与连接池', 'Lesson 4: databases and connection pools')[lang];
  const client = topo.nodes[0];
  client.params = { ...client.params, rps: LOAD };
  const svc = newNode('service', client.x + 360, client.y, topo.nodes, lang);
  svc.params = { ...svc.params, instances: INSTANCES };
  const pg = newNode('database', svc.x + 360, svc.y, [...topo.nodes, svc], lang);
  pg.name = 'Postgres';
  pg.params = { ...pg.params, readTime: ln(15, 60), writeTime: ln(30, 120) };
  topo.nodes.push(svc, pg);
  topo.edges.push(newEdge(client, svc, topo.edges));
  const e = newEdge(svc, pg, topo.edges);
  e.params = { ...e.params, poolSize: SMALL };
  topo.edges.push(e);
  return topo;
}

function bars(c: LessonCtx): BarGroup[] {
  const groups: BarGroup[] = [];
  const b = m(c, 'base'), f = m(c, 'fix'), g = m(c, 'big');
  const p95Row = (mm: Measure, size: number) => ({ label: L(`连接池 ${size}`, `Pool ${size}`), value: mm.p95, text: fmtLatency(mm.p95), bad: mm.avail < 0.99 });
  // 2 vs 10 and 10 vs 100 in separate charts: the 2-second bar would flatten the other two
  if (b && f) groups.push({ title: L(`${LOAD}/s 时的 p95 延迟：连接池太小`, `p95 at ${LOAD}/s: pool too small`), rows: [p95Row(b, SMALL), p95Row(f, FIX)] });
  if (f && g) groups.push({ title: L(`${LOAD}/s 时的 p95 延迟：连接池再开大`, `p95 at ${LOAD}/s: an even bigger pool`), rows: [p95Row(f, FIX), p95Row(g, BIG)] });
  const hi = m(c, `q${BIG}`), lo = m(c, `q${FIX}`);
  if (hi && lo) groups.push({
    title: L(`数据库变慢 ${SLOW} 倍时的可用性`, `Availability with queries ${SLOW}× slower`),
    max: 1,
    rows: [
      { label: L(`连接池 ${BIG}`, `Pool ${BIG}`), value: hi.avail, text: fmtAvail(hi.avail), bad: hi.avail < 0.5 },
      { label: L(`连接池 ${FIX}`, `Pool ${FIX}`), value: lo.avail, text: fmtAvail(lo.avail), bad: lo.avail < 0.5 },
    ],
  });
  // while working through the lesson, show only the latest comparison; at the end, all of them
  return hi && lo ? groups : groups.slice(-1);
}

export const lesson04: Lesson = {
  id: 'l04-db-pool',
  num: 4,
  title: L('数据库与连接池', 'Databases and connection pools'),
  summary: L('服务 CPU 很闲，却因为等数据库连接而又慢又报错。用利特尔定律定连接池大小，再看看为什么连接池不是越大越好。', 'A service with idle CPU is slow and failing because it waits for database connections. Size the pool with Little\'s law, then see why a bigger pool isn\'t better.'),
  minutes: 10,
  speed: 5,
  make,
  bars,
  steps: [
    {
      id: 'predict-where',
      kind: 'predict',
      title: L('先预测', 'Predict first'),
      body: L(
        `起点已经搭好："用户流量"每秒发 ${LOAD} 个请求给一个有 ${INSTANCES} 个实例的微服务，每个请求都要查一次 Postgres。服务和数据库之间的连线上有一个**"连接池"：每个实例最多同时占用几个数据库连接**。\n\n运行起来后你会看到：微服务的 CPU 不到一半，用户请求却很慢，还在报错。先猜一下，问题最可能出在哪？`,
        `The starting point is ready: the traffic source sends ${LOAD} requests a second to a service with ${INSTANCES} instances, and every request runs one query on Postgres. The connection between the service and the database has a **connection pool: how many database connections each instance can use at once**.\n\nOnce it runs you will see the service using under half its CPU while user requests are slow and failing. Guess first: where is the problem most likely to be?`,
      ),
      options: WHERE_OPTIONS,
    },
    {
      id: 'base',
      kind: 'do',
      title: L('运行并观察', 'Run it and look'),
      body: L(
        '点"运行"，观察 20 秒。留意微服务卡片底部的条：它显示 CPU 和线程里更忙的那个；如果是线程更忙，旁边还会写出 CPU 是多少。',
        'Press Run and watch for 20 seconds. Look at the bar at the bottom of the service card: it shows whichever is busier, CPU or threads; when it is threads, the CPU figure is shown beside it.',
      ),
      highlight: (c) => (c.running ? null : '[data-learn="run"]'),
      check: (c) => rps(c) === LOAD && pool(c) === SMALL && !slowFault(c),
      hold: 20,
      settle: 5,
      measure: 'base',
      feedback: (c) => {
        const b = m(c, 'base'), s = mainService(c), d = db(c);
        if (!b || !s || !d) return L('', '');
        const sn = b.nodes[s.id], dn = b.nodes[d.id];
        const rejected = (b.causes.rejected ?? 0) > 1;
        return {
          zh: `微服务 CPU 只有 ${fmtPct(sn?.cpu ?? 0)}，线程却占满了（${fmtPct(sn?.util ?? 0)}）；数据库的执行利用率只有 ${fmtPct(dn?.util ?? 0)}。可用性 ${fmtAvail(b.avail)}，p95 ${fmtLatency(b.p95)}。${rejected ? '失败原因主要是"队列满拒绝"：线程都在等数据库连接，新请求连排队的位置都没有了。' : ''}\n\n${reveal(c, 'predict-where', bottleneckCode(c, b), WHERE_OPTIONS).zh}`,
          en: `Service CPU is only ${fmtPct(sn?.cpu ?? 0)}, yet its threads are full (${fmtPct(sn?.util ?? 0)}); the database is executing at only ${fmtPct(dn?.util ?? 0)}. Availability ${fmtAvail(b.avail)}, p95 ${fmtLatency(b.p95)}.${rejected ? ' Most failures are "Queue full": every thread is waiting for a database connection, so new requests have nowhere left to wait.' : ''}\n\n${reveal(c, 'predict-where', bottleneckCode(c, b), WHERE_OPTIONS).en}`,
        };
      },
    },
    {
      id: 'little',
      kind: 'read',
      title: L('连接池该多大', 'How big should the pool be'),
      body: (c) => {
        const b = m(c, 'base'), d = db(c);
        const q = b && d ? b.nodes[d.id]?.lat ?? 0 : 0;
        const per = LOAD / INSTANCES;
        const need = (per * q) / 1000;
        const ok = q > 0;
        return {
          zh: `每个请求在等连接的时候，一直占着服务的一个线程。连接不够，线程就被一个个占住；**线程占满了，CPU 再闲也接不了新请求**。\n\n需要多少连接，可以用第 2 课学过的利特尔定律（L = λ × W）算：**同时在用的连接数 ≈ 每秒查询数 × 每次查询的时间**。${ok ? `每个实例每秒查 ${per} 次，刚才测到每次查询约 ${fmtLatency(q)}，所以平均要 ${per} × ${fmtLatency(q)} ≈ ${need.toFixed(1)} 个连接同时在用。` : ''}连接池只有 ${SMALL} 个，${ok && need > SMALL ? '平均都不够，' : ''}再加上请求是随机到达的，经常一下子来好几个，就只能排队。\n\n所以**连接池要按平均值再留几倍余量**。下一步把它设成 ${FIX}。`,
          en: `While a request waits for a connection it keeps one of the service's threads. With too few connections the threads fill up one by one, and **once they are all taken the service can't accept new requests however idle its CPU is**.\n\nLittle's law from lesson 2 (L = λ × W) tells you how many connections you need: **connections in use ≈ queries per second × time per query**. ${ok ? `Each instance runs ${per} queries a second and you measured about ${fmtLatency(q)} per query, so on average ${per} × ${fmtLatency(q)} ≈ ${need.toFixed(1)} connections are in use at once.` : ''} The pool has only ${SMALL}${ok && need > SMALL ? ', not even enough on average,' : ''} and requests arrive at random, often several at once, so they queue.\n\nSo **size the pool at a few times the average**. Next, set it to ${FIX}.`,
        };
      },
    },
    {
      id: 'fix',
      kind: 'do',
      title: L('调大连接池', 'Enlarge the pool'),
      body: L(
        `点击微服务和 Postgres 之间那条连线上的标签，在右侧"连接池"分组里把"每实例连接池大小"改成 ${FIX}。保持运行，观察 20 秒。`,
        `Click the label on the line between the service and Postgres, and under Connection pool on the right set Pool size per instance to ${FIX}. Keep it running and watch for 20 seconds.`,
      ),
      highlight: (c) => pointAtPool(c, FIX) ?? (c.running ? null : '[data-learn="run"]'),
      check: (c) => rps(c) === LOAD && pool(c) === FIX && !slowFault(c),
      hold: 20,
      settle: 6,
      measure: 'fix',
      feedback: (c) => {
        const b = m(c, 'base'), f = m(c, 'fix'), s = mainService(c);
        if (!b || !f || !s) return L('', '');
        return {
          zh: `可用性 ${fmtAvail(f.avail)}，p95 从 ${fmtLatency(b.p95)} 降到 ${fmtLatency(f.p95)}，线程占用从 ${fmtPct(b.nodes[s.id]?.util ?? 0)} 降到 ${fmtPct(f.nodes[s.id]?.util ?? 0)}。**没加一台机器，只是让请求不再排队等连接**。`,
          en: `Availability ${fmtAvail(f.avail)}, p95 down from ${fmtLatency(b.p95)} to ${fmtLatency(f.p95)}, threads busy down from ${fmtPct(b.nodes[s.id]?.util ?? 0)} to ${fmtPct(f.nodes[s.id]?.util ?? 0)}. **Not a single machine added: requests just no longer queue for a connection**.`,
        };
      },
    },
    {
      id: 'predict-big',
      kind: 'predict',
      title: L('再预测', 'Predict again'),
      body: L(
        `既然调大有用，那把连接池再开大到 ${BIG} 呢？p95 会怎样？`,
        `If a bigger pool helped, what about ${BIG}? What happens to p95?`,
      ),
      options: BIG_OPTIONS,
    },
    {
      id: 'big',
      kind: 'do',
      title: L('开到很大', 'Make it huge'),
      body: L(`把"每实例连接池大小"改成 ${BIG}，观察 20 秒。`, `Set Pool size per instance to ${BIG} and watch for 20 seconds.`),
      highlight: (c) => pointAtPool(c, BIG),
      check: (c) => rps(c) === LOAD && pool(c) === BIG && !slowFault(c),
      hold: 20,
      settle: 5,
      measure: 'big',
      feedback: (c) => {
        const f = m(c, 'fix'), g = m(c, 'big');
        if (!f || !g) return L('', '');
        const r = g.p95 / f.p95;
        return {
          zh: `p95 ${fmtLatency(g.p95)}，连接池 ${FIX} 时是 ${fmtLatency(f.p95)}，约为它的 ${x(r)}。${reveal(c, 'predict-big', r, BIG_OPTIONS).zh}\n\n**连接只要够用就行，多出来的只是闲着**。平时看不出连接池开大有什么坏处，下一步看数据库出问题的时候。`,
          en: `p95 is ${fmtLatency(g.p95)} against ${fmtLatency(f.p95)} with a pool of ${FIX}, about ${x(r)}. ${reveal(c, 'predict-big', r, BIG_OPTIONS).en}\n\n**Connections only need to be enough; the extra ones sit idle**. On a normal day a huge pool looks harmless. Next, see what happens when the database has trouble.`,
        };
      },
    },
    {
      id: 'predict-incident',
      kind: 'predict',
      title: L('数据库变慢了', 'The database slows down'),
      body: L(
        `假设某个查询的执行计划变了，所有查询都慢了 ${SLOW} 倍，数据库一下子满负荷。这时连接池 ${BIG} 和连接池 ${FIX}，哪个扛得更好？`,
        `Say a query plan changes and every query becomes ${SLOW}× slower, so the database is suddenly at full load. Which copes better then: a pool of ${BIG} or a pool of ${FIX}?`,
      ),
      options: INCIDENT_OPTIONS,
    },
    {
      id: 'incident',
      kind: 'do',
      title: L('注入慢查询', 'Inject slow queries'),
      body: (c) => {
        const next = !m(c, `q${BIG}`) ? BIG : FIX;
        const done = (m(c, `q${BIG}`) ? 1 : 0) + (m(c, `q${FIX}`) ? 1 : 0);
        return {
          zh: `点击 Postgres，在"故障注入"里找到"慢查询"，把倍数改成 ${SLOW}、持续时长改成 0（一直生效），点"注入"。连接池保持 ${BIG} 观察 20 秒；测完后把连接池改回 ${FIX}，故障不要结束，再观察 20 秒。${done < 2 ? `现在请把连接池设为 ${next}（已完成 ${done} / 2）。` : '两种连接池都测完了。'}`,
          en: `Click Postgres, find Slow queries under Fault injection, set the multiplier to ${SLOW} and Lasts to 0 (stays on), and press Inject. Watch 20 seconds with the pool at ${BIG}; then, without ending the fault, set the pool back to ${FIX} and watch another 20 seconds. ${done < 2 ? `Set the pool to ${next} now (${done} of 2 done).` : 'Both pool sizes are measured.'}`,
        };
      },
      highlight: (c) => (!slowAtTwo(c) ? pointAtDbFault(c) : pointAtPool(c, !m(c, `q${BIG}`) ? BIG : FIX)),
      check: (c) => rps(c) === LOAD && slowAtTwo(c),
      sweep: { values: [BIG, FIX], key: 'q', value: pool },
      hold: 20,
      // switching to the smaller pool first drains the queries already piled up in the database
      settle: 8,
      feedback: (c) => {
        const hi = m(c, `q${BIG}`), lo = m(c, `q${FIX}`), d = db(c);
        if (!hi || !lo || !d) return L('', '');
        const diff = lo.avail - hi.avail;
        return {
          zh: `连接池 ${BIG}：可用性 ${fmtAvail(hi.avail)}。连接池 ${FIX}：可用性 ${fmtAvail(lo.avail)}。${reveal(c, 'predict-incident', diff, INCIDENT_OPTIONS).zh}`,
          en: `Pool ${BIG}: availability ${fmtAvail(hi.avail)}. Pool ${FIX}: availability ${fmtAvail(lo.avail)}. ${reveal(c, 'predict-incident', diff, INCIDENT_OPTIONS).en}`,
        };
      },
    },
    {
      id: 'why-valve',
      kind: 'read',
      title: L('连接池也是一道阀门', 'The pool is also a valve'),
      body: (c) => {
        const hi = m(c, `q${BIG}`), d = db(c);
        const conns = hi && d ? Math.round(hi.nodes[d.id]?.conns ?? 0) : 0;
        return {
          zh: `数据库同时只能执行有限个查询（这里主库是 16 个），多出来的在数据库里排队。\n\n连接池 ${BIG} 时，3 个实例一共可以塞进几百个查询${conns ? `，刚才数据库上的连接一度有 ${conns} 个` : ''}。队伍太长，每个查询都要等很久，超过了服务调用数据库的超时（500ms），服务早就放弃了，数据库却还在执行这些没人要的查询。**数据库忙到 100%，做的几乎全是无用功**，所以几乎全部失败。\n\n连接池 ${FIX} 时，最多 30 个查询进数据库，队伍短，查询能在超时前完成；多出来的请求在服务这一侧就被快速拒绝。还是有失败，但大部分请求能成功。\n\n所以：**连接池按利特尔定律留出余量就够了，不是越大越好**。还有一条和第 3 课相关的规则：**实例数 × 每实例连接池大小，不能超过数据库扛得住的量**（并行能力和最大连接数）。服务水平扩展时，数据库的连接数也跟着翻倍，所以扩实例时要相应调小每个实例的连接池，或者在中间加连接代理（例如 PgBouncer）。`,
          en: `A database can only execute so many queries at once (16 on this primary); the rest wait inside the database.\n\nWith a pool of ${BIG}, 3 instances can push hundreds of queries in${conns ? `; the database had ${conns} connections open just now` : ''}. The line gets so long that each query waits past the service's 500ms timeout for database calls. The service has already given up, but the database keeps executing queries nobody wants. **It is 100% busy doing almost entirely wasted work**, so almost everything fails.\n\nWith a pool of ${FIX}, at most 30 queries enter the database, the line stays short, and queries finish before the timeout; extra requests are turned away quickly on the service side. Some still fail, but most succeed.\n\nSo: **size the pool with Little's law plus headroom; bigger isn't better**. And a rule that ties back to lesson 3: **instances × pool size per instance must stay within what the database can take** (its parallel executions and max connections). Scaling the service out multiplies the connections to the database, so when you add instances, shrink each instance's pool or put a connection proxy (such as PgBouncer) in between.`,
        };
      },
    },
    {
      id: 'done',
      kind: 'read',
      title: L('小结', 'Wrap-up'),
      body: L(
        '记住三点：\n\n• **CPU 很闲却很慢时，看线程和连接**：请求可能都在等数据库连接。\n• **连接池大小 ≈ 每秒查询数 × 每次查询时间，再留几倍余量**（利特尔定律）。\n• **连接池不是越大越好。**数据库变慢时，小一点的连接池能限制涌进数据库的查询，让它继续做有用的事；所有实例的连接加起来，要在数据库扛得住的范围内。\n\n退出课程前，可以在 Postgres 的"慢查询"那里点"结束"，看看系统怎么恢复。',
        'Three things to remember:\n\n• **When CPU is idle but requests are slow, look at threads and connections**: requests may all be waiting for a database connection.\n• **Pool size ≈ queries per second × time per query, plus a few times headroom** (Little\'s law).\n• **A bigger pool isn\'t better.** When the database slows down, a smaller pool limits how many queries flood in, so it keeps doing useful work; and the connections of all instances together must stay within what the database can take.\n\nBefore leaving, you can press End on Slow queries for Postgres and watch the system recover.',
      ),
    },
  ],
};
