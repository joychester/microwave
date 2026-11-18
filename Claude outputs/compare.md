# SimBench comparison: #1 → #3

### #1
- Topology: E-commerce checkout reference
- Duration: 01:00
- Traffic: User traffic: Constant
- Requests: 30k, peak entry rate 540/s

### #3
- Topology: E-commerce checkout reference
- Duration: 01:00
- Traffic: User traffic: Constant
- Requests: 29k, peak entry rate 548/s

## What changed

- Catalog service: Instances: 6 → 8
- Orders service: Instances: 3 → 5

## Results

| Metric | #1 | #3 | Change |
|---|---|---|---|
| Availability | 100% | 100% | same |
| Avg latency | 62ms | 62ms | ▼ 0.7ms (better) |
| Peak p95 | 333ms | 327ms | ▼ 5.8ms (better) |
| Time within SLO | 100% | 100% | same |
| Knee point | None | None | — |
| First to saturate | None | None | — |
| Avg. cost | $5.05/h | $5.85/h | ▲ $0.80 (worse) |
| Max Kafka lag | 55 | 41 | ▼ 14 (better) |

## Components

| Component | Peak util. #1 | #3 | p95 peak #1 | #3 | Failures #1 | #3 |
|---|---|---|---|---|---|---|
| Fulfillment service | 51% | 52% | 125ms | 109ms | 0 | 0 |
| Postgres | 39% | 37% | 23ms | 22ms | 0 | 0 |
| Catalog service | 44% | 33% | 51ms | 57ms | 0 | 0 |
| Payment provider API | 31% | 30% | 840ms | 674ms | 10 | 10 |
| Orders service | 38% | 21% | 672ms | 610ms | 11 | 10 |
| Pricing service | 18% | 17% | 8.1ms | 8.4ms | 0 | 0 |
| Redis | 9% | 9% | 5.4ms | 5.5ms | 0 | 0 |
| API Gateway | 2% | 2% | 332ms | 326ms | 12 | 10 |
| Catalog LB | 0% | 0% | 56ms | 56ms | 0 | 0 |
| Orders LB | 0% | 0% | 674ms | 612ms | 12 | 10 |
| Kafka order events | 0% | 0% | 736ms | 593ms | 0 | 0 |
