# SimBench: a microservice performance simulation workbench

Build a microservice topology by drag and drop, tune capacity, timeouts, retries and circuit breakers, inject faults, and watch bottlenecks, SLO impact and cascading failures in real time. An analytical model alongside the simulation gives steady-state capacity estimates.

The UI is in English by default and can be switched to Chinese (中文); light and dark modes are both available (top right). The choice is saved in the browser. On first load it follows the browser language and the system theme.

中文说明见 [README.zh-CN.md](README.zh-CN.md).

## Traffic models and run reports

Select any traffic source and pick how traffic arrives in the **Traffic model** panel on the right, by picture or by name:

- Base models: constant, linear ramp (up or down), step, sine wave, diurnal, and replay (paste `seconds,rps` data)
- Overlays: spike, periodic burst, thundering herd after an outage, and random noise. Overlays stack; spike and herd can be fired on demand with **Fire now**

Everything can be changed while the simulation runs; a red line on the curve preview marks the current time. Each traffic source has its own model, and their traffic adds up wherever they share components (see the **Multiple traffic sources** preset).

Click the clock in the top bar to pick a run length (1, 2, 5, 10 or 30 minutes of simulated time). The run stops on its own, and the **Run report** shows availability, peak p99, time within SLO, the knee (the incoming rate at which the SLO keeps breaking), the first component to saturate, peak utilization per component, failure causes and cost, compared with the previous run. Reports can be copied as Markdown.

## Traffic splitting and the cache model

- **Exclusive routing.** Traffic sources and load balancers can have several outgoing edges; each request takes exactly one, chosen by **weight**. Gateway routes with the same prefix are split by weight too. On services and caches, outgoing edges marked **Exclusive choice** within the same call order are reduced to one call per request. Edges show their share (for example 90% / 10%), which covers canaries, A/B tests and multi-region setups. Unmarked edges are still called every time (plain dependencies). See the **Canary release** preset.
- **Cache hit ratio.** Set it directly, or let it **follow capacity**: the steady-state LRU hit ratio is computed with Che's approximation from shards × keys per shard, total key space and access skew (Zipf). After a flush or a cold start the cache starts at 0 and every successful origin fetch puts one key back, so the hit ratio warms up over time; if origin fetches slow the database down, warm-up slows down too. See the **Cache warm-up** scenario.

## Challenge mode

Click the gold **Challenge** button in the top bar. Five levels, each harder than the last:

| Level | What it teaches |
|---|---|
| 1 First scale-out | Instance counts, CPU utilization, autoscaling cold starts |
| 2 Take load off the DB | Adding a cache yourself and rewiring calls |
| 3 Retry storm | Retry amplification, circuit breakers and fallbacks, dropping requests that queue too long |
| 4 Black Friday | Capacity planning across components, Kafka partitions and consumers, cost control |
| 5 Chaos monkey | Overall resilience under random faults (a different fault order each time) |

Rules: the error budget is your health bar. Failed requests drain it and the level is lost when it runs out; average cost must stay within budget. Score = reliability 500 + latency 300 + cost 200. Three stars = clear the level + p99 within SLO at least 90% of the time + average cost ≤ 80% of budget. Progress is saved in the browser.

Levels are defined in `src/game/levels.ts` (traffic curve, fault schedule, locked components and parameters, budget) and scoring in `src/game/rules.ts`; the browser and the headless tests share the same rules.

`npm run levels` plays every level twice, once doing nothing and once with a reasonable fix, to check the balance.

## Running

```bash
npm install
npm run dev        # local development, http://localhost:5173
npm run build      # produces dist/index.html (a single file you can open directly)
npm run sim        # runs every preset scenario headless and prints the time series (engine regression test)
npm run sim -- slowdb 200   # one scenario only, 200 simulated seconds
npm run levels     # level balance test
npx tsx scripts/check-traffic.ts         # traffic models and multi-source superposition
npx tsx scripts/check-routing-cache.ts   # split ratios and cache warm-up
```

## Layout

```
src/engine/          simulation core with no UI dependency (runs on its own in Node)
  types.ts           types for topology, parameters and metric snapshots
  specs.ts           parameter definitions for the 7 components and the call edge (defaults, ranges, help); forms are generated from it
  dist.ts            random numbers and distributions (lognormal is given as median + p99)
  sim.ts             request-level discrete-event simulator
  analysis.ts        analytical layer: forced flow law, M/G/c (Erlang C + Allen-Cunneen), USL, capacity plans
  presets.ts         preset topologies and demo scenarios
  host.ts            advances the simulation in real time, schedules faults, emits per-second metrics
  cost.ts            running cost model ($/hour)
  traffic.ts         traffic models: base model + overlays, evaluation and replay parsing
  cachemodel.ts      cache hit ratio: Zipf + Che's approximation (LRU)
src/game/            levels and scoring (no UI dependency)
  worker.ts          Web Worker entry (falls back to the main thread when workers are unavailable)
src/ui/              React UI: React Flow canvas, inspector, uPlot charts, capacity analysis
  i18n.ts            language switch: components use t('中文', 'English'); engine text is {zh, en}
  theme.ts           light and dark chart palettes (checked for color blindness and contrast)
  NodeShape.tsx      a distinct outline per component (browser window, arch, router, replicas, memory stick, cylinder, pipe)
  game.ts / GameUI.tsx  challenge mode: level select, briefing, HUD, countdown, results
  sound.ts           WebAudio synthesized sound effects (off by default)
  TrafficEditor.tsx  traffic model editor (model cards, curve preview)
  runs.ts / Report.tsx  timed runs and run reports
scripts/run-scenarios.ts   headless scenario runner
```

## Simulation model

| Component | Primitives | Key mechanics |
|---|---|---|
| Traffic source | Arrival process | Poisson arrivals; traffic programs (base model + overlays); client timeout and retries |
| API Gateway | Instance pool + token bucket + router | Longest-prefix path routing; rate limiting returns 429 |
| Load Balancer | Router + health checks | Round robin, random, least connections, P2C; a failed instance keeps getting traffic until it is taken out |
| Service | Instance pool (threads) + CPU cores + downstream calls | The I/O part is pure delay, the CPU part queues for a core; optionally holds a thread while calling downstream; GC pauses; drops requests that queue too long; HPA-style autoscaling (cold start, scale-down stabilization) |
| Cache | One thread per shard + hit/miss split | Hot shard; misses go to the origin (outgoing edge); cache-aside write-back; the cache timeout covers only the cache operation |
| Database | Parallel execution slots + connection limit + read/write split | USL: S × (1 + α(N−1) + βN(N−1)); queueing bounded by max connections; failover |
| Message queue | Partitioned buffer + consumer group | Effective parallelism = min(consumers, partitions); rebalance pauses; failed messages retried, then dead-lettered |
| Call edge | Timeout, retries, circuit breaker, connection pool | Exponential backoff + full jitter; retry budget; three-state breaker; a pool per caller instance, counted against the database connection limit |

When a caller times out, the callee keeps working. The **wasted work** metric counts exactly that, and it is the root of retry storms and metastable failures.

## Known simplifications

- Every request to a service follows the same handler (no per-endpoint handlers); paths only matter for gateway routing
- Network latency is sampled independently; there is no bandwidth or packet-loss model
- A cache's origin calls hang off the cache node's outgoing edges, and connection pools are counted per original caller instance
- The analytical layer ignores retries and faults; it is a steady-state reference, and the simulation is the source of truth for dynamics

## Adding a component

1. Declare its parameters and fault types in `NODE_SPECS` in `specs.ts`, with labels and help as `L('中文', 'English')` (the form appears automatically)
2. Add a handler in `deliver()` in `sim.ts`, built from `submit()` (instance pool), `callEdge()` (downstream calls) and `intensity()` (fault intensity)
3. For capacity estimates, add a branch to `latencyOf()` in `analysis.ts`
4. Add an icon in `Glyph.tsx` and list it in `PALETTE` in `App.tsx`

## Packaging as a desktop app

The engine does not depend on the DOM, so `dist/` can be wrapped directly with Tauri or Electron. For larger simulations, `src/engine` can be ported to Rust behind the same interface, using the output of `npm run sim` as the reference baseline.
