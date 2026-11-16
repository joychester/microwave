import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { NodeType } from '../engine/types';

// Each component type gets its own silhouette so the topology reads at a glance:
//   client   browser window      gateway  arched gate       lb     pointed router
//   service  stacked replicas    cache    memory module     database  upright cylinder
//   queue    horizontal log pipe with partition segments
// The shape is an SVG sized to the measured content box, drawn behind the content.

export const SHAPE_PAD: Record<NodeType, string> = {
  client: '30px 12px 10px 12px',
  gateway: '24px 12px 10px 12px',
  lb: '9px 22px 9px 22px',
  service: '10px 12px 10px 12px',
  cache: '15px 12px 15px 12px',
  database: '24px 12px 16px 12px',
  queue: '10px 26px 10px 16px',
};

function paths(type: NodeType, w: number, h: number, extra: { replicas: number; partitions: number }) {
  const back: string[] = [];
  const deco: string[] = [];
  let body = '';
  switch (type) {
    case 'client': {
      const r = 10;
      body = `M${r},0 H${w - r} Q${w},0 ${w},${r} V${h - r} Q${w},${h} ${w - r},${h} H${r} Q0,${h} 0,${h - r} V${r} Q0,0 ${r},0 Z`;
      deco.push(`M0,21 H${w}`);
      break;
    }
    case 'gateway': {
      const a = 16;
      body = `M0,${a} Q0,0 ${a * 1.6},0 H${w - a * 1.6} Q${w},0 ${w},${a} V${h - 6} Q${w},${h} ${w - 6},${h} H6 Q0,${h} 0,${h - 6} Z`;
      // gate pillars
      deco.push(`M7,${a + 2} V${h - 7}`, `M${w - 7},${a + 2} V${h - 7}`);
      break;
    }
    case 'lb': {
      const p = 15;
      body = `M${p},0 H${w - p} L${w},${h / 2} L${w - p},${h} H${p} L0,${h / 2} Z`;
      break;
    }
    case 'service': {
      const r = 10;
      const rect = (dx: number, dy: number) =>
        `M${r + dx},${dy} H${w - r + dx} Q${w + dx},${dy} ${w + dx},${r + dy} V${h - r + dy} Q${w + dx},${h + dy} ${w - r + dx},${h + dy} H${r + dx} Q${dx},${h + dy} ${dx},${h - r + dy} V${r + dy} Q${dx},${dy} ${r + dx},${dy} Z`;
      if (extra.replicas >= 3) back.push(rect(10, -10));
      if (extra.replicas >= 2) back.push(rect(5, -5));
      body = rect(0, 0);
      break;
    }
    case 'cache': {
      const top = 6;
      const bot = h - 6;
      body = `M4,${top} H${w - 4} Q${w},${top} ${w},${top + 4} V${bot - 4} Q${w},${bot} ${w - 4},${bot} H4 Q0,${bot} 0,${bot - 4} V${top + 4} Q0,${top} 4,${top} Z`;
      // contact pins along top and bottom, with a key notch
      for (let x = 14; x < w - 14; x += 13) {
        if (Math.abs(x - w * 0.62) < 7) continue;
        deco.push(`M${x},${top} V0 H${x + 6} V${top}`, `M${x},${bot} V${h} H${x + 6} V${bot}`);
      }
      break;
    }
    case 'database': {
      const ry = 10;
      body = `M0,${ry} A${w / 2},${ry} 0 0 1 ${w},${ry} V${h - ry} A${w / 2},${ry} 0 0 1 0,${h - ry} Z`;
      deco.push(`M0,${ry} A${w / 2},${ry} 0 0 0 ${w},${ry}`);
      break;
    }
    case 'queue': {
      const rx = 11;
      body = `M${rx},0 H${w - rx} A${rx},${h / 2} 0 0 1 ${w - rx},${h} H${rx} A${rx},${h / 2} 0 0 1 ${rx},0 Z`;
      deco.push(`M${w - rx},0 A${rx},${h / 2} 0 0 0 ${w - rx},${h}`);
      break;
    }
  }
  // queue partition segments are drawn separately (lighter)
  const segs: string[] = [];
  if (type === 'queue') {
    const n = Math.max(2, Math.min(12, extra.partitions));
    const x0 = 16;
    const x1 = w - 22;
    for (let i = 1; i < n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      segs.push(`M${x},3 V${h - 3}`);
    }
  }
  return { body, back, deco, segs };
}

export function NodeShape({ type, replicas, partitions, children, className }: {
  type: NodeType; replicas: number; partitions: number; children: ReactNode; className: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize((s) => (s.w === el.offsetWidth && s.h === el.offsetHeight ? s : { w: el.offsetWidth, h: el.offsetHeight }));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { w, h } = size;
  const p = w > 0 ? paths(type, w, h, { replicas, partitions }) : null;
  return (
    <div ref={ref} className={`${className} sn--${type}`} style={{ padding: SHAPE_PAD[type] }}>
      {p && (
        <svg className="sn-shape" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
          {p.back.map((d, i) => <path key={`b${i}`} d={d} className="sn-shape-back" />)}
          <path d={p.body} className="sn-shape-body" />
          {p.segs.map((d, i) => <path key={`s${i}`} d={d} className="sn-shape-seg" />)}
          {p.deco.map((d, i) => <path key={`d${i}`} d={d} className="sn-shape-deco" />)}
          {type === 'client' && [12, 21, 30].map((x) => <circle key={x} cx={x} cy={10.5} r={2.6} className="sn-shape-dot" />)}
        </svg>
      )}
      {children}
    </div>
  );
}
