import { useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useChrome } from './theme';
import { useT } from './i18n';

export interface Series {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
  dash?: number[];
  width?: number;
}

interface Props {
  title: string;
  x: number[];
  series: Series[];
  unit?: 'ms' | '%' | '/s' | 'x' | '';
  height?: number;
  yMin?: number;
  yMax?: number;
  compact?: boolean;
}


function fmt(v: number | null | undefined, unit: Props['unit']) {
  if (v == null || !isFinite(v)) return '—';
  if (unit === '%') return `${v.toFixed(0)}%`;
  if (unit === 'ms') return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}s` : `${v.toFixed(v < 10 ? 1 : 0)}ms`;
  if (unit === 'x') return `${v.toFixed(2)}×`;
  if (unit === '/s') return v >= 1000 ? `${(v / 1000).toFixed(1)}k/s` : `${v.toFixed(v < 10 ? 1 : 0)}/s`;
  return v.toFixed(0);
}

/** Shared by all time charts so their cursors move together. */
const SYNC_KEY = 'sim-time';

export function TimeChart({ title, x, series, unit = '', height = 150, yMin, yMax, compact }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chrome = useChrome();
  const t = useT();
  const plot = useRef<uPlot | null>(null);
  const sig = series.map((s) => s.key + s.color + s.label).join('|') + unit + (compact ? 'c' : '') + chrome.axis;

  const data = useMemo(() => [x, ...series.map((s) => s.values)] as uPlot.AlignedData, [x, series]);

  useEffect(() => {
    if (!host.current) return;
    const el = host.current;
    const axisStroke = chrome.axis;
    const grid = { stroke: chrome.grid, width: 1 };
    const opts: uPlot.Options = {
      width: el.clientWidth || 300,
      height,
      padding: [8, 8, 0, 0],
      legend: { show: !compact, live: true },
      // every chart is on the same simulated-time axis: hovering one moves the cursor on all of them
      // to the same second (matched by x value), with each legend showing that second's values. The
      // horizontal line is off, since on the other charts it would sit at a meaningless height.
      cursor: { drag: { x: false, y: false }, points: { size: 7 }, y: false, sync: { key: SYNC_KEY, scales: ['x', null] } },
      scales: {
        x: { time: false },
        y: { range: (_u, min, max) => [yMin ?? Math.min(0, min), yMax ?? Math.max(max * 1.15, yMin !== undefined ? yMin + 1 : 1)] },
      },
      axes: [
        {
          stroke: axisStroke, grid, ticks: { show: false }, size: compact ? 18 : 24,
          font: '11px "Archivo Variable", system-ui, sans-serif',
          values: (_u, vals) => vals.map((v) => `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, '0')}`),
        },
        {
          stroke: axisStroke, grid, ticks: { show: false }, size: compact ? 40 : 48,
          font: '11px "Archivo Variable", system-ui, sans-serif',
          values: (_u, vals) => vals.map((v) => fmt(v, unit)),
        },
      ],
      series: [
        { label: t('时间', 'Time'), value: (_u, v) => (v == null ? '—' : `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, '0')}`) },
        ...series.map((s) => ({
          label: s.label,
          stroke: s.color,
          width: s.width ?? 2,
          dash: s.dash,
          points: { show: false },
          spanGaps: true,
          value: (u: uPlot, v: number | null, sidx: number, idx: number | null) => {
            if (idx == null) {
              const arr = u.data[sidx] as (number | null)[];
              for (let k = arr.length - 1; k >= 0; k--) if (arr[k] != null) return fmt(arr[k], unit);
              return '—';
            }
            return fmt(v, unit);
          },
        })),
      ],
    };
    const u = new uPlot(opts, data, el);
    plot.current = u;
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => { ro.disconnect(); u.destroy(); plot.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, height, yMin, yMax]);

  useEffect(() => { plot.current?.setData(data); }, [data]);

  return (
    <figure className={`tc ${compact ? 'tc--compact' : ''}`}>
      <figcaption className="tc-title">
        <span>{title}</span>
        {compact && (
          <span className="tc-keys">
            {series.map((s) => {
              const last = [...s.values].reverse().find((v) => v != null);
              return <span key={s.key} className="tc-key"><i style={{ background: s.color }} />{s.label} <b>{fmt(last ?? null, unit)}</b></span>;
            })}
          </span>
        )}
      </figcaption>
      <div ref={host} className="tc-plot" />
      {x.length === 0 && <div className="tc-empty">{t('运行仿真后显示', 'Run the simulation to see data')}</div>}
    </figure>
  );
}
