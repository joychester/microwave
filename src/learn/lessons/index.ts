import { L } from '../../engine/types';
import type { Lesson, PlannedLesson } from '../types';
import { lesson01 } from './l01-workbench';

export const LESSONS: Lesson[] = [lesson01];

/** The rest of the course, shown as coming soon. */
export const PLANNED: PlannedLesson[] = [
  { id: 'l02', num: 2, title: L('排队与利用率', 'Queueing and utilization'), summary: L('利用率过了 80% 以后，为什么流量多一点点，延迟就翻倍。', 'Why, past about 80% utilization, a little more traffic doubles the latency.') },
  { id: 'l03', num: 3, title: L('数据库与连接池', 'Databases and connection pools'), summary: L('服务 CPU 很闲，却因为等数据库而很慢。', 'A service with idle CPU that is slow because it waits on the database.') },
  { id: 'l04', num: 4, title: L('缓存', 'Caching'), summary: L('命中率从 90% 降到 70%，数据库负载变成 3 倍。', 'Hit ratio drops from 90% to 70% and database load triples.') },
  { id: 'l05', num: 5, title: L('超时与重试', 'Timeouts and retries'), summary: L('下游只慢了 3 倍，重试却把它彻底压垮。', 'The downstream is only 3× slower, but retries finish it off.') },
  { id: 'l06', num: 6, title: L('异步与消息队列', 'Async and message queues'), summary: L('接口很快，积压却在悄悄增长。', 'The API is fast while the backlog quietly grows.') },
  { id: 'l07', num: 7, title: L('容量规划', 'Capacity planning'), summary: L('估算、找上限、留余量，把前面学的串起来。', 'Estimate, find the limit, keep headroom: everything so far, together.') },
];

export function lessonById(id: string | null): Lesson | null {
  return LESSONS.find((l) => l.id === id) ?? null;
}
