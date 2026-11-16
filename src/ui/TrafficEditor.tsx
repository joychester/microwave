import { useMemo } from 'react';
import {
  MODEL, MODELS, defaultLayer, evalProgram, isProgram, programFromLegacy, sampleProgram,
  type ModelKind, type ModelParam, type TrafficLayer, type TrafficProgram,
} from '../engine/traffic';
import type { NodeCfg } from '../engine/types';
import { useStore } from './store';
import { useRuns } from './runs';
import { NumberInput } from './ParamField';
import { useLang, useT } from './i18n';
import { fmtClock, fmtRate } from './format';

const UNIT: Record<ModelParam['unit'], string | undefined> = { rps: '/s', s: 's', '%': '%', x: '×', '': undefined };
const THUMB_SPAN: Partial<Record<ModelKind, number>> = { ramp: 300, step: 380, wave: 260, diurnal: 300, replay: 300, spike: 200, burst: 240, herd: 200, noise: 120 };

/** Small line drawing of a model's characteristic shape (default parameters). */
export function ModelThumb({ kind, w = 64, h = 26 }: { kind: ModelKind; w?: number; h?: number }) {
  const d = useMemo(() => {
    const role = MODEL[kind].role;
    const prog: TrafficProgram = role === 'base'
      ? { base: defaultLayer(kind), overlays: [] }
      : { base: defaultLayer('constant', { rps: 400 }), overlays: [defaultLayer(kind, kind === 'spike' ? { at: 60 } : kind === 'herd' ? { at: 50 } : kind === 'burst' ? { start: 20 } : {})] };
    const span = THUMB_SPAN[kind] ?? 240;
    const pts = sampleProgram(prog, span, 64);
    const max = Math.max(...pts.map((p) => p.v)) * 1.12 || 1;
    return pts.map((p, i) => `${i ? 'L' : 'M'}${((p.t / span) * (w - 4) + 2).toFixed(1)},${(h - 3 - (p.v / max) * (h - 6)).toFixed(1)}`).join(' ');
  }, [kind, w, h]);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="thumb">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function seedFor(kind: ModelKind, level: number): Record<string, number> {
  const v = Math.max(50, Math.round(level / 10) * 10);
  switch (kind) {
    case 'constant': return { rps: v };
    case 'ramp': return { from: Math.round(v * 0.3), to: v * 3 };
    case 'step': return { start: Math.round(v * 0.5), stepBy: Math.round(v * 0.4) };
    case 'wave': return { base: v, amplitude: Math.round(v * 0.6) };
    case 'diurnal': return { trough: Math.round(v * 0.3), peak: Math.round(v * 1.6) };
    case 'spike': return { extra: v * 3 };
    case 'burst': return { extra: v * 2 };
    default: return {};
  }
}

function Preview({ prog, now, span }: { prog: TrafficProgram; now: number; span: number }) {
  const t = useT();
  const W = 300, H = 112, PL = 36, PB = 16, PT = 8;
  const end = Math.max(span, now + 20);
  const start = now > span ? Math.max(0, now - span * 0.5) : 0;
  const win = end - start;
  const total = useMemo(() => {
    const out: { t: number; v: number }[] = [];
    for (let i = 0; i <= 180; i++) { const tt = start + (win * i) / 180; out.push({ t: tt, v: evalProgram(prog, tt) }); }
    return out;
  }, [prog, start, win]);
  const base = useMemo(() => total.map((p) => ({ t: p.t, v: evalProgram({ base: prog.base, overlays: [] }, p.t) })), [total, prog.base]);
  const max = Math.max(10, ...total.map((p) => p.v)) * 1.1;
  const x = (tt: number) => PL + ((tt - start) / win) * (W - PL - 4);
  const y = (v: number) => H - PB - (v / max) * (H - PB - PT);
  const line = (pts: { t: number; v: number }[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${line(total)} L${x(end).toFixed(1)},${y(0)} L${x(start).toFixed(1)},${y(0)} Z`;
  const nowV = evalProgram(prog, now);
  const showNow = now >= start && now <= end;
  const hasOverlays = prog.overlays.length > 0;
  return (
    <figure className="tp">
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('流量曲线预览', 'Traffic curve preview')}>
        {[0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PL} x2={W - 4} y1={y(max / 1.1 * f)} y2={y(max / 1.1 * f)} className="tp-grid" />
            <text x={PL - 5} y={y(max / 1.1 * f) + 3.5} className="tp-ax" textAnchor="end">{fmtRate(max / 1.1 * f)}</text>
          </g>
        ))}
        <line x1={PL} x2={W - 4} y1={y(0)} y2={y(0)} className="tp-base-axis" />
        <path d={area} className="tp-area" />
        {hasOverlays && <path d={line(base)} className="tp-baseline" />}
        <path d={line(total)} className="tp-line" />
        <text x={PL} y={H - 3} className="tp-ax">{fmtClock(start * 1000)}</text>
        <text x={W - 4} y={H - 3} className="tp-ax" textAnchor="end">{fmtClock(end * 1000)}</text>
        {showNow && (
          <g>
            <line x1={x(now)} x2={x(now)} y1={PT - 2} y2={y(0)} className="tp-now" />
            <circle cx={x(now)} cy={y(nowV)} r={3.6} className="tp-now-dot" />
            <text x={Math.min(W - 40, x(now) + 5)} y={PT + 7} className="tp-now-label">{t('现在', 'now')} {fmtRate(nowV)}/s</text>
          </g>
        )}
      </svg>
      {hasOverlays && <figcaption className="tp-cap"><i className="tp-key tp-key--total" />{t('总流量', 'Total')}<i className="tp-key tp-key--base" />{t('基础模型', 'Base model')}</figcaption>}
    </figure>
  );
}

function ParamGrid({ layer, onChange }: { layer: TrafficLayer; onChange: (p: Record<string, number>) => void }) {
  const lang = useLang();
  return (
    <div className="tm-params">
      {MODEL[layer.kind].params.map((prm) => (
        <label key={prm.key}>
          <span>{prm.label[lang]}</span>
          <NumberInput value={layer.p[prm.key]} min={prm.min} max={prm.max} step={prm.step ?? 1} unit={UNIT[prm.unit]} onCommit={(v) => onChange({ ...layer.p, [prm.key]: v })} />
        </label>
      ))}
    </div>
  );
}

export function TrafficEditor({ node, locked }: { node: NodeCfg; locked: boolean }) {
  const t = useT();
  const lang = useLang();
  const update = useStore((s) => s.updateNodeParams);
  const simTime = useStore((s) => s.simTime);
  const duration = useRuns((r) => r.duration);
  const prog: TrafficProgram = isProgram(node.params.traffic) ? node.params.traffic : programFromLegacy(node.params);
  const now = simTime / 1000;
  const setProg = (p: TrafficProgram) => update(node.id, { traffic: p });
  const level = evalProgram(prog, now) || evalProgram(prog, 0);

  const bases = MODELS.filter((m) => m.role === 'base');
  const overlays = MODELS.filter((m) => m.role === 'overlay');
  const cur = MODEL[prog.base.kind];

  if (locked) {
    return <p className="lock-note">{t('本关的流量由剧本控制，不能修改。', 'Traffic is scripted in this level and can’t be changed.')}</p>;
  }

  return (
    <div className="te">
      <Preview prog={prog} now={now} span={duration} />

      <div className="te-h">{t('基础模型', 'Base model')}</div>
      <div className="tm-grid" role="radiogroup" aria-label={t('基础流量模型', 'Base traffic model')}>
        {bases.map((m) => (
          <button key={m.kind} type="button" role="radio" aria-checked={prog.base.kind === m.kind}
            className={`tm${prog.base.kind === m.kind ? ' is-on' : ''}`} title={m.desc[lang]}
            onClick={() => prog.base.kind !== m.kind && setProg({ ...prog, base: defaultLayer(m.kind, seedFor(m.kind, level)) })}>
            <ModelThumb kind={m.kind} />
            <span>{m.label[lang]}</span>
          </button>
        ))}
      </div>
      <p className="te-desc">{cur.desc[lang]}<br /><b>{t('适合：', 'Use it for: ')}</b>{cur.use[lang]}</p>
      <ParamGrid layer={prog.base} onChange={(p) => setProg({ ...prog, base: { ...prog.base, p } })} />
      {prog.base.kind === 'replay' && (
        <label className="te-replay">
          <span>{t('回放数据（每行：秒,流量）', 'Replay data (one “seconds,rate” pair per line)')}</span>
          <textarea rows={5} defaultValue={prog.base.text} spellCheck={false}
            onBlur={(e) => setProg({ ...prog, base: { ...prog.base, text: e.target.value } })} />
        </label>
      )}

      <div className="te-h">{t('叠加层', 'Overlays')}<span className="te-h-note">{t('可叠加多层，与基础模型相加或相乘', 'Stack as many as you like on top of the base')}</span></div>
      <div className="tm-add">
        {overlays.map((m) => (
          <button key={m.kind} type="button" className="tm-chip" title={m.desc[lang]}
            onClick={() => {
              const seed = seedFor(m.kind, level);
              if (MODEL[m.kind].triggerable) seed.at = Math.round(now + 15);
              if (m.kind === 'burst') seed.start = Math.round(now + 10);
              setProg({ ...prog, overlays: [...prog.overlays, defaultLayer(m.kind, seed)] });
            }}>
            <ModelThumb kind={m.kind} w={34} h={16} />
            <span>+ {m.label[lang]}</span>
          </button>
        ))}
      </div>
      {prog.overlays.map((o, i) => {
        const m = MODEL[o.kind];
        const setO = (no: TrafficLayer) => setProg({ ...prog, overlays: prog.overlays.map((x, j) => (j === i ? no : x)) });
        return (
          <div key={o.id} className="tm-ov">
            <div className="tm-ov-head">
              <ModelThumb kind={o.kind} w={40} h={18} />
              <b>{m.label[lang]}</b>
              <span className="tm-ov-use">{m.use[lang]}</span>
              {m.triggerable && (
                <button type="button" className="btn btn--fault tm-fire" onClick={() => setO({ ...o, p: { ...o.p, at: Math.round(now + 1) } })}>
                  {t('现在触发', 'Fire now')}
                </button>
              )}
              <button type="button" className="icon-btn" aria-label={t(`移除${m.label.zh}`, `Remove ${m.label.en}`)} onClick={() => setProg({ ...prog, overlays: prog.overlays.filter((_, j) => j !== i) })}>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              </button>
            </div>
            <ParamGrid layer={o} onChange={(p) => setO({ ...o, p })} />
          </div>
        );
      })}
    </div>
  );
}
