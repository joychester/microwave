// Lesson 5: caching. A small drop in hit ratio multiplies the database's load; and a cache flush that
// lasts five seconds can leave the system down for good, because the cache only refills through a
// database that is too swamped to answer in time. Limiting the queries in flight breaks the loop.
import { blankTopology, newEdge, newNode } from '../../engine/presets';
import { L, type Lang, type Topology } from '../../engine/types';
import { fmtAvail, fmtLatency, fmtPct } from '../../ui/format';
import type { BarGroup, Lesson, LessonCtx, Measure, PredictOption } from '../types';
import { edgeBetween, firstOfType, reveal, trafficRate } from '../helpers';

const LOAD = 1000;
const INSTANCES = 8;
const DB_WORKERS = 8; // a modest database: about 285 queries a second at most
const HIT = 0.9;
const SWEEP = [0.8, 0.7];
const POOL = 20; // the default pool: 8 instances × 20 = 160 queries allowed into the database
const FIX = 2; // 8 × 2 = 16, about twice what the database executes at once

const ln = (median: number, p99: number) => ({ dist: 'lognormal' as const, median, p99 });

const rps = trafficRate;
const redis = (c: LessonCtx) => firstOfType(c, 'cache');
const db = (c: LessonCtx) => firstOfType(c, 'database');
const originEdge = (c: LessonCtx) => edgeBetween(c, redis(c), db(c));
const pool = (c: LessonCtx) => Number(originEdge(c)?.params.poolSize ?? POOL);
const capMode = (c: LessonCtx) => redis(c)?.params.hitMode === 'capacity';
const hitRatio = (c: LessonCtx) => Number(redis(c)?.params.hitRatio ?? HIT);
const m = (c: LessonCtx, k: string): Measure | undefined => c.meas[k];
const pctLabel = (h: number) => `${Math.round(h * 100)}%`;
const perSec = (v: number) => `${Math.round(v)}/s`;

const flushView = (c: LessonCtx) => {
  const r = redis(c);
  return r ? c.failures.find((f) => f.nodeId === r.id && f.kind === 'flush') : undefined;
};
/** The flush is on now (not just recovering afterwards). */
const flushing = (c: LessonCtx) => {
  const f = flushView(c);
  return !!f && (f.end < 0 || f.end > c.now * 1000);
};
/** The cache's hit ratio in the latest second. */
const liveHit = (c: LessonCtx) => {
  const r = redis(c);
  const v = r ? c.latest?.nodes[r.id]?.extra.hitRatio : undefined;
  return v !== undefined && isFinite(v) ? v : NaN;
};
/** A flush has come and gone at least 10 seconds ago, and the cache is (still) close to empty. */
const afterFlush = (c: LessonCtx) => {
  const f = flushView(c);
  if (f) return f.end >= 0 && c.now * 1000 >= f.end + 10_000;
  // its record is gone (recovery time over or set to 0): judge by the cache itself
  return !!m(c, 'warm') && liveHit(c) < 0.3;
};

/** Point at a field of the cache, selecting it first. */
function cacheField(c: LessonCtx, sel: string): string | null {
  const r = redis(c);
  if (!r) return null;
  return c.selection?.kind === 'node' && c.selection.id === r.id ? `.inspector ${sel}` : `.react-flow__node[data-id="${r.id}"] .sn`;
}
function pointAtPool(c: LessonCtx): string | null {
  const e = originEdge(c);
  if (!e || pool(c) === FIX) return null;
  return c.selection?.kind === 'edge' && c.selection.id === e.id ? '.inspector [data-param="poolSize"]' : `.fe-label[data-edge="${e.id}"]`;
}

const LOAD_OPTIONS: PredictOption[] = [
  // the measured value is database queries per second at 70% ÷ at 90%
  { label: L('多 20% 左右', 'About 20% more'), range: [0, 1.6] },
  { label: L('2 倍左右', 'About double'), range: [1.6, 2.5] },
  { label: L('3 倍左右', 'About triple'), range: [2.5, Infinity] },
];
const FLUSH_OPTIONS: PredictOption[] = [
  // the measured value is the hit ratio 10–35 s after the flush ended
  { label: L('几秒内就恢复', 'Back within seconds'), range: [0.8, Infinity] },
  { label: L('一两分钟内慢慢恢复', 'Recovering slowly over a minute or two'), range: [0.2, 0.8] },
  { label: L('一直恢复不了', 'It doesn\'t recover'), range: [-Infinity, 0.2] },
];

function make(lang: Lang): Topology {
  const topo = blankTopology(lang);
  topo.name = L('第 5 课：缓存', 'Lesson 5: caching')[lang];
  const client = topo.nodes[0];
  client.params = { ...client.params, rps: LOAD };
  const svc = newNode('service', client.x + 330, client.y, topo.nodes, lang);
  svc.params = { ...svc.params, instances: INSTANCES };
  const cache = newNode('cache', svc.x + 330, svc.y, [...topo.nodes, svc], lang);
  cache.name = 'Redis';
  cache.params = { ...cache.params, hitMode: 'fixed', hitRatio: HIT };
  const pg = newNode('database', cache.x + 330, cache.y, [...topo.nodes, svc, cache], lang);
  pg.name = 'Postgres';
  // every query that reaches the database is a cache miss, so a read
  pg.params = { ...pg.params, workers: DB_WORKERS, readRatio: 1, readTime: ln(22, 90) };
  topo.nodes.push(svc, cache, pg);
  topo.edges.push(newEdge(client, svc, topo.edges));
  topo.edges.push(newEdge(svc, cache, topo.edges));
  const origin = newEdge(cache, pg, topo.edges);
  origin.params = { ...origin.params, poolSize: POOL };
  topo.edges.push(origin);
  return topo;
}

function dbLoad(c: LessonCtx, mm: Measure): number {
  const d = db(c);
  return d ? mm.nodes[d.id]?.arr ?? 0 : 0;
}

function bars(c: LessonCtx): BarGroup[] {
  const groups: BarGroup[] = [];
  const rows = [['base', HIT], ...SWEEP.map((h) => [`h${h}`, h] as const)] as [string, number][];
  const got = rows.map(([k, h]) => [m(c, k), h] as const).filter(([mm]) => !!mm) as [Measure, number][];
  if (got.length > 1) {
    groups.push({
      title: L('数据库每秒查询数', 'Database queries per second'),
      rows: got.map(([mm, h]) => ({ label: L(`命中率 ${pctLabel(h)}`, `Hit ratio ${pctLabel(h)}`), value: dbLoad(c, mm), text: perSec(dbLoad(c, mm)), bad: mm.avail < 0.99 })),
    });
    groups.push({
      title: L('用户请求可用性', 'Availability of user requests'),
      max: 1,
      rows: got.map(([mm, h]) => ({ label: L(`命中率 ${pctLabel(h)}`, `Hit ratio ${pctLabel(h)}`), value: mm.avail, text: fmtAvail(mm.avail), bad: mm.avail < 0.99 })),
    });
  }
  const f = m(c, 'flush'), r = m(c, 'rescue');
  if (f && r) {
    groups.push({
      title: L('缓存清空之后的可用性', 'Availability after the flush'),
      max: 1,
      rows: [
        { label: L(`连接池 ${POOL}`, `Pool ${POOL}`), value: f.avail, text: fmtAvail(f.avail), bad: f.avail < 0.5 },
        { label: L(`连接池 ${FIX}`, `Pool ${FIX}`), value: r.avail, text: fmtAvail(r.avail), bad: r.avail < 0.5 },
      ],
    });
  }
  // while working through the lesson, show only the latest comparison; at the end, all of them
  return f && r ? groups : groups.slice(0, 2);
}

export const lesson05: Lesson = {
  id: 'l05-cache',
  num: 5,
  title: L('缓存', 'Caching'),
  summary: L('命中率从 90% 降到 70%，数据库负载变成 3 倍；缓存只清空 5 秒，系统却可能再也恢复不了。', 'Hit ratio drops from 90% to 70% and database load triples; a 5-second cache flush can leave the system down for good.'),
  minutes: 15,
  speed: 5,
  make,
  bars,
  steps: [
    {
      id: 'predict-load',
      kind: 'predict',
      title: L('先预测', 'Predict first'),
      body: L(
        `起点已经搭好："用户流量"每秒发 ${LOAD} 个请求给一个有 ${INSTANCES} 个实例的微服务。微服务先查 Redis：命中就直接返回；没命中，就去 Postgres 查，再写回 Redis（这种用法叫 cache-aside）。Redis 现在的命中率是 ${pctLabel(HIT)}。\n\n假设命中率从 ${pctLabel(HIT)} 降到 70%，只降了 20 个百分点。数据库每秒要处理的查询会变成原来的多少？`,
        `The starting point is ready: the traffic source sends ${LOAD} requests a second to a service with ${INSTANCES} instances. The service asks Redis first: a hit returns right away; a miss goes to Postgres and then writes the value back to Redis (this is called cache-aside). Redis currently hits ${pctLabel(HIT)} of the time.\n\nSay the hit ratio falls from ${pctLabel(HIT)} to 70%, only 20 points. How many queries a second does the database have to handle then, compared with now?`,
      ),
      options: LOAD_OPTIONS,
    },
    {
      id: 'base',
      kind: 'do',
      title: L('运行并观察', 'Run it and look'),
      body: L(
        '点"运行"，观察 20 秒。留意 Postgres 卡片：它每秒收到多少查询、利用率多高。',
        'Press Run and watch for 20 seconds. Keep an eye on the Postgres card: how many queries a second it gets and how busy it is.',
      ),
      highlight: (c) => (c.running ? null : '[data-learn="run"]'),
      check: (c) => rps(c) === LOAD && !capMode(c) && hitRatio(c) === HIT && pool(c) === POOL && !flushView(c),
      hold: 20,
      settle: 5,
      measure: 'base',
      feedback: (c) => {
        const b = m(c, 'base'), d = db(c);
        if (!b || !d) return L('', '');
        const dn = b.nodes[d.id];
        return {
          zh: `${LOAD}/s 的请求里，只有 ${perSec(dn?.arr ?? 0)} 落到数据库，数据库利用率 ${fmtPct(dn?.util ?? 0)}。可用性 ${fmtAvail(b.avail)}，p95 ${fmtLatency(b.p95)}。这个数据库自己最多每秒处理 300 个左右的查询，是缓存让它扛住了每秒 ${LOAD} 个请求。`,
          en: `Of ${LOAD} requests a second, only ${perSec(dn?.arr ?? 0)} reach the database, which is ${fmtPct(dn?.util ?? 0)} busy. Availability ${fmtAvail(b.avail)}, p95 ${fmtLatency(b.p95)}. On its own this database manages about 300 queries a second at most; the cache is what lets it serve ${LOAD} requests a second.`,
        };
      },
    },
    {
      id: 'drop',
      kind: 'do',
      title: L('命中率下降', 'The hit ratio drops'),
      body: (c) => {
        const next = SWEEP.find((h) => !m(c, `h${h}`));
        const done = SWEEP.filter((h) => m(c, `h${h}`)).length;
        return {
          zh: `点击 Redis，在右侧把"命中率"改成 80%，观察 20 秒；再改成 70%，再观察 20 秒。现实中，命中率下降可能是因为新上线的功能换了 key、缓存内存被挤占，或者流量变成了很多冷门数据。${next !== undefined ? `现在请把命中率设为 ${pctLabel(next)}（已完成 ${done} / ${SWEEP.length}）。` : '两个命中率都测完了。'}`,
          en: `Click Redis and on the right set Hit ratio to 80%, then watch 20 seconds; then 70% and another 20 seconds. In real life the hit ratio drops when a new release changes the keys, the cache runs short of memory, or traffic shifts toward rarely used data. ${next !== undefined ? `Set the hit ratio to ${pctLabel(next)} now (${done} of ${SWEEP.length} done).` : 'Both hit ratios are measured.'}`,
        };
      },
      highlight: (c) => {
        const next = SWEEP.find((h) => !m(c, `h${h}`));
        return next === undefined || hitRatio(c) === next ? null : cacheField(c, '[data-param="hitRatio"]');
      },
      check: (c) => rps(c) === LOAD && !capMode(c) && pool(c) === POOL && !flushView(c),
      sweep: { values: SWEEP, key: 'h', value: hitRatio },
      hold: 20,
      settle: 6,
      feedback: (c) => {
        const b = m(c, 'base'), lo = m(c, 'h0.8'), lw = m(c, 'h0.7'), d = db(c);
        if (!b || !lo || !lw || !d) return L('', '');
        const q = (mm: Measure) => mm.nodes[d.id];
        const ratio = dbLoad(c, lw) / Math.max(1, dbLoad(c, b));
        return {
          zh: `数据库每秒查询：命中率 90% 时 ${perSec(dbLoad(c, b))}，80% 时 ${perSec(dbLoad(c, lo))}，70% 时 ${perSec(dbLoad(c, lw))}，约 ${ratio.toFixed(1)} 倍。${reveal(c, 'predict-load', ratio, LOAD_OPTIONS).zh}\n\n80% 时数据库利用率 ${fmtPct(q(lo)?.util ?? 0)}，还扛得住（可用性 ${fmtAvail(lo.avail)}）；70% 时利用率到了 ${fmtPct(q(lw)?.util ?? 0)}，查询开始排长队，可用性掉到 ${fmtAvail(lw.avail)}，p95 ${fmtLatency(lw.p95)}。`,
          en: `Database queries a second: ${perSec(dbLoad(c, b))} at 90%, ${perSec(dbLoad(c, lo))} at 80%, ${perSec(dbLoad(c, lw))} at 70%, about ${ratio.toFixed(1)}×. ${reveal(c, 'predict-load', ratio, LOAD_OPTIONS).en}\n\nAt 80% the database is ${fmtPct(q(lo)?.util ?? 0)} busy and still copes (availability ${fmtAvail(lo.avail)}); at 70% it reaches ${fmtPct(q(lw)?.util ?? 0)}, queries queue up, availability falls to ${fmtAvail(lw.avail)} and p95 is ${fmtLatency(lw.p95)}.`,
        };
      },
    },
    {
      id: 'why-miss',
      kind: 'read',
      title: L('看未命中率，不看命中率', 'Watch the miss ratio, not the hit ratio'),
      body: L(
        `落到数据库的查询 = 请求数 × 未命中率。命中率 90% → 70%，听起来只降了一点；未命中率却从 10% 变成 30%，数据库的负载就是 3 倍。命中率越高，同样的下降越要命：99% 降到 98%，数据库负载就翻倍。\n\n再加上第 2 课学过的：利用率接近 100% 时，排队时间会急剧上升。数据库从 35% 到超过 100%，中间没有"慢一点"的过渡，直接开始失败。\n\n所以：监控里盯未命中率和数据库的余量；数据库要按"缓存表现不好的时候"来准备容量，而不是按平时最好的命中率。`,
        `Queries reaching the database = requests × miss ratio. Going from a 90% to a 70% hit ratio sounds small, but the miss ratio goes from 10% to 30%, so the database gets 3× the load. The higher the hit ratio, the more a drop hurts: from 99% to 98% doubles the database's load.\n\nAdd what lesson 2 showed: as utilization nears 100%, waiting time shoots up. Going from 35% to over 100%, the database doesn't get "a bit slower" first; it goes straight to failing.\n\nSo watch the miss ratio and the database's headroom, and size the database for the days the cache does badly, not for its best hit ratio.`,
      ),
    },
    {
      id: 'patterns',
      kind: 'read',
      title: L('缓存的 5 种常见模式', 'Five common caching patterns'),
      body: L(
        '本课的服务用的是第一种，cache-aside。读写数据时，缓存和数据库怎么配合，常见的有 5 种：\n\n• Cache-aside（旁路缓存）：应用先查缓存，没命中就自己查数据库，再写回缓存；更新数据时先写数据库，再删掉缓存里的旧值。最常用，缓存挂了应用还能直接查数据库。缺点是每个服务都要自己写这套逻辑，而且缓存一空，回源会一下子全压到数据库，就是本课后半段要看到的情况。\n• Read-through（读穿透）：应用只找缓存，没命中由缓存层自己去数据库加载。对数据库的压力和 cache-aside 一样，好处是回源逻辑集中在一个地方，容易统一加限流、合并回源。\n• Write-through（写穿透）：写数据时同时写缓存和数据库，两边都成功才返回。缓存里总是新数据；代价是每次写都慢一点，而且写进缓存的数据不一定有人读。\n• Write-behind / write-back（异步回写）：写数据只写缓存就返回，之后再批量写进数据库。写得快，多次写可以合并，数据库压力小；但缓存宕机时，还没写进数据库的数据会丢，数据库也会短暂落后。适合计数、点赞这类丢一点也能接受的数据。\n• Refresh-ahead（提前刷新）：热门 key 快过期时，在后台提前去数据库刷新。用户几乎碰不到"刚过期"的未命中；但要猜哪些 key 还会被访问，猜错就白刷新。\n\n怎么选：读多写少，用 cache-aside 或 read-through；写完要马上读到新值，用 write-through；写特别多、能容忍少量丢失，用 write-behind；少数热点 key 一过期延迟就抖，再加上 refresh-ahead。实际系统常常组合使用，比如 read-through 加 write-through。\n\n这个仿真器的缓存只模拟读路径（命中、未命中、回源、写回），所以下面的实验都在 cache-aside 下进行。',
        'The service in this lesson uses the first one, cache-aside. There are five common ways for a cache and a database to work together on reads and writes:\n\n• Cache-aside: the application checks the cache; on a miss it queries the database itself and writes the value back. On an update it writes the database, then deletes the old value from the cache. The most common pattern; if the cache dies, the application can still go to the database. The downsides: every service carries this logic, and when the cache empties, every fetch lands on the database at once, which is what the second half of this lesson shows.\n• Read-through: the application only talks to the cache; on a miss the cache layer loads from the database itself. The database load is the same as cache-aside, but fetching lives in one place, which makes it easy to add rate limits and request coalescing there.\n• Write-through: a write goes to the cache and the database together and returns once both succeed. The cache always holds fresh data; the price is slower writes, and data written to the cache may never be read.\n• Write-behind / write-back: a write goes only to the cache and returns; the database is updated later in batches. Writes are fast, repeated writes merge, and the database does less work; but if the cache dies, writes not yet in the database are lost, and the database runs a little behind. Fits counters, likes and other data where losing a little is acceptable.\n• Refresh-ahead: popular keys about to expire are refreshed from the database in the background. Users rarely hit a "just expired" miss; but you must guess which keys will be read again, and a wrong guess is wasted work.\n\nHow to choose: mostly reads, cache-aside or read-through; reads must see a write immediately, write-through; very many writes and a little loss is fine, write-behind; a few hot keys whose expiry causes latency spikes, add refresh-ahead. Real systems often combine them, such as read-through with write-through.\n\nThe cache in this simulator models the read path only (hits, misses, fetching from the origin, writing back), so the experiments that follow all use cache-aside.',
      ),
    },
    {
      id: 'warm',
      kind: 'do',
      title: L('更真实的缓存', 'A more realistic cache'),
      body: L(
        `到目前为止命中率是直接填的数。真实的缓存里，命中率取决于缓存里存着多少数据：没命中的查询回源后写回缓存，缓存才慢慢"热"起来。\n\n点击 Redis，把"命中率来源"改成"按容量推算"。现在 Redis 有 6 个分片 × 每个 8 万个 key，能存业务里 100 万个 key 中最常用的 48 万个；访问集中在热门 key 上，所以命中率在 90% 以上。改完观察 15 秒。`,
        `So far the hit ratio was a number you typed in. In a real cache it depends on what the cache holds: a miss is fetched from the origin and written back, and that is how the cache "warms up".\n\nClick Redis and set Hit ratio from to Cache capacity. Redis has 6 shards × 80,000 keys each, room for the 480,000 most used of the workload's 1 million keys; most traffic goes to popular keys, so it hits over 90% of the time. Then watch 15 seconds.`,
      ),
      highlight: (c) => (capMode(c) ? (c.running ? null : '[data-learn="run"]') : cacheField(c, '[data-param="hitMode"]')),
      check: (c) => rps(c) === LOAD && capMode(c) && pool(c) === POOL && !flushView(c),
      hold: 15,
      settle: 6,
      measure: 'warm',
      feedback: (c) => {
        const w = m(c, 'warm'), r = redis(c), d = db(c);
        if (!w || !r || !d) return L('', '');
        return {
          zh: `命中率 ${fmtPct(w.nodes[r.id]?.hit ?? 0)}，数据库每秒 ${perSec(dbLoad(c, w))} 个查询，利用率 ${fmtPct(w.nodes[d.id]?.util ?? 0)}，可用性 ${fmtAvail(w.avail)}。一切正常。`,
          en: `Hit ratio ${fmtPct(w.nodes[r.id]?.hit ?? 0)}, ${perSec(dbLoad(c, w))} database queries a second, the database ${fmtPct(w.nodes[d.id]?.util ?? 0)} busy, availability ${fmtAvail(w.avail)}. All normal.`,
        };
      },
    },
    {
      id: 'predict-flush',
      kind: 'predict',
      title: L('缓存被清空', 'The cache is flushed'),
      body: L(
        '假设 Redis 被清空了 5 秒：比如重启、主从切换，或者有人误执行了 FLUSHALL。5 秒后 Redis 恢复正常，但里面是空的。\n\n系统会怎样？',
        'Say Redis is wiped for 5 seconds: a restart, a failover, or someone running FLUSHALL by mistake. After 5 seconds Redis works again, but empty.\n\nWhat happens to the system?',
      ),
      options: FLUSH_OPTIONS,
    },
    {
      id: 'flush',
      kind: 'do',
      title: L('清空缓存', 'Flush the cache'),
      body: L(
        '点击 Redis，在"故障注入"里找到"缓存清空（雪崩）"，保持默认设置，点"注入"。清空只持续 5 秒，之后继续观察。',
        'Click Redis, find Cache flush (stampede) under Fault injection, keep the defaults and press Inject. The flush lasts only 5 seconds; keep watching after it ends.',
      ),
      highlight: (c) => (flushView(c) ? (c.running ? null : '[data-learn="run"]') : cacheField(c, '[data-fault="flush"]')),
      check: (c) => rps(c) === LOAD && capMode(c) && pool(c) === POOL && afterFlush(c),
      hold: 25,
      measure: 'flush',
      feedback: (c) => {
        const f = m(c, 'flush'), r = redis(c), d = db(c);
        if (!f || !r || !d) return L('', '');
        const hit = f.nodes[r.id]?.hit ?? 0;
        return {
          zh: `清空早就结束了，命中率却还是 ${fmtPct(hit)}，可用性 ${fmtAvail(f.avail)}。数据库忙到 ${fmtPct(f.nodes[d.id]?.util ?? 0)}，每秒收到 ${perSec(dbLoad(c, f))} 个查询。${reveal(c, 'predict-flush', hit, FLUSH_OPTIONS).zh}${hit < 0.2 ? '\n\n你可以再等一会儿，它不会自己好起来。' : ''}`,
          en: `The flush ended a while ago, yet the hit ratio is still ${fmtPct(hit)} and availability ${fmtAvail(f.avail)}. The database is ${fmtPct(f.nodes[d.id]?.util ?? 0)} busy with ${perSec(dbLoad(c, f))} queries a second. ${reveal(c, 'predict-flush', hit, FLUSH_OPTIONS).en}${hit < 0.2 ? '\n\nYou can wait longer: it won\'t get better on its own.' : ''}`,
        };
      },
    },
    {
      id: 'why-stuck',
      kind: 'read',
      title: L('为什么恢复不了', 'Why it doesn\'t recover'),
      body: (c) => {
        const f = m(c, 'flush'), d = db(c);
        const conns = f && d ? Math.round(f.nodes[d.id]?.conns ?? 0) : 0;
        return {
          zh: `缓存只有一种办法重新装满：没命中的查询去数据库拿到结果，再写回缓存。\n\n清空时，每秒 ${LOAD} 个请求全部落到数据库，而它最多只能处理 300 个左右。每个服务实例最多开 ${POOL} 个连接，${INSTANCES} 个实例一共能塞进 ${INSTANCES * POOL} 个查询${conns ? `（刚才数据库上有 ${conns} 个连接）` : ''}。队伍太长，查询要等好几百毫秒，超过了回源的超时（500ms）。超时的查询拿不到结果，就写不回缓存。\n\n于是：缓存是空的 → 全部查询压到数据库 → 数据库太忙、查询超时 → 缓存还是空的。最初的原因（清空）早就没了，故障却自己维持下去。这叫"亚稳态故障"（metastable failure），是线上事故里很难缠的一类：重启服务、加机器都不一定有用，因为每台新机器又带来一批新连接。\n\n解法和第 4 课一样：少放一点查询进数据库。队伍短了，查询能在超时前完成、写回缓存；命中率回升，数据库的压力就减轻，进入正循环。数据库同时执行 ${DB_WORKERS} 个查询，${INSTANCES} 个实例每个分 1 个就够，留点余量设成 ${FIX}。`,
          en: `A cache refills in only one way: a miss fetches the value from the database and writes it back.\n\nDuring the flush all ${LOAD} requests a second fall on the database, which manages about 300. Each service instance can open ${POOL} connections, so ${INSTANCES} instances can push ${INSTANCES * POOL} queries in${conns ? ` (the database had ${conns} connections just now)` : ''}. The line is so long that queries wait hundreds of milliseconds, past the 500ms timeout for fetching from the origin. A query that times out returns nothing, so nothing is written back.\n\nSo: the cache is empty → every query lands on the database → the database is swamped and queries time out → the cache stays empty. The cause (the flush) is long gone, yet the failure keeps itself going. This is called a metastable failure, one of the nastiest kinds of incident: restarting services or adding machines may not help, since every new machine brings its own connections.\n\nThe way out is the one from lesson 4: let fewer queries into the database. With a short line, queries finish before the timeout and get written back; the hit ratio climbs, the database gets relief, and the loop turns the other way. The database runs ${DB_WORKERS} queries at once, so 1 per instance across ${INSTANCES} instances would do; with a little headroom, ${FIX}.`,
        };
      },
    },
    {
      id: 'rescue',
      kind: 'do',
      title: L('限制回源并发', 'Limit queries to the origin'),
      body: L(
        `点击 Redis 和 Postgres 之间那条连线上的标签，在右侧"连接池"分组里把"每实例连接池大小"改成 ${FIX}。它的意思是每个服务实例回源时最多同时占用 ${FIX} 个数据库连接。改完观察 1 分钟。`,
        `Click the label on the line between Redis and Postgres, and under Connection pool on the right set Pool size per instance to ${FIX}: each service instance may hold at most ${FIX} database connections while fetching misses. Then watch for a minute.`,
      ),
      highlight: (c) => pointAtPool(c) ?? (c.running ? null : '[data-learn="run"]'),
      check: (c) => rps(c) === LOAD && capMode(c) && pool(c) === FIX && !flushing(c),
      hold: 60,
      // the first half-minute is the turnaround itself; measure the half after it
      settle: 30,
      measure: 'rescue',
      feedback: (c) => {
        const f = m(c, 'flush'), r0 = m(c, 'rescue'), r = redis(c);
        if (!f || !r0 || !r) return L('', '');
        const now = liveHit(c);
        return {
          zh: `命中率从 ${fmtPct(f.nodes[r.id]?.hit ?? 0)} 回升到 ${fmtPct(isFinite(now) ? now : r0.nodes[r.id]?.hit ?? 0)}，最近 30 秒的可用性 ${fmtAvail(r0.avail)}（之前 ${fmtAvail(f.avail)}）。数据库还是很忙，但现在做的是有用的事：查询能完成并写回缓存。\n\n还没完全恢复：p95 ${fmtLatency(r0.p95)}，有些请求在等连接、有些被拒绝。继续运行，大约再过 5 分钟，可用性会回到接近 100%。命中率回到 90% 以上要久得多：冷门的 key 要一个个被访问到才会写回，这正是"预热"值得做的原因。`,
          en: `The hit ratio has climbed from ${fmtPct(f.nodes[r.id]?.hit ?? 0)} to ${fmtPct(isFinite(now) ? now : r0.nodes[r.id]?.hit ?? 0)}, and availability over the last 30 seconds was ${fmtAvail(r0.avail)} (before: ${fmtAvail(f.avail)}). The database is still busy, but now with useful work: queries finish and get written back.\n\nIt isn't fully recovered yet: p95 is ${fmtLatency(r0.p95)}, with some requests waiting for a connection and some turned away. Keep it running: in about 5 more minutes availability is back near 100%. The hit ratio takes far longer to pass 90%, because rarely used keys only come back one by one as they are requested, which is exactly why warming a cache up is worth doing.`,
        };
      },
    },
    {
      id: 'done',
      kind: 'read',
      title: L('小结', 'Wrap-up'),
      body: L(
        '记住三点：\n\n• 落到数据库的量 = 请求 × 未命中率。命中率掉一点，未命中率可能翻几倍；数据库要按缓存表现差的时候准备余量。\n• 缓存清空后，系统可能进入"缓存空 → 数据库被压垮 → 写不回缓存"的循环，自己出不来。\n• 打破循环的办法是限制回源：控制同时打到数据库的查询数，让它们能按时完成。\n\n真实系统里还有几种常见的防护：\n• 预热：上线或重启前先把热门数据加载进缓存，而不是让用户流量去填。\n• 过期时间加随机：避免大量 key 在同一时刻一起过期。\n• 合并回源（single-flight）：同一个 key 同时有很多请求没命中时，只放一个去数据库，其余等它的结果。\n• 限流和降级：数据库扛不住时，宁可快速拒绝一部分请求或返回旧数据，也不要让所有请求一起超时。',
        'Three things to remember:\n\n• Load on the database = requests × miss ratio. A small drop in hit ratio can multiply the miss ratio; give the database headroom for the days the cache does badly.\n• After a flush, the system can fall into a loop: empty cache → swamped database → nothing written back. It may not get out on its own.\n• The way out is to limit fetches from the origin: cap the queries in flight to the database so they finish on time.\n\nReal systems add a few more defences:\n• Warm-up: load the popular data into the cache before a release or restart, instead of letting user traffic fill it.\n• Randomized expiry: so lots of keys don\'t expire at the same moment.\n• Request coalescing (single-flight): when many requests miss on the same key at once, only one goes to the database and the rest wait for its result.\n• Rate limiting and fallbacks: when the database can\'t keep up, turn some requests away quickly or serve stale data rather than let everything time out.',
      ),
    },
  ],
};
