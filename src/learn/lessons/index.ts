import { L } from '../../engine/types';
import type { Lesson, PlannedLesson } from '../types';
import { lesson01 } from './l01-workbench';
import { lesson02 } from './l02-utilization';
import { lesson03 } from './l03-scaling';
import { lesson04 } from './l04-db-pool';
import { lesson05 } from './l05-cache';
import { lesson06 } from './l06-autoscale';
import { lesson07 } from './l07-retries';
import { lesson08 } from './l08-queues';
import { lesson09 } from './l09-monolith';

export const LESSONS: Lesson[] = [lesson01, lesson02, lesson03, lesson04, lesson05, lesson06, lesson07, lesson08, lesson09];

/** The rest of the course, shown as coming soon. */
export const PLANNED: PlannedLesson[] = [
  { id: 'l10', num: 10, title: L('容量规划', 'Capacity planning'), summary: L('估算、找上限、留余量，把前面学的串起来。', 'Estimate, find the limit, keep headroom: everything so far, together.') },
];

export function lessonById(id: string | null): Lesson | null {
  return LESSONS.find((l) => l.id === id) ?? null;
}
