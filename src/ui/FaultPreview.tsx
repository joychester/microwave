import { useMemo } from 'react';
import type { FailureKindSpec } from '../engine/specs';
import type { NodeCfg } from '../engine/types';
import { estimateImpact, faultLevel } from './faultImpact';
import { fmtLatency } from './format';
import { useLang, useT } from './i18n';
import { useStore } from './store';

// Under a fault's settings, before it is injected: the fault's level over time, then a steady-state
// estimate of its effect. Both follow the settings as they are typed.

const W = 260, H = 64, TOP = 16, BASE = 50;

function FaultCurve({ kind, vals, dur, rec }: { kind: string; vals: Record<string, number>; dur: number; rec: number }) {
  const t = useT();
  const lang = useLang();
  const open = dur <= 0;
  // time shown: a bit of normal before the fault, the fault, its recovery, a bit of normal after
  const span = open ? 60 : dur + rec;
  const pre = span * 0.26, post = open ? 0 : span * 0.1;
  const total = pre + span + post;
  const x = (s: number) => 8 + ((s + pre) / total) * (W - 16);
  const x0 = x(0), x1 = x(open ? span : dur), x2 = x(open ? span : dur + rec);
  const level = faultLevel(kind, vals);
  const d = open
    ? `M8 ${BASE} H${x0} V${TOP} H${W - 8}`
    : `M8 ${BASE} H${x0} V${TOP} H${x1} L${x2} ${BASE} H${W - 8}`;
  const area = open ? `M${x0} ${BASE} V${TOP} H${W - 8} V${BASE} Z` : `M${x0} ${BASE} V${TOP} H${x1} L${x2} ${BASE} Z`;
  const secs = (s: number) => `${+s.toFixed(1)}s`;
  return (
    <svg className="fp-curve" viewBox={`0 0 ${W} ${H + 14}`} role="img"
      aria-label={open
        ? t(`注入后一直生效${level ? `（${level.zh}）` : ''}，直到手动结束`, `From injection${level ? ` (${level.en})` : ''} until you end it`)
        : t(`注入后生效 ${dur} 秒${level ? `（${level.zh}）` : ''}${rec ? `，再用 ${rec} 秒逐步恢复` : ''}`, `Active for ${dur} s after injection${level ? ` (${level.en})` : ''}${rec ? `, then recovers over ${rec} s` : ''}`)}>
      <path d={area} className="fp-area" />
      <path d={d} className="fp-line" />
      {open && <path d={`M${W - 22} ${TOP} H${W - 8}`} className="fp-open" />}
      <text x={10} y={BASE - 5} className="fp-t">{t('正常', 'Normal')}</text>
      {level && <text x={x0 + 5} y={TOP - 4} className="fp-t fp-lvl">{level[lang]}</text>}
      <line x1={x0} x2={x0} y1={BASE} y2={BASE + 4} className="fp-tick" />
      {/* a short fault puts its length next to "Inject" instead of under its own tick */}
      <text x={x0} y={H + 10} className="fp-t" textAnchor="middle">{!open && x1 - x0 < 36 ? t(`注入，持续 ${secs(dur)}`, `Inject, ${secs(dur)}`) : t('注入', 'Inject')}</text>
      {open ? (
        <text x={W - 8} y={H + 10} className="fp-t" textAnchor="end">{t('直到手动结束', 'until you end it')}</text>
      ) : (
        <>
          <line x1={x1} x2={x1} y1={BASE} y2={BASE + 4} className="fp-tick" />
          {x1 - x0 >= 36 && <text x={x1} y={H + 10} className="fp-t" textAnchor={rec ? 'middle' : 'start'}>{secs(dur)}</text>}
          {rec > 0 && <text x={W - 8} y={H + 10} className="fp-t" textAnchor="end">{t(`+${secs(rec)} 恢复`, `+${secs(rec)} recovery`)}</text>}
        </>
      )}
    </svg>
  );
}

/** A plain statement for faults whose effect is direct rather than a load change. */
function directEffect(kind: string, vals: Record<string, number>, t: (zh: string, en: string) => string): string | null {
  const p = Math.round((vals.rate ?? 0) * 100);
  if (kind === 'errorSpike') return t(`约 ${p}% 的请求直接失败；调用方如果配置了重试，流量会被放大。`, `About ${p}% of requests fail outright; callers that retry will add traffic.`);
  if (kind === 'outage') return t('所有调用都会失败或超时，直到故障结束。', 'Every call fails or times out until the fault ends.');
  if (kind === 'failover') return t('切换期间主库不可用：写请求失败，读走副本的请求不受影响。', 'The primary is unavailable during failover: writes fail, reads served by replicas carry on.');
  return null;
}

export function FaultPreview({ node, spec, vals, dur, rec }: { node: NodeCfg; spec: FailureKindSpec; vals: Record<string, number>; dur: number; rec: number }) {
  const t = useT();
  const lang = useLang();
  const topology = useStore((s) => s.topology);
  const simSec = useStore((s) => Math.floor(s.simTime / 1000));
  const impact = useMemo(() => estimateImpact(topology, node.id, spec.kind, vals, simSec), [topology, node.id, spec.kind, vals, simSec]);
  const direct = directEffect(spec.kind, vals, t);

  const util = (u: number) => (!isFinite(u) || u >= 1 ? t('过载', 'overloaded') : `${Math.round(u * 100)}%`);
  const lat = (l: number, u: number) => (!isFinite(l) || u >= 1 ? t('持续上升', 'keeps rising') : fmtLatency(l));

  return (
    <div className="fp">
      <FaultCurve kind={spec.kind} vals={vals} dur={dur} rec={rec} />
      {impact?.down && <p className="fp-direct fp-bad">{t('所有实例都宕机：这个组件的请求将全部失败。', 'Every instance is down: all requests to this component fail.')}</p>}
      {impact && impact.rows.length > 0 && (
        <div className="fp-est">
          <div className="fp-est-h">
            <span>{t('影响预估', 'Estimated impact')}</span>
            <span className="fp-est-note" title={t('用容量公式算的稳态，故障期间的平均情况。不含重试、超时和故障一层层传开的过程，以运行结果为准。', 'Steady state from the capacity formulas, averaged over the fault. Leaves out retries, timeouts and how the failure spreads over time; the run shows those.')}>{t('稳态估算', 'steady state')}</span>
          </div>
          <table>
            <tbody>
              {impact.rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{r.name}<span>{r.utilKind[lang]}</span></th>
                  <td>{util(r.util0)} → <b className={r.util1 >= 1 || !isFinite(r.util1) ? 'is-bad' : r.util1 >= 0.8 ? 'is-warn' : ''}>{util(r.util1)}</b></td>
                  <td>{lat(r.lat0, r.util0)} → <b className={r.util1 >= 1 || !isFinite(r.lat1) ? 'is-bad' : ''}>{lat(r.lat1, r.util1)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {direct && <p className="fp-direct">{direct}</p>}
    </div>
  );
}
