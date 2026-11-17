import type { NodeType } from '../engine/types';

// Hand-drawn 20px glyphs, one per component kind.
export function Glyph({ type, size = 20 }: { type: NodeType; size?: number }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      {type === 'client' && (
        <g {...p}>
          <path d="M3 6h9M3 10h12M3 14h7" />
          <path d="M12 3.5 14.5 6 12 8.5M15 7.5l2.5 2.5-2.5 2.5M10 11.5l2.5 2.5L10 16.5" />
        </g>
      )}
      {type === 'gateway' && (
        <g {...p}>
          <path d="M3 17V8a7 5 0 0 1 14 0v9" />
          <path d="M7 17v-6M10 17v-7M13 17v-6M2 17h16" />
        </g>
      )}
      {type === 'lb' && (
        <g {...p}>
          <circle cx="4" cy="10" r="1.8" />
          <path d="M5.8 10h3M8.8 10 15 4.5M8.8 10H15M8.8 10l6.2 5.5" />
          <circle cx="16.2" cy="4.5" r="1.3" /><circle cx="16.2" cy="10" r="1.3" /><circle cx="16.2" cy="15.5" r="1.3" />
        </g>
      )}
      {type === 'service' && (
        <g {...p}>
          <path d="M10 2.5 16.5 6.25v7.5L10 17.5 3.5 13.75v-7.5Z" />
          <path d="M7 10h6M10 7v6" />
        </g>
      )}
      {type === 'cache' && (
        <g {...p}>
          <path d="M11.5 2.5 5 11h5l-1.5 6.5L15 9h-5Z" />
        </g>
      )}
      {type === 'database' && (
        <g {...p}>
          <ellipse cx="10" cy="5" rx="6" ry="2.3" />
          <path d="M4 5v10c0 1.3 2.7 2.3 6 2.3s6-1 6-2.3V5M4 10c0 1.3 2.7 2.3 6 2.3s6-1 6-2.3" />
        </g>
      )}
      {type === 'external' && (
        <g {...p}>
          <path d="M6 15.5h8.5a3.5 3.5 0 0 0 .4-7A4.8 4.8 0 0 0 5.6 8 3.8 3.8 0 0 0 6 15.5Z" />
          <path d="M9 11.5h3.5M11 10l1.5 1.5L11 13" />
        </g>
      )}
      {type === 'queue' && (
        <g {...p}>
          <rect x="2.5" y="6" width="3.2" height="8" rx="0.8" />
          <rect x="7.2" y="6" width="3.2" height="8" rx="0.8" />
          <rect x="11.9" y="6" width="3.2" height="8" rx="0.8" />
          <path d="M16.5 10h1.5" />
        </g>
      )}
    </svg>
  );
}
