// Learning mode: guided lessons. A lesson is a starting topology plus a list of steps.
// Each step is checked against the live store, so the learner can do it any way they like.
import type { FailureView, Selection } from '../ui/store';
import type { Lang, Snapshot, Text, Topology } from '../engine/types';

/** Averages over a measured window of the run. */
export interface Measure {
  rps: number;
  avg: number; // mean end-to-end latency, ms
  p95: number; // ms
  avail: number; // 0..1
  cpu: number; // CPU utilization of the lesson's main service, 0..1
  instances: number;
}

export interface LessonCtx {
  lang: Lang;
  topo: Topology;
  selection: Selection;
  running: boolean;
  /** Sim seconds. */
  now: number;
  failures: FailureView[];
  latest: Snapshot | null;
  dockOpen: boolean;
  dockTab: string;
  /** Measurements recorded by earlier steps, by key. */
  meas: Record<string, Measure>;
  /** Chosen option index of each prediction step, by step id. */
  answers: Record<string, number>;
}

type Dyn<T> = T | ((c: LessonCtx) => T);

interface StepBase {
  id: string;
  title: Text;
  body: Dyn<Text>;
  /** CSS selector of the UI element to point at. */
  highlight?: Dyn<string | null>;
}

/** The learner does something; the step completes when `check` holds (for `hold` sim seconds, if set). */
export interface DoStep extends StepBase {
  kind: 'do';
  check: (c: LessonCtx) => boolean;
  /** Seconds of simulated time the condition must hold. */
  hold?: number;
  /** Seconds at the start of the hold left out of the measurement (the system settling). */
  settle?: number;
  /** Record the measured window under this key. */
  measure?: string;
  /** Measure several settings in turn (e.g. traffic levels); each is recorded as `${key}${value}`. */
  sweep?: Sweep;
  /** Shown once the step is done. */
  feedback?: Dyn<Text>;
}

/** A step that measures one setting after another: the step is done when every value is measured. */
export interface Sweep {
  values: number[];
  key: string;
  /** The setting's current value on the workbench. */
  value: (c: LessonCtx) => number;
}

/** The next value of a sweep still to be measured, if any. */
export function sweepNext(sw: Sweep, meas: Record<string, Measure>): number | undefined {
  return sw.values.find((v) => !meas[`${sw.key}${v}`]);
}

export interface PredictOption {
  label: Text;
  /** Range of the measured value this option stands for: [low, high). */
  range: [number, number];
}

/** A multiple-choice prediction, answered before the run that reveals it. */
export interface PredictStep extends StepBase {
  kind: 'predict';
  options: PredictOption[];
}

/** Text only, with a Next button. The last step of a lesson is one of these. */
export interface ReadStep extends StepBase {
  kind: 'read';
}

export type Step = DoStep | PredictStep | ReadStep;

export interface Lesson {
  id: string;
  num: number;
  title: Text;
  summary: Text;
  minutes: number;
  make: (lang: Lang) => Topology;
  /** Simulation speed while the lesson runs. */
  speed?: number;
  steps: Step[];
  /** Challenge level to try next, if any. */
  challenge?: string;
  /** Points for the lesson's live chart (x = traffic, y = average latency), once there are any. */
  curve?: (c: LessonCtx) => CurvePoint[];
}

export interface CurvePoint { x: number; y: number; cpu: number }

/** A lesson that is planned but not written yet; shown in the list as coming soon. */
export interface PlannedLesson {
  id: string;
  num: number;
  title: Text;
  summary: Text;
}

export function dyn<T>(v: Dyn<T>, c: LessonCtx): T {
  return typeof v === 'function' ? (v as (c: LessonCtx) => T)(c) : v;
}
