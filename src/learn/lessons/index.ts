import { L } from '../../engine/types';
import type { Lesson, PlannedLesson } from '../types';
import { lesson01 } from './l01-workbench';
import { lesson02 } from './l02-utilization';
import { lesson03 } from './l03-scaling';
import { lesson04 } from './l04-db-pool';
import { lesson05 } from './l05-cache';
import { lesson06 } from './l06-autoscale';

export const LESSONS: Lesson[] = [lesson01, lesson02, lesson03, lesson04, lesson05, lesson06];

/** The rest of the course, shown as coming soon. */
export const PLANNED: PlannedLesson[] = [
  { id: 'l07', num: 7, title: L('超时与重试', 'Timeouts and retries'), summary: L('下游只慢了 3 倍，重试却把它彻底压垮。', 'The downstream is only 3× slower, but retries finish it off.') },
  { id: 'l08', num: 8, title: L('异步与消息队列', 'Async and message queues'), summary: L('接口很快，积压却在悄悄增长。', 'The API is fast while the backlog quietly grows.') },
  { id: 'l09', num: 9, title: L('容量规划', 'Capacity planning'), summary: L('估算、找上限、留余量，把前面学的串起来。', 'Estimate, find the limit, keep headroom: everything so far, together.') },
];

export function lessonById(id: string | null): Lesson | null {
  return LESSONS.find((l) => l.id === id) ?? null;
}
