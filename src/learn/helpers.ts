import type { EdgeCfg, NodeCfg, Text } from '../engine/types';
import type { LessonCtx, PredictOption } from './types';
import { evalProgram, isProgram, programFromLegacy } from '../engine/traffic';

/** The service the traffic source calls first: the subject of the early lessons. */
export function mainService(c: LessonCtx): NodeCfg | undefined {
  const byId = new Map(c.topo.nodes.map((n) => [n.id, n]));
  for (const e of c.topo.edges) {
    const from = byId.get(e.from), to = byId.get(e.to);
    if (from?.type === 'client' && to?.type === 'service') return to;
  }
  return undefined;
}

/** The first component of a type, e.g. the lesson's database. */
export function firstOfType(c: LessonCtx, type: string): NodeCfg | undefined {
  return c.topo.nodes.find((n) => n.type === type);
}

/** The edge from one component to another, if they are connected. */
export function edgeBetween(c: LessonCtx, from?: NodeCfg, to?: NodeCfg): EdgeCfg | undefined {
  return from && to ? c.topo.edges.find((e) => e.from === from.id && e.to === to.id) : undefined;
}

/** A traffic source connected to a service. */
export function hasLink(c: LessonCtx): boolean {
  return !!mainService(c);
}

/** "Your prediction: X. Actual: Y." with a verdict, for a prediction step answered earlier. */
export function reveal(c: LessonCtx, stepId: string, actual: number, options: PredictOption[]): Text {
  const i = c.answers[stepId];
  const hit = options.findIndex((o) => actual >= o.range[0] && actual < o.range[1]);
  if (i === undefined || hit < 0) return { zh: '', en: '' };
  const mine = options[i].label;
  if (i === hit) return { zh: `你的预测是"${mine.zh}"，猜对了。`, en: `You predicted "${mine.en}": right.` };
  const right = options[hit].label;
  return {
    zh: `你的预测是"${mine.zh}"，实际落在"${right.zh}"。猜错是好事，它说明这里有值得弄懂的地方。`,
    en: `You predicted "${mine.en}"; the actual answer is "${right.en}". A wrong guess is useful: it marks something worth understanding.`,
  };
}

/** The traffic source's current rate (req/s), read from its traffic model the way the simulator does. */
export function trafficRate(c: LessonCtx): number {
  const client = c.topo.nodes.find((n) => n.type === 'client');
  if (!client) return 0;
  const prog = isProgram(client.params.traffic) ? client.params.traffic : programFromLegacy(client.params);
  return Math.round(evalProgram(prog, c.now));
}
