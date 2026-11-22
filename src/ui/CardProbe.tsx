// The pipette on a service, gateway, cache or database card: pick a source, a service label and which metrics to draw out of
// your monitoring stack, fetch them, and see them next to the simulation's numbers, without
// leaving the canvas. Reading real metrics changes nothing in the model, so it works while running.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { NodeCfg } from '../engine/types';
import { useStore } from './store';
import { useGame } from './game';
import { useLang, useT } from './i18n';
import { KIND_METRICS, OBS_TYPES, connFor, fetchFor, kindOf, metricShort, metricsFor, serviceFor, useObs, useObsResults, type ObsMetric } from './obs';
import { CompareResult, PreviewBadge, labelHint, labelName, useSimMetrics } from './ObsPanel';

const stop = (e: MouseEvent) => e.stopPropagation();

function PipetteIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.6 1.9a1.9 1.9 0 0 1 2.7 0l.8.8a1.9 1.9 0 0 1 0 2.7l-1.6 1.6.7.7-1.1 1.1-4.9-4.9 1.1-1.1.7.7z" fill="currentColor" />
      <path d="M7.6 5.6 2.9 10.3a1.6 1.6 0 0 0-.4.7l-.6 2.3a.6.6 0 0 0 .8.8l2.3-.6c.3-.1.5-.2.7-.4l4.7-4.7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function CardProbe({ cfg }: { cfg: NodeCfg }) {
  const t = useT();
  const inChallenge = useGame((g) => g.mode === 'challenge');
  const has = useObsResults((r) => !!r.by[cfg.id]);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  if (!OBS_TYPES.has(cfg.type) || inChallenge) return null;
  const label = t('从真实监控取数', 'Draw real metrics');
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`sn-probe nodrag nopan${has ? ' has-data' : ''}${open ? ' is-open' : ''}`}
        aria-label={label}
        title={label}
        aria-expanded={open}
        onMouseDown={stop}
        onDoubleClick={stop}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        <PipetteIcon />
      </button>
      {open && <ProbePopover cfg={cfg} anchor={btn} onClose={() => setOpen(false)} />}
    </>
  );
}

function ProbePopover({ cfg, anchor, onClose }: { cfg: NodeCfg; anchor: React.RefObject<HTMLButtonElement>; onClose: () => void }) {
  const t = useT();
  const lang = useLang();
  const conns = useObs((o) => o.conns);
  const openSettings = useObs((o) => o.setOpen);
  const update = useStore((s) => s.updateNodeParams);
  const saved = useObsResults((r) => r.by[cfg.id]);
  const sim = useSimMetrics(cfg.id);
  const conn = connFor(cfg, conns);
  const kind = kindOf(cfg.type);
  const all = KIND_METRICS[kind];
  const picked = metricsFor(cfg);
  const [label, setLabel] = useState(serviceFor(cfg));
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // follow the pipette while the canvas pans and zooms; flip above or left when there's no room
  useLayoutEffect(() => {
    let raf = 0;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const b = box.current?.getBoundingClientRect();
      if (a) {
        const w = b?.width ?? 320, h = b?.height ?? 300;
        let left = a.right + 8, top = a.top - 8;
        if (left + w > window.innerWidth - 8) left = Math.max(8, a.left - w - 8);
        if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
        setPos((p) => (p && Math.abs(p.left - left) < 0.5 && Math.abs(p.top - top) < 0.5 ? p : { left, top }));
      }
      raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [anchor]);

  // close when the calibration dialog opens from here
  const calOpen = useStore((s) => s.calOpen);
  useEffect(() => { if (calOpen) onClose(); }, [calOpen, onClose]);

  // close on Esc or a click outside
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const down = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!box.current?.contains(n) && !anchor.current?.contains(n)) onClose();
    };
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', down, true);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', down, true); };
  }, [onClose, anchor]);

  const toggle = (m: ObsMetric) => {
    const next = picked.includes(m) ? picked.filter((x) => x !== m) : all.filter((x) => x === m || picked.includes(x));
    if (next.length) update(cfg.id, { obsMetrics: next.length === all.length ? '' : next.join(',') });
  };
  const commitLabel = () => { if (label.trim() !== serviceFor(cfg)) update(cfg.id, { obsService: label.trim() }); };
  const go = async () => {
    commitLabel();
    if (!conn || !label.trim()) return;
    setBusy(true);
    try { await fetchFor(cfg, conn, label.trim()); } finally { setBusy(false); }
  };

  return createPortal(
    <div
      ref={box}
      className="probe"
      role="dialog"
      aria-label={t(`${cfg.name}：从真实监控取数`, `${cfg.name}: draw real metrics`)}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="probe-head">
        <b>{cfg.name} <PreviewBadge /></b>
        <button type="button" className="icon-btn" aria-label={t('关闭', 'Close')} onClick={onClose}>×</button>
      </div>
      {conns.length === 0 ? (
        <>
          <p className="obs-note">{t('还没有配置性能数据来源。先在设置里添加 Prometheus、Grafana 或 Grafana MCP。', 'No performance-data source yet. Add Prometheus, Grafana or Grafana MCP in Settings first.')}</p>
          <button type="button" className="btn" onClick={() => { onClose(); openSettings(true); }}>{t('打开设置', 'Open settings')}</button>
        </>
      ) : (
        <>
          <label className="obs-field">
            <span>{t('数据来源', 'Source')}</span>
            <select value={conn?.id ?? ''} onChange={(e) => update(cfg.id, { obsConn: e.target.value })}>
              {!conn && <option value="">{t('请选择', 'Choose one')}</option>}
              {conns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="obs-field">
            <span>{labelName(kind, t)}</span>
            <input
              value={label}
              placeholder={labelHint(kind, t)}
              autoFocus={!label}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void go(); } }}
            />
          </label>
          <fieldset className="probe-metrics">
            <legend>{t('要获取的指标', 'Metrics to fetch')}</legend>
            {all.map((m) => (
              <label key={m}>
                <input type="checkbox" checked={picked.includes(m)} disabled={picked.length === 1 && picked.includes(m)} onChange={() => toggle(m)} />
                {metricShort(kind, m, lang)}
              </label>
            ))}
          </fieldset>
          <div className="obs-bar">
            <button type="button" className="btn btn--primary" disabled={busy || !conn || !label.trim()} onClick={() => void go()}>
              {busy ? t('获取中…', 'Fetching…') : t('获取', 'Fetch')}
            </button>
            <button type="button" className="link" onClick={() => { onClose(); openSettings(true); }}>{t('设置', 'Settings')}</button>
          </div>
          {saved && <CompareResult nodeId={cfg.id} kind={kind} saved={saved} sim={sim} compact />}
        </>
      )}
    </div>,
    document.body,
  );
}
