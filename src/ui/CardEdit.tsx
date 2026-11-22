// Editing on the canvas card itself: double-click the name to rename, a −/+ stepper for
// the one parameter people change most on each component type, and a × to delete it. Only while the simulation is
// not running (before the first run or when paused), and never on components a level locks.
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { NODE_SPECS } from '../engine/specs';
import { isProgram, programFromLegacy, type TrafficProgram } from '../engine/traffic';
import type { NodeCfg, Params, Text } from '../engine/types';
import { L } from '../engine/types';
import { useStore } from './store';
import { levelById, useGame } from './game';
import { useLang, useT } from './i18n';
import { fmtPct, fmtRate } from './format';

/** True when the card may be edited: not running, and not locked by the current level. */
export function useCardEditable(id: string): boolean {
  const running = useStore((s) => s.running);
  const locked = useGame((g) => (g.mode === 'challenge' ? !!levelById(g.levelId)?.lockedNodes.includes(id) : false));
  return !running && !locked;
}

interface QuickParam {
  label: Text;
  value: number;
  min: number;
  max: number;
  /** Change per click; Shift multiplies by `big` when set. */
  step: number;
  big?: number;
  show: (v: number) => string;
  /** The params patch that sets the value. */
  patch: (v: number) => Params;
}

function specRange(type: NodeCfg['type'], key: string): { min: number; max: number } {
  const p = NODE_SPECS[type].params.find((x) => x.key === key);
  return { min: p?.min ?? 0, max: p?.max ?? Infinity };
}

function intParam(cfg: NodeCfg, key: string, label: Text): QuickParam {
  const spec = NODE_SPECS[cfg.type].params.find((x) => x.key === key);
  const value = Number(cfg.params[key] ?? spec?.default ?? 0);
  return { label, value, ...specRange(cfg.type, key), step: 1, show: (v) => String(v), patch: (v) => ({ [key]: v }) };
}

/** The one parameter a card lets you step, by component type; null when there is none. */
export function quickParam(cfg: NodeCfg): QuickParam | null {
  switch (cfg.type) {
    case 'client': {
      // only a plain constant rate; other traffic shapes are edited in the inspector
      const prog: TrafficProgram = isProgram(cfg.params.traffic) ? cfg.params.traffic : programFromLegacy(cfg.params);
      if (prog.base.kind !== 'constant' || prog.overlays.length > 0) return null;
      return {
        label: L('流量', 'Rate'), value: Number(prog.base.p.rps ?? 0), min: 0, max: 50000, step: 10, big: 10,
        show: (v) => `${fmtRate(v)}/s`,
        patch: (v) => ({ traffic: { ...prog, base: { ...prog.base, p: { ...prog.base.p, rps: v } } } }),
      };
    }
    case 'service':
    case 'gateway':
      return intParam(cfg, 'instances', L('实例', 'Instances'));
    case 'database':
      return intParam(cfg, 'replicas', L('只读副本', 'Read replicas'));
    case 'queue':
      return intParam(cfg, 'consumers', L('消费者', 'Consumers'));
    case 'external': {
      const q = intParam(cfg, 'quotaRps', L('配额', 'Quota'));
      return { ...q, step: 10, big: 10, show: (v) => `${fmtRate(v)}/s` };
    }
    case 'cache': {
      if (cfg.params.hitMode === 'capacity') return intParam(cfg, 'shards', L('分片', 'Shards'));
      const v = Number(cfg.params.hitRatio ?? 0.9);
      return {
        label: L('命中率', 'Hit ratio'), value: v, min: 0, max: 1, step: 0.05,
        show: (x) => fmtPct(x),
        patch: (x) => ({ hitRatio: Math.round(x * 100) / 100 }),
      };
    }
    default:
      return null;
  }
}

/** Keeps a click inside the card's controls from selecting, dragging or panning. */
const stop = (e: MouseEvent) => e.stopPropagation();

export function CardName({ cfg }: { cfg: NodeCfg }) {
  const t = useT();
  const editable = useCardEditable(cfg.id);
  const updateNode = useStore((s) => s.updateNode);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cfg.name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) { ref.current?.focus(); ref.current?.select(); } }, [editing]);
  // a run starting while the name is open closes it
  useEffect(() => { if (!editable) setEditing(false); }, [editable]);

  if (editing) {
    const commit = () => {
      const name = draft.trim();
      if (name && name !== cfg.name) updateNode(cfg.id, { name });
      setEditing(false);
    };
    const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') setEditing(false);
    };
    return (
      <input
        ref={ref}
        className="sn-name-input nodrag nopan"
        aria-label={t('组件名称', 'Component name')}
        value={draft}
        maxLength={40}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={commit}
        onMouseDown={stop}
        onDoubleClick={stop}
      />
    );
  }
  return (
    <div
      className={`sn-name${editable ? ' is-editable' : ''}`}
      title={editable ? t(`${cfg.name}（双击改名）`, `${cfg.name} (double-click to rename)`) : cfg.name}
      onDoubleClick={editable ? (e) => { e.stopPropagation(); setDraft(cfg.name); setEditing(true); } : undefined}
    >
      {cfg.name}
    </div>
  );
}

export function CardQuick({ cfg }: { cfg: NodeCfg }) {
  const t = useT();
  const lang = useLang();
  const editable = useCardEditable(cfg.id);
  const update = useStore((s) => s.updateNodeParams);
  const q = quickParam(cfg);
  if (!q || !editable) return null;
  const set = (dir: 1 | -1, e: MouseEvent) => {
    e.stopPropagation();
    const step = q.step * (e.shiftKey && q.big ? q.big : 1);
    const raw = q.value + dir * step;
    const next = Math.min(q.max, Math.max(q.min, Math.round(raw / q.step) * q.step));
    if (next !== q.value) update(cfg.id, q.patch(Number(next.toFixed(4))));
  };
  const label = q.label[lang];
  return (
    <div className="sn-quick nodrag nopan" onMouseDown={stop} onDoubleClick={stop}>
      <div className="sn-quick-bar" role="group" aria-label={t(`快速调整${label}`, `Adjust ${label}`)}>
        <button type="button" aria-label={t(`减少${label}`, `Decrease ${label}`)} disabled={q.value <= q.min} onClick={(e) => set(-1, e)}>−</button>
        <span className="sn-quick-v"><span className="sn-quick-k">{label}</span>{q.show(q.value)}</span>
        <button type="button" aria-label={t(`增加${label}`, `Increase ${label}`)} disabled={q.value >= q.max} onClick={(e) => set(1, e)}>+</button>
      </div>
    </div>
  );
}

/** The × at a card's top-right corner: deletes the component (Undo is on the toast that follows). */
export function CardDelete({ cfg }: { cfg: NodeCfg }) {
  const t = useT();
  const editable = useCardEditable(cfg.id);
  const remove = useStore((s) => s.removeNodes);
  if (!editable) return null;
  const label = t(`删除“${cfg.name}”`, `Delete “${cfg.name}”`);
  return (
    <button
      type="button"
      className="sn-del nodrag nopan"
      aria-label={label}
      title={label}
      onMouseDown={(e: MouseEvent) => e.stopPropagation()}
      onDoubleClick={(e: MouseEvent) => e.stopPropagation()}
      onClick={(e: MouseEvent) => { e.stopPropagation(); remove([cfg.id]); }}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2 2 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
    </button>
  );
}
