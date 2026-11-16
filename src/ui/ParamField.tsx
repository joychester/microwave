import { useEffect, useId, useState } from 'react';
import type { ParamSpec } from '../engine/specs';
import type { Dist, ParamValue } from '../engine/types';
import { useLang, useT } from './i18n';

const UNIT: Partial<Record<ParamSpec['kind'], string>> = { ms: 'ms', seconds: 's', ratio: '%' };

function NumberInput({ value, onCommit, min, max, step, unit, id, scale = 1, disabled }: {
  value: number; onCommit: (v: number) => void; min?: number; max?: number; step?: number; unit?: string; id?: string; scale?: number; disabled?: boolean;
}) {
  const shown = +(value * scale).toPrecision(6);
  const [text, setText] = useState(String(shown));
  useEffect(() => { setText(String(shown)); }, [shown]);
  const commit = (raw: string) => {
    const v = Number(raw);
    if (raw.trim() === '' || !isFinite(v)) { setText(String(shown)); return; }
    let x = v / scale;
    if (min !== undefined) x = Math.max(min, x);
    if (max !== undefined) x = Math.min(max, x);
    onCommit(x);
    setText(String(+(x * scale).toPrecision(6)));
  };
  return (
    <span className="num">
      <input
        id={id}
        disabled={disabled}
        inputMode="decimal"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() !== '' && isFinite(v) && (min === undefined || v / scale >= min) && (max === undefined || v / scale <= max)) onCommit(v / scale);
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const st = (step ?? 1) * (e.shiftKey ? 10 : 1);
            const next = value + (e.key === 'ArrowUp' ? st : -st);
            commit(String(next * scale));
          }
        }}
      />
      {unit && <span className="num-unit">{unit}</span>}
    </span>
  );
}

const Lock = () => (
  <svg className="pf-lock" width="11" height="11" viewBox="0 0 14 14" aria-hidden="true"><rect x="2.5" y="6" width="9" height="6.5" rx="1.5" fill="currentColor" /><path d="M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
);

export function ParamField({ spec, value, onChange, disabled }: { spec: ParamSpec; value: ParamValue; onChange: (v: ParamValue) => void; disabled?: boolean }) {
  const id = useId();
  const lang = useLang();
  const t = useT();
  const label = spec.label[lang];
  const lockTitle = t('本关锁定', 'Locked in this level');
  const help = spec.help?.[lang];
  const unit = UNIT[spec.kind];

  if (spec.kind === 'bool') {
    return (
      <fieldset className="pf pf--bool" disabled={disabled} title={disabled ? lockTitle : undefined}>
        <label className="switch" htmlFor={id}>
          <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          <span className="switch-track" aria-hidden="true" />
          <span className="pf-label">{label}</span>{disabled && <Lock />}
        </label>
        {help && <p className="pf-help">{help}</p>}
      </fieldset>
    );
  }

  if (spec.kind === 'enum') {
    const opts = spec.options ?? [];
    return (
      <fieldset className="pf" disabled={disabled} title={disabled ? lockTitle : undefined}>
        <label className="pf-label" htmlFor={id}>{label}{disabled && <Lock />}</label>
        {opts.length <= 3 ? (
          <div className="seg" role="radiogroup" aria-label={label}>
            {opts.map((o) => (
              <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'is-on' : ''} onClick={() => onChange(o.value)}>{o.label[lang]}</button>
            ))}
          </div>
        ) : (
          <select id={id} className="select" value={String(value)} onChange={(e) => onChange(e.target.value)}>
            {opts.map((o) => <option key={o.value} value={o.value}>{o.label[lang]}</option>)}
          </select>
        )}
        {help && <p className="pf-help">{help}</p>}
      </fieldset>
    );
  }

  if (spec.kind === 'text') {
    return (
      <fieldset className="pf" disabled={disabled} title={disabled ? lockTitle : undefined}>
        <label className="pf-label" htmlFor={id}>{label}{disabled && <Lock />}</label>
        <TextInput id={id} value={String(value ?? '')} onCommit={onChange} />
        {help && <p className="pf-help">{help}</p>}
      </fieldset>
    );
  }

  if (spec.kind === 'dist') {
    const d = value as Dist;
    const ln = d.dist === 'lognormal' ? d : d.dist === 'constant' ? { dist: 'lognormal' as const, median: d.value, p99: d.value } : { dist: 'lognormal' as const, median: d.mean * 0.69, p99: d.mean * 4.6 };
    return (
      <fieldset className="pf" disabled={disabled} title={disabled ? lockTitle : undefined}>
        <span className="pf-label">{label}{disabled && <Lock />}</span>
        <div className="dist">
          <label><span>{t('中位数', 'Median')}</span><NumberInput value={ln.median} min={0.01} step={1} unit="ms" onCommit={(v) => onChange({ dist: 'lognormal', median: v, p99: Math.max(v, ln.p99) })} /></label>
          <label><span>p99</span><NumberInput value={ln.p99} min={0.01} step={1} unit="ms" onCommit={(v) => onChange({ dist: 'lognormal', median: Math.min(v, ln.median), p99: v })} /></label>
        </div>
        {help && <p className="pf-help">{help}</p>}
      </fieldset>
    );
  }

  const v = Number(value);
  const scale = spec.kind === 'ratio' ? 100 : 1;
  const min = spec.min ?? 0;
  const max = spec.max ?? 1000;
  const showSlider = spec.kind === 'ratio' || max - min <= 600;
  const step = spec.step ?? (spec.kind === 'int' || spec.kind === 'ms' || spec.kind === 'seconds' ? 1 : 0.01);
  return (
    <fieldset className="pf" disabled={disabled} title={disabled ? lockTitle : undefined}>
      <div className="pf-row">
        <label className="pf-label" htmlFor={id}>{label}{disabled && <Lock />}</label>
        <NumberInput id={id} value={v} min={min} max={max} step={step} unit={unit} scale={scale} onCommit={(x) => onChange(spec.kind === 'int' ? Math.round(x) : x)} />
      </div>
      {showSlider && (
        <input
          className="range"
          type="range"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={v}
          onChange={(e) => onChange(spec.kind === 'int' ? Math.round(Number(e.target.value)) : Number(e.target.value))}
          style={{ ['--p' as string]: `${((v - min) / (max - min || 1)) * 100}%` }}
        />
      )}
      {help && <p className="pf-help">{help}</p>}
    </fieldset>
  );
}

function TextInput({ id, value, onCommit }: { id: string; value: string; onCommit: (v: string) => void }) {
  const [t, setT] = useState(value);
  useEffect(() => setT(value), [value]);
  return (
    <input id={id} className="text" value={t} onChange={(e) => setT(e.target.value)} onBlur={() => onCommit(t)} onKeyDown={(e) => { if (e.key === 'Enter') onCommit(t); }} />
  );
}

export { NumberInput };
