import { useId, useMemo } from 'react';
import type { FailureKindSpec } from '../engine/specs';
import type { NodeCfg } from '../engine/types';
import { estimateImpact, faultLevel } from './faultImpact';
import { fmtLatency } from './format';
import { useLang, useT } from './i18n';
import { useStore } from './store';

// Under a fault's settings, before it is injected: the fault's level over time, then a steady-state
// estimate of its effect. Both follow the settings as they are typed.

const W = 260, H = 64, TOP = 16, BASE = 50;

/**
 * The fault's level over time. With `now` (seconds since injection) it shows progress: the elapsed
 * part filled darker, a line at the current moment, and elapsed / remaining time.
 */
/** A cache flush in capacity mode has no set recovery time: the cache warms up as misses are refilled. */
export function warmsUp(node: NodeCfg, kind: string): boolean {
  return node.type === 'cache' && kind === 'flush' && node.params.hitMode === 'capacity';
}

export function FaultCurve({ kind, vals, dur, rec, now, warm }: { kind: string; vals: Record<string, number>; dur: number; rec: number; now?: number; warm?: boolean }) {
  const t = useT();
  const lang = useLang();
  const clipId = useId();
  const open = dur <= 0;
  const live = now !== undefined;
  // warming up has no set length: draw a dashed ramp of a nominal length, labelled as open
  const warmUp = !!warm && !open;
  if (warmUp) rec = Math.max(dur * 3, 15);
  // time shown: a bit of normal before the fault, the fault, its recovery, a bit of normal after;
  // a fault that stays on keeps stretching the axis so the current moment keeps moving
  const span = open ? Math.max(60, live ? now! * 1.25 : 0) : dur + rec;
  const pre = span * 0.26, post = open ? 0 : span * 0.1;
  const total = pre + span + post;
  const x = (s: number) => 8 + ((s + pre) / total) * (W - 16);
  const x0 = x(0), x1 = x(open ? span : dur), x2 = x(open ? span : dur + rec);
  const level = faultLevel(kind, vals);
  const d = open
    ? `M8 ${BASE} H${x0} V${TOP} H${W - 8}`
    : warmUp ? `M8 ${BASE} H${x0} V${TOP} H${x1}` : `M8 ${BASE} H${x0} V${TOP} H${x1} L${x2} ${BASE} H${W - 8}`;
  const ramp = warmUp ? `Q${x1 + (x2 - x1) * 0.35} ${BASE - 2} ${x2} ${BASE}` : `L${x2} ${BASE}`;
  const area = open ? `M${x0} ${BASE} V${TOP} H${W - 8} V${BASE} Z` : `M${x0} ${BASE} V${TOP} H${x1} ${ramp} Z`;
  const secs = (s: number) => `${+s.toFixed(1)}s`;
  // the current moment, held to the drawn range
  const tNow = live ? Math.min(Math.max(0, now!), open ? span : dur + rec) : 0;
  const xNow = x(tNow);
  const yNow = !live ? BASE : open || tNow <= dur ? TOP : rec > 0 ? TOP + ((BASE - TOP) * Math.min(1, (tNow - dur) / rec)) : BASE;
  // elapsed only: the time left is already counted down under the curve
  const whole = `${Math.max(0, Math.floor(tNow))}s`;
  const nowLabel = !live ? '' : open
    ? t(`已持续 ${whole}`, `${whole} so far`)
    : tNow < dur
      ? t(`已过 ${whole}`, `${whole} in`)
      : t('恢复中', 'recovering');
  return (
    <svg className="fp-curve" viewBox={`0 0 ${W} ${H + 14}`} role="img"
      aria-label={open
        ? t(`注入后一直生效${level ? `（${level.zh}）` : ''}，直到手动结束`, `From injection${level ? ` (${level.en})` : ''} until you end it`)
        : t(`注入后生效 ${dur} 秒${level ? `（${level.zh}）` : ''}${warmUp ? '，之后随回源逐步回暖' : rec ? `，再用 ${rec} 秒逐步恢复` : ''}`, `Active for ${dur} s after injection${level ? ` (${level.en})` : ''}${warmUp ? ', then warms up as misses are refilled' : rec ? `, then recovers over ${rec} s` : ''}`)}>
      <path d={area} className="fp-area" />
      {live && (
        <>
          <clipPath id={clipId}><rect x={0} y={0} width={Math.max(0, xNow - 0)} height={H} /></clipPath>
          <path d={area} className="fp-area-done" clipPath={`url(#${clipId})`} />
        </>
      )}
      <path d={d} className="fp-line" />
      {open && <path d={`M${W - 22} ${TOP} H${W - 8}`} className="fp-open" />}
      {warmUp && <path d={`M${x1} ${TOP} ${ramp} H${W - 8}`} className="fp-open" fill="none" />}
      <text x={10} y={BASE - 5} className="fp-t">{t('正常', 'Normal')}</text>
      {/* while live the level sits inside the shape, leaving the top for the time label */}
      {level && <text x={x0 + 5} y={live ? TOP + 12 : TOP - 4} className="fp-t fp-lvl">{level[lang]}</text>}
      {live && (
        <>
          <line x1={xNow} x2={xNow} y1={TOP - 3} y2={BASE + 4} className="fp-now" />
          <circle cx={xNow} cy={yNow} r={3.2} className="fp-now-dot" />
          <text x={xNow} y={TOP - 6} className="fp-t fp-now-t" textAnchor={xNow > W * 0.7 ? 'end' : xNow < W * 0.3 ? 'start' : 'middle'}>{nowLabel}</text>
        </>
      )}
      <line x1={x0} x2={x0} y1={BASE} y2={BASE + 4} className="fp-tick" />
      {/* a short fault puts its length next to "Inject" instead of under its own tick */}
      <text x={x0} y={H + 10} className="fp-t" textAnchor="middle">{!open && x1 - x0 < 36 ? t(`注入，持续 ${secs(dur)}`, `Inject, ${secs(dur)}`) : t('注入', 'Inject')}</text>
      {open ? (
        <text x={W - 8} y={H + 10} className="fp-t" textAnchor="end">{t('直到手动结束', 'until you end it')}</text>
      ) : (
        <>
          <line x1={x1} x2={x1} y1={BASE} y2={BASE + 4} className="fp-tick" />
          {x1 - x0 >= 36 && <text x={x1} y={H + 10} className="fp-t" textAnchor={rec ? 'middle' : 'start'}>{secs(dur)}</text>}
          {rec > 0 && <text x={W - 8} y={H + 10} className="fp-t" textAnchor="end">{warmUp ? t('之后回暖，快慢取决于回源', 'then warms up, as fast as the origin allows') : t(`+${secs(rec)} 恢复`, `+${secs(rec)} recovery`)}</text>}
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
      <FaultCurve kind={spec.kind} vals={vals} dur={dur} rec={rec} warm={warmsUp(node, spec.kind)} />
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
