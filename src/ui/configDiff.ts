// What changed between the configurations of two runs: components and calls added or removed,
// and every parameter whose value differs (traffic programs included). Positions are ignored.
import { EDGE_SPECS, NODE_SPECS, withDefaults, type ParamSpec } from '../engine/specs';
import { MODELS, isProgram, programFromLegacy, type TrafficLayer, type TrafficProgram } from '../engine/traffic';
import { L, type Dist, type NodeCfg, type Text, type Topology } from '../engine/types';
import { fmtLatency } from './format';

export interface ConfigChange {
  /** Component name, or "A → B" for a call. */
  where: string;
  kind: 'added' | 'removed' | 'changed';
  what?: Text;
  from?: string;
  to?: string;
}

type Lang = 'zh' | 'en';
// legacy flat traffic params on a traffic source; the traffic program supersedes them
const LEGACY_TRAFFIC = new Set(['rps', 'pattern', 'burstMult', 'burstEvery', 'burstDur', 'diurnalPeriod', 'diurnalTrough']);

function distText(d: Dist): string {
  switch (d.dist) {
    case 'constant': return fmtLatency(d.value);
    case 'exponential': return `exp ${fmtLatency(d.mean)}`;
    case 'lognormal': return `${fmtLatency(d.median)} / p99 ${fmtLatency(d.p99)}`;
  }
}

function layerText(l: TrafficLayer, lang: Lang): string {
  const spec = MODELS.find((m) => m.kind === l.kind);
  if (!spec) return l.kind;
  const ps = spec.params.map((p) => {
    const v = l.p[p.key] ?? p.def;
    const unit = p.unit === 'rps' ? '/s' : p.unit === 's' ? 's' : p.unit === '%' ? '%' : p.unit === 'x' ? '×' : '';
    return `${p.label[lang]} ${v}${unit}`;
  });
  return ps.length ? `${spec.label[lang]} (${ps.join(lang === 'en' ? ', ' : '，')})` : spec.label[lang];
}

export function programText(prog: TrafficProgram, lang: Lang): string {
  return [prog.base, ...prog.overlays].map((l) => layerText(l, lang)).join(' + ');
}

function valueText(spec: ParamSpec, v: unknown, lang: Lang): string {
  if (v === undefined || v === null) return '—';
  switch (spec.kind) {
    case 'dist': return distText(v as Dist);
    case 'bool': return v ? (lang === 'en' ? 'on' : '开') : (lang === 'en' ? 'off' : '关');
    case 'enum': return spec.options?.find((o) => o.value === v)?.label[lang] ?? String(v);
    case 'ratio': return `${(Number(v) * 100).toFixed(Number(v) * 100 % 1 ? 1 : 0)}%`;
    case 'ms': return fmtLatency(Number(v));
    case 'seconds': return `${v}s`;
    case 'pathmix': return String(v).split(',').map((x) => x.replace(/:\s*([\d.]+)$/, ' $1%')).join(', ');
    default: return String(v);
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function trafficOf(n: NodeCfg): TrafficProgram {
  return isProgram(n.params.traffic) ? n.params.traffic : programFromLegacy(n.params);
}

/** Changes that take configuration `a` (the earlier run) to `b` (the later one). */
export function diffConfigs(a: Topology, b: Topology, lang: Lang): ConfigChange[] {
  const out: ConfigChange[] = [];
  const an = new Map(a.nodes.map((n) => [n.id, n]));
  const bn = new Map(b.nodes.map((n) => [n.id, n]));
  const nameOf = (id: string) => bn.get(id)?.name ?? an.get(id)?.name ?? id;

  for (const n of b.nodes) if (!an.has(n.id)) out.push({ where: n.name, kind: 'added' });
  for (const n of a.nodes) if (!bn.has(n.id)) out.push({ where: n.name, kind: 'removed' });

  for (const nb of b.nodes) {
    const na = an.get(nb.id);
    if (!na || na.type !== nb.type) continue;
    if (na.name !== nb.name) out.push({ where: nb.name, kind: 'changed', what: L('名称', 'Name'), from: na.name, to: nb.name });
    if (nb.type === 'client') {
      const ta = trafficOf(na), tb = trafficOf(nb);
      // layer ids are internal and the program may have been rebuilt from legacy fields: compare the shape only
      const shape = (pr: TrafficProgram) => [pr.base, ...pr.overlays].map((l) => [l.kind, l.p, l.text ?? '']);
      if (!same(shape(ta), shape(tb))) out.push({ where: nb.name, kind: 'changed', what: L('流量模型', 'Traffic model'), from: programText(ta, lang), to: programText(tb, lang) });
    }
    const specs = NODE_SPECS[nb.type].params;
    const pa = withDefaults(specs, na.params), pb = withDefaults(specs, nb.params);
    for (const s of specs) {
      if (nb.type === 'client' && LEGACY_TRAFFIC.has(s.key)) continue; // covered by the traffic program
      if (!same(pa[s.key], pb[s.key])) out.push({ where: nb.name, kind: 'changed', what: s.label, from: valueText(s, pa[s.key], lang), to: valueText(s, pb[s.key], lang) });
    }
  }

  const ea = new Map(a.edges.map((e) => [e.id, e]));
  const eb = new Map(b.edges.map((e) => [e.id, e]));
  const arrow = (from: string, to: string) => `${nameOf(from)} → ${nameOf(to)}`;
  for (const e of b.edges) if (!ea.has(e.id)) out.push({ where: arrow(e.from, e.to), kind: 'added' });
  for (const e of a.edges) if (!eb.has(e.id)) out.push({ where: arrow(e.from, e.to), kind: 'removed' });
  for (const e of b.edges) {
    const prev = ea.get(e.id);
    if (!prev) continue;
    const pa = withDefaults(EDGE_SPECS, prev.params), pb = withDefaults(EDGE_SPECS, e.params);
    for (const s of EDGE_SPECS) {
      if (!same(pa[s.key], pb[s.key])) out.push({ where: arrow(e.from, e.to), kind: 'changed', what: s.label, from: valueText(s, pa[s.key], lang), to: valueText(s, pb[s.key], lang) });
    }
  }
  return out;
}
