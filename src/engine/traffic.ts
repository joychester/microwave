// Traffic models: one base shape plus any number of overlays, evaluated as
//   rps(t) = max(0, (base(t) + Σ additive overlays(t)) × Π multiplicative overlays(t))
// t is simulated seconds since the run started. Every number is editable live.
import { L, type Text } from './types';

export type ModelKind =
  | 'constant' | 'ramp' | 'step' | 'wave' | 'diurnal' | 'replay'
  | 'spike' | 'burst' | 'herd' | 'noise';

export interface TrafficLayer {
  id: string;
  kind: ModelKind;
  p: Record<string, number>;
  text?: string; // replay data
}

export interface TrafficProgram {
  base: TrafficLayer;
  overlays: TrafficLayer[];
}

export interface ModelParam { key: string; label: Text; unit: 'rps' | 's' | '%' | 'x' | ''; def: number; min: number; max: number; step?: number }

export interface ModelSpec {
  kind: ModelKind;
  role: 'base' | 'overlay';
  label: Text;
  desc: Text;
  use: Text; // what question it answers
  params: ModelParam[];
  triggerable?: boolean; // overlay with an "at" time that can be fired now
}

const P = (key: string, zh: string, en: string, unit: ModelParam['unit'], def: number, min: number, max: number, step?: number): ModelParam =>
  ({ key, label: L(zh, en), unit, def, min, max, step });

export const MODELS: ModelSpec[] = [
  {
    kind: 'constant', role: 'base',
    label: L('恒定', 'Constant'),
    desc: L('一条平线，长时间保持同一流量', 'A flat line held for the whole run'),
    use: L('浸泡测试：长时间稳不稳，有没有慢慢积累的问题', 'Soak test: is it stable over time, does anything slowly build up'),
    params: [P('rps', '流量', 'Rate', 'rps', 400, 0, 50000, 10)],
  },
  {
    kind: 'ramp', role: 'base',
    label: L('线性爬坡', 'Ramp'),
    desc: L('从起点线性变化到终点，然后保持。终点小于起点就是回落', 'Linear change from start to end, then hold. End below start ramps down'),
    use: L('找拐点：流量到多少时 SLO 开始被打破', 'Find the knee: at what rate the SLO starts to break'),
    params: [
      P('from', '起始流量', 'From', 'rps', 100, 0, 50000, 10),
      P('to', '结束流量', 'To', 'rps', 1500, 0, 50000, 10),
      P('start', '开始于', 'Starts at', 's', 10, 0, 3600),
      P('duration', '爬坡时长', 'Ramp length', 's', 240, 1, 3600),
    ],
  },
  {
    kind: 'step', role: 'base',
    label: L('阶梯', 'Steps'),
    desc: L('每隔一段时间加一档，每档保持稳定', 'Adds one level every interval and holds it'),
    use: L('经典压测：看每个负载档位的稳态表现', 'Classic load test: steady state at each load level'),
    params: [
      P('start', '起始流量', 'Starting rate', 'rps', 200, 0, 50000, 10),
      P('stepBy', '每档增加', 'Step size', 'rps', 200, -50000, 50000, 10),
      P('every', '每档时长', 'Step length', 's', 60, 5, 3600),
      P('steps', '档数', 'Steps', '', 6, 1, 100),
    ],
  },
  {
    kind: 'wave', role: 'base',
    label: L('正弦波', 'Wave'),
    desc: L('围绕基线上下起伏的周期波动', 'Periodic swings around a baseline'),
    use: L('自动扩缩容跟不跟得上，冷启动滞后多大', 'Does autoscaling keep up, how big is the cold-start lag'),
    params: [
      P('base', '基线', 'Baseline', 'rps', 600, 0, 50000, 10),
      P('amplitude', '振幅', 'Amplitude', 'rps', 400, 0, 50000, 10),
      P('period', '周期', 'Period', 's', 120, 5, 7200),
    ],
  },
  {
    kind: 'diurnal', role: 'base',
    label: L('日周期', 'Daily cycle'),
    desc: L('从低谷开始，平滑升到高峰再回落，像压缩后的一天', 'Starts at the trough, rises smoothly to the peak and back, like a compressed day'),
    use: L('一天里的高峰低谷，容量是否按时到位', 'Peak and off-peak hours: is capacity there in time'),
    params: [
      P('trough', '低谷', 'Trough', 'rps', 150, 0, 50000, 10),
      P('peak', '高峰', 'Peak', 'rps', 1200, 0, 50000, 10),
      P('period', '一天长度', 'Day length', 's', 300, 30, 7200),
    ],
  },
  {
    kind: 'replay', role: 'base',
    label: L('真实回放', 'Replay'),
    desc: L('粘贴“秒,流量”数据（可从 Prometheus 导出），按折线回放', 'Paste “seconds,rate” pairs (e.g. from Prometheus) and replay them'),
    use: L('用真实的一天验证配置，也是校准的入口', 'Validate against a real day; also the way in for calibration'),
    params: [P('scale', '整体倍数', 'Scale', 'x', 1, 0, 100, 0.1), P('loop', '循环播放', 'Loop', '', 1, 0, 1, 1)],
  },
  // ---- overlays
  {
    kind: 'spike', role: 'overlay', triggerable: true,
    label: L('尖峰', 'Spike'),
    desc: L('在某一时刻瞬间冲高，保持一会儿再落回', 'Jumps up at a moment, holds briefly, falls back'),
    use: L('秒杀、热点事件：突发能不能扛住，限流和队列是否生效', 'Flash sale or breaking news: does the burst get absorbed, do limits and queues work'),
    params: [
      P('at', '时刻', 'At', 's', 90, 0, 7200),
      P('extra', '额外流量', 'Extra rate', 'rps', 1500, 0, 100000, 50),
      P('rise', '上升', 'Rise', 's', 2, 0, 600),
      P('hold', '保持', 'Hold', 's', 20, 0, 3600),
      P('fall', '回落', 'Fall', 's', 10, 0, 600),
    ],
  },
  {
    kind: 'burst', role: 'overlay',
    label: L('周期突发', 'Periodic bursts'),
    desc: L('每隔固定时间来一小段突发', 'A short burst at a fixed interval'),
    use: L('整点任务、定时推送、批处理', 'Cron jobs, scheduled pushes, batch work'),
    params: [
      P('every', '间隔', 'Every', 's', 60, 2, 3600),
      P('duration', '持续', 'Lasts', 's', 8, 1, 3600),
      P('extra', '额外流量', 'Extra rate', 'rps', 800, 0, 100000, 50),
      P('start', '首次于', 'First at', 's', 30, 0, 3600),
    ],
  },
  {
    kind: 'herd', role: 'overlay', triggerable: true,
    label: L('惊群回涌', 'Thundering herd'),
    desc: L('入口中断一段时间后恢复，积压的用户和重试同时涌回', 'The entry point goes dark, then everyone who waited comes back at once'),
    use: L('故障恢复瞬间会不会二次雪崩', 'Does recovery itself trigger a second collapse'),
    params: [
      P('at', '中断于', 'Outage at', 's', 60, 0, 7200),
      P('outage', '中断时长', 'Outage length', 's', 20, 1, 600),
      P('surge', '回涌倍数', 'Surge', 'x', 3, 1, 20, 0.5),
      P('decay', '回落时长', 'Settles over', 's', 30, 1, 600),
    ],
  },
  {
    kind: 'noise', role: 'overlay',
    label: L('随机抖动', 'Jitter'),
    desc: L('在曲线上叠加平滑的随机波动', 'Smooth random variation on top of the curve'),
    use: L('真实流量从来不是一条光滑的线', 'Real traffic is never a smooth line'),
    params: [P('pct', '幅度', 'Amount', '%', 15, 0, 100, 1), P('scale', '变化快慢', 'Change every', 's', 3, 1, 120)],
  },
];

export const MODEL = Object.fromEntries(MODELS.map((m) => [m.kind, m])) as Record<ModelKind, ModelSpec>;

export function defaultLayer(kind: ModelKind, overrides: Record<string, number> = {}): TrafficLayer {
  const p: Record<string, number> = {};
  for (const prm of MODEL[kind].params) p[prm.key] = prm.def;
  const layer: TrafficLayer = { id: `${kind}-${Math.random().toString(36).slice(2, 7)}`, kind, p: { ...p, ...overrides } };
  if (kind === 'replay') layer.text = SAMPLE_REPLAY;
  return layer;
}

export const SAMPLE_REPLAY = `0,220
30,260
60,380
90,520
120,700
150,940
180,1100
210,1050
240,820
270,600
300,420`;

// ---------------------------------------------------------------- evaluation
const replayCache = new Map<string, [number, number][]>();
export function parseReplay(text: string): [number, number][] {
  const hit = replayCache.get(text);
  if (hit) return hit;
  const pts: [number, number][] = [];
  for (const line of text.split(/\r?\n/)) {
    const nums = line.split(/[,;\s:]+/).map(Number).filter((x) => isFinite(x));
    if (nums.length >= 2) pts.push([nums[0], Math.max(0, nums[1])]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  if (pts.length === 1) pts.push([pts[0][0] + 1, pts[0][1]]);
  replayCache.set(text, pts);
  return pts;
}

function lerpPoints(pts: [number, number][], t: number): number {
  if (pts.length === 0) return 0;
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i][0]) {
      const [t0, v0] = pts[i - 1];
      const [t1, v1] = pts[i];
      return v0 + ((v1 - v0) * (t - t0)) / Math.max(1e-9, t1 - t0);
    }
  }
  return pts[pts.length - 1][1];
}

// smooth value noise in [-1, 1]
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}
function smoothNoise(t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}

function evalBase(l: TrafficLayer, t: number): number {
  const p = l.p;
  switch (l.kind) {
    case 'constant': return p.rps;
    case 'ramp': {
      if (t <= p.start) return p.from;
      const f = Math.min(1, (t - p.start) / Math.max(1e-9, p.duration));
      return p.from + (p.to - p.from) * f;
    }
    case 'step': {
      const k = Math.min(Math.max(1, Math.round(p.steps)) - 1, Math.floor(t / Math.max(1, p.every)));
      return p.start + p.stepBy * Math.max(0, k);
    }
    case 'wave': return p.base + p.amplitude * Math.sin((2 * Math.PI * t) / Math.max(1, p.period));
    case 'diurnal': return p.trough + (p.peak - p.trough) * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / Math.max(1, p.period)));
    case 'replay': {
      const pts = parseReplay(l.text ?? '');
      if (pts.length === 0) return 0;
      const span = pts[pts.length - 1][0] - pts[0][0];
      const tt = p.loop && span > 0 ? pts[0][0] + ((t - pts[0][0]) % span + span) % span : t;
      return lerpPoints(pts, tt) * p.scale;
    }
    default: return 0;
  }
}

function evalOverlay(l: TrafficLayer, t: number): { add: number; mul: number } {
  const p = l.p;
  switch (l.kind) {
    case 'spike': {
      const t0 = p.at;
      let f = 0;
      if (t >= t0 && t < t0 + p.rise) f = p.rise > 0 ? (t - t0) / p.rise : 1;
      else if (t >= t0 + p.rise && t < t0 + p.rise + p.hold) f = 1;
      else if (t >= t0 + p.rise + p.hold && t < t0 + p.rise + p.hold + p.fall) f = p.fall > 0 ? 1 - (t - t0 - p.rise - p.hold) / p.fall : 0;
      return { add: p.extra * f, mul: 1 };
    }
    case 'burst': {
      if (t < p.start) return { add: 0, mul: 1 };
      const phase = (t - p.start) % Math.max(1, p.every);
      return { add: phase < p.duration ? p.extra : 0, mul: 1 };
    }
    case 'herd': {
      if (t < p.at) return { add: 0, mul: 1 };
      if (t < p.at + p.outage) return { add: 0, mul: 0.02 };
      const f = Math.max(0, 1 - (t - p.at - p.outage) / Math.max(1, p.decay));
      return { add: 0, mul: 1 + (p.surge - 1) * f };
    }
    case 'noise': return { add: 0, mul: 1 + (p.pct / 100) * smoothNoise(t / Math.max(0.5, p.scale)) };
    default: return { add: 0, mul: 1 };
  }
}

export function evalProgram(prog: TrafficProgram, t: number): number {
  let add = evalBase(prog.base, t);
  let mul = 1;
  for (const o of prog.overlays) {
    const r = evalOverlay(o, t);
    add += r.add;
    mul *= r.mul;
  }
  return Math.max(0, add * mul);
}

/** Legacy client params (rps + pattern) expressed as a program. */
export function programFromLegacy(p: Record<string, unknown>): TrafficProgram {
  const rps = Number(p.rps ?? 300);
  const pattern = String(p.pattern ?? 'constant');
  if (pattern === 'diurnal') {
    return { base: defaultLayer('diurnal', { peak: rps, trough: rps * Number(p.diurnalTrough ?? 0.3), period: Number(p.diurnalPeriod ?? 300) }), overlays: [] };
  }
  const prog: TrafficProgram = { base: defaultLayer('constant', { rps }), overlays: [] };
  if (pattern === 'burst') {
    prog.overlays.push(defaultLayer('burst', {
      every: Number(p.burstEvery ?? 60), duration: Number(p.burstDur ?? 10),
      extra: rps * (Number(p.burstMult ?? 3) - 1), start: Number(p.burstEvery ?? 60),
    }));
  }
  return prog;
}

export function isProgram(v: unknown): v is TrafficProgram {
  return !!v && typeof v === 'object' && 'base' in (v as object) && 'overlays' in (v as object);
}

/** Sample a program for previews. */
export function sampleProgram(prog: TrafficProgram, span: number, n = 160): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (span * i) / n;
    out.push({ t, v: evalProgram(prog, t) });
  }
  return out;
}

export function describeProgram(prog: TrafficProgram, lang: 'zh' | 'en'): string {
  const parts = [MODEL[prog.base.kind].label[lang], ...prog.overlays.map((o) => MODEL[o.kind].label[lang])];
  return parts.join(' + ');
}
