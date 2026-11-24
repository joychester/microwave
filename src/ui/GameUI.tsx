import { useEffect, useRef, useState } from 'react';
import { fmtCost } from '../engine/cost';
import { LEVELS, expectedRequests, type Level } from '../game/levels';
import { useStore } from './store';
import { isUnlocked, levelById, useGame } from './game';
import { useLang, useT } from './i18n';
import { fmtAvail, fmtClock, fmtCount, fmtLatency, fmtPct } from './format';

// ---------------------------------------------------------------- bits
export function Stars({ n, size = 18, animate = false }: { n: number; size?: number; animate?: boolean }) {
  return (
    <span className={`stars${animate ? ' stars--anim' : ''}`} aria-label={`${n} / 3`}>
      {[0, 1, 2].map((i) => (
        <svg key={i} width={size} height={size} viewBox="0 0 24 24" className={i < n ? 'star is-on' : 'star'} style={{ animationDelay: `${0.35 + i * 0.35}s` }} aria-hidden="true">
          <path d="M12 2.6l2.9 6 6.6.8-4.9 4.5 1.3 6.5L12 17.2l-5.9 3.2 1.3-6.5L2.5 9.4l6.6-.8z" />
        </svg>
      ))}
    </span>
  );
}

function Meter({ label, value, display, tone, sub, segments = 20 }: { label: string; value: number; display: string; tone: 'ok' | 'warn' | 'crit'; sub?: string; segments?: number }) {
  const on = Math.round(Math.max(0, Math.min(1, value)) * segments);
  return (
    <div className={`meter meter--${tone}`}>
      <div className="meter-top"><span>{label}</span><b>{display}</b></div>
      <div className="meter-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-label={label}>
        {Array.from({ length: segments }, (_, i) => <i key={i} className={i < on ? 'is-on' : ''} />)}
      </div>
      {sub && <div className="meter-sub">{sub}</div>}
    </div>
  );
}

function goalLines(level: Level, lang: 'zh' | 'en') {
  const t = (zh: string, en: string) => (lang === 'en' ? en : zh);
  const allowed = Math.round(Math.max(20, (1 - level.slo.avail) * expectedRequests(level) * level.errorBudgetFactor));
  const lines = [
    t(`错误预算：最多失败 ${fmtCount(allowed)} 个请求（可用性 SLO ${fmtAvail(level.slo.avail)}）`, `Error budget: at most ${fmtCount(allowed)} failed requests (availability SLO ${fmtAvail(level.slo.avail)})`),
    t(`平均成本不超过 ${fmtCost(level.budget)}/小时`, `Average cost at most ${fmtCost(level.budget)}/hour`),
  ];
  if (level.lagGoal) lines.push(t(`结束时 Kafka 积压低于 ${fmtCount(level.lagGoal.max)} 条`, `Kafka backlog under ${fmtCount(level.lagGoal.max)} at the end`));
  return lines;
}

// ---------------------------------------------------------------- level grid (shown in the Learn hub)
export function totalStars(progress: Record<string, { stars: number }>): number {
  return Object.values(progress).reduce((s, p) => s + p.stars, 0);
}

export function LevelGrid({ onPick }: { onPick: (id: string) => void }) {
  const t = useT();
  const lang = useLang();
  const progress = useGame((g) => g.progress);
  return (
    <ol className="lv-grid">
      {LEVELS.map((lv) => {
        const unlocked = isUnlocked(lv.id, progress);
        const p = progress[lv.id];
        return (
          <li key={lv.id}>
            <button type="button" className={`lv${unlocked ? '' : ' is-locked'}${p?.stars ? ' is-done' : ''}`} disabled={!unlocked} onClick={() => onPick(lv.id)}>
              <span className="lv-num">{lv.num}</span>
              <span className="lv-title">{lv.title[lang]}</span>
              <span className="lv-diff" aria-label={t(`难度 ${lv.difficulty}`, `Difficulty ${lv.difficulty}`)}>
                {Array.from({ length: 5 }, (_, i) => <i key={i} className={i < lv.difficulty ? 'is-on' : ''} />)}
              </span>
              <span className="lv-story">{lv.story[lang]}</span>
              <span className="lv-foot">
                {unlocked ? <><Stars n={p?.stars ?? 0} size={16} />{p?.best ? <span className="lv-best">{t('最高', 'Best')} {p.best}</span> : null}</>
                  : <span className="lv-lock"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="2.5" y="6" width="9" height="6.5" rx="1.5" fill="currentColor" /><path d="M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>{t('通过上一关解锁', 'Clear the previous level to unlock')}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------- brief
export function Brief() {
  const t = useT();
  const lang = useLang();
  const level = levelById(useGame((g) => g.levelId));
  const startDeploy = useGame((g) => g.startDeploy);
  const showSelect = useGame((g) => g.showSelect);
  const [tips, setTips] = useState(false);
  if (!level) return null;
  return (
    <div className="gm-scrim">
      <div className="gm gm--brief" role="dialog" aria-modal="true" aria-labelledby="brief-h">
        <div className="brief-num">{t(`第 ${level.num} 关`, `Level ${level.num}`)}</div>
        <h2 id="brief-h">{level.title[lang]}</h2>
        <p className="brief-story">{level.story[lang]}</p>
        <div className="brief-cols">
          <section>
            <h3>{t('过关条件', 'To clear the level')}</h3>
            <ul className="brief-goals">{goalLines(level, lang).map((g) => <li key={g}>{g}</li>)}</ul>
            <p className="brief-dur">{t(`时长 ${fmtClock(level.duration * 1000)}（仿真时间）`, `Duration ${fmtClock(level.duration * 1000)} (simulated)`)}</p>
          </section>
          <section>
            <h3>{t('星级', 'Stars')}</h3>
            <ul className="brief-stars">
              <li><Stars n={1} size={14} /><span>{t('过关', 'Clear the level')}</span></li>
              <li><Stars n={2} size={14} /><span>{t(`90% 的时间 p99 ≤ ${fmtLatency(level.slo.p99)}`, `p99 ≤ ${fmtLatency(level.slo.p99)} for 90% of the time`)}</span></li>
              <li><Stars n={3} size={14} /><span>{t(`再加上平均成本 ≤ ${fmtCost(level.budget * 0.8)}/小时`, `…and average cost ≤ ${fmtCost(level.budget * 0.8)}/hour`)}</span></li>
            </ul>
          </section>
        </div>
        <button type="button" className="brief-tips-toggle" aria-expanded={tips} onClick={() => setTips(!tips)}>
          {tips ? t('收起提示', 'Hide hints') : t(`需要提示？（${level.tips.length} 条）`, `Need hints? (${level.tips.length})`)}
        </button>
        {tips && <ol className="brief-tips">{level.tips.map((tp, i) => <li key={i}>{tp[lang]}</li>)}</ol>}
        <div className="gm-actions">
          <button type="button" className="btn btn--ghost" onClick={showSelect}>{t('返回选关', 'All levels')}</button>
          <button type="button" className="btn btn--go" onClick={() => startDeploy(true)}>{t('开始部署', 'Start deploying')}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- HUD (deploy + playing)
export function GameHud() {
  const t = useT();
  const lang = useLang();
  const phase = useGame((g) => g.phase);
  const level = levelById(useGame((g) => g.levelId));
  const run = useGame((g) => g.run);
  const faults = useGame((g) => g.faults);
  const costNow = useGame((g) => g.costNow);
  const startPlay = useGame((g) => g.startPlay);
  const startDeploy = useGame((g) => g.startDeploy);
  const showSelect = useGame((g) => g.showSelect);
  const simTime = useStore((s) => s.simTime);
  const lagNow = useStore((s) => (level?.lagGoal ? s.latest?.nodes[level.lagGoal.nodeId]?.extra.lag ?? 0 : 0));
  const [callout, setCallout] = useState<{ text: string; key: number } | null>(null);
  const fired = useRef(new Set<number>());

  const tSec = simTime / 1000;
  useEffect(() => {
    if (phase !== 'playing') { fired.current.clear(); return; }
    faults.forEach((f, i) => {
      if (tSec >= f.at && !fired.current.has(i)) {
        fired.current.add(i);
        setCallout({ text: f.label[lang], key: Date.now() });
      }
    });
  }, [tSec, phase, faults, lang]);
  useEffect(() => {
    if (!callout) return;
    const h = setTimeout(() => setCallout(null), 2600);
    return () => clearTimeout(h);
  }, [callout]);

  if (!level) return null;

  if (phase === 'deploy') {
    return (
      <div className="hud hud--deploy" role="region" aria-label={t('部署阶段', 'Deploy phase')}>
        <div className="hud-title"><span className="hud-lv">{t(`第 ${level.num} 关`, `Level ${level.num}`)}</span><b>{level.title[lang]}</b></div>
        <p className="hud-deploy-msg">{t('部署阶段：时间暂停中。调整配置、加组件，准备好后开始。', 'Deploy phase: time is frozen. Tune settings and add components, then start.')}</p>
        <div className="hud-deploy-meta">
          <span>{t('当前成本', 'Current cost')} <b>{fmtCost(costNow)}/h</b> / {t('预算', 'budget')} {fmtCost(level.budget)}/h</span>
        </div>
        <div className="hud-actions">
          <button type="button" className="btn btn--ghost" onClick={showSelect}>{t('选关', 'Levels')}</button>
          <button type="button" className="btn btn--ghost" onClick={() => startDeploy(true)}>{t('恢复初始布局', 'Reset layout')}</button>
          <button type="button" className="btn btn--go" onClick={startPlay}>{t('开始挑战', 'Start')}</button>
        </div>
      </div>
    );
  }

  if (phase !== 'playing' && phase !== 'over') return null;
  const hp = run?.hp ?? 1;
  const avgCost = run && run.seconds > 0 ? run.costSum / run.seconds : costNow;
  const costRatio = avgCost / level.budget;
  const latShare = run && run.seconds > 0 ? 1 - run.slowSeconds / run.seconds : 1;
  const upcoming = faults
    .map((f, i) => ({ ...f, i }))
    .filter((f) => f.at > tSec && f.telegraph > 0 && f.at - tSec <= f.telegraph)[0];
  const progress = Math.min(1, tSec / level.duration);

  return (
    <>
      <div className={`hud${hp < 0.25 ? ' hud--danger' : ''}`} role="region" aria-label={t('挑战状态', 'Challenge status')}>
        <div className="hud-title">
          <span className="hud-lv">{t(`第 ${level.num} 关`, `Level ${level.num}`)}</span><b>{level.title[lang]}</b>
          <span className="hud-clock">{fmtClock(simTime)} / {fmtClock(level.duration * 1000)}</span>
        </div>
        <div className="hud-timeline" aria-hidden="true">
          <div className="hud-timeline-fill" style={{ width: `${progress * 100}%` }} />
          {faults.map((f, i) => (
            <i key={i} className={`hud-mark${f.telegraph === 0 && f.at > tSec ? ' is-hidden' : ''}${f.at <= tSec ? ' is-past' : ''}`} style={{ left: `${(f.at / level.duration) * 100}%` }} title={f.label[lang]} />
          ))}
        </div>
        <div className="hud-meters">
          <Meter label={t('错误预算', 'Error budget')} value={hp} display={fmtPct(hp)} tone={hp > 0.5 ? 'ok' : hp > 0.2 ? 'warn' : 'crit'}
            sub={t(`已失败 ${fmtCount(run?.failures ?? 0)} / ${fmtCount(run?.allowed ?? 0)}`, `${fmtCount(run?.failures ?? 0)} / ${fmtCount(run?.allowed ?? 0)} failed`)} />
          <Meter label={t('平均成本', 'Avg. cost')} value={Math.min(1, costRatio)} display={`${fmtCost(avgCost)}/h`} tone={costRatio <= 0.8 ? 'ok' : costRatio <= 1 ? 'warn' : 'crit'}
            sub={t(`预算 ${fmtCost(level.budget)}，当前 ${fmtCost(costNow)}`, `budget ${fmtCost(level.budget)}, now ${fmtCost(costNow)}`)} />
          <Meter label={t('延迟达标', 'Latency OK')} value={latShare} display={fmtPct(latShare)} tone={latShare >= 0.9 ? 'ok' : latShare >= 0.75 ? 'warn' : 'crit'}
            sub={`p99 ≤ ${fmtLatency(level.slo.p99)}`} />
          {level.lagGoal && (
            <Meter label={t('Kafka 积压', 'Kafka lag')} value={Math.min(1, lagNow / level.lagGoal.max)} display={fmtCount(lagNow)} tone={lagNow < level.lagGoal.max * 0.5 ? 'ok' : lagNow < level.lagGoal.max ? 'warn' : 'crit'}
              sub={t(`结束时 < ${fmtCount(level.lagGoal.max)}`, `< ${fmtCount(level.lagGoal.max)} at the end`)} />
          )}
        </div>
        {upcoming && (
          <div className="hud-warn" role="status">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.5 13 12.5H1Z" fill="currentColor" /><path d="M7 5.5v3.2M7 10.4v.1" stroke="var(--on-ink)" strokeWidth="1.5" strokeLinecap="round" /></svg>
            {t(`${Math.ceil(upcoming.at - tSec)} 秒后：${upcoming.label.zh}`, `In ${Math.ceil(upcoming.at - tSec)}s: ${upcoming.label.en}`)}
          </div>
        )}
      </div>
      {callout && <div key={callout.key} className="callout" role="alert">{callout.text}</div>}
    </>
  );
}

// ---------------------------------------------------------------- countdown
export function Countdown() {
  const n = useGame((g) => g.countdown);
  const phase = useGame((g) => g.phase);
  if (phase !== 'countdown') return null;
  return <div className="countdown" aria-live="assertive"><span key={n}>{n}</span></div>;
}

// ---------------------------------------------------------------- result
export function Result() {
  const t = useT();
  const lang = useLang();
  const result = useGame((g) => g.result);
  const run = useGame((g) => g.run);
  const level = levelById(useGame((g) => g.levelId));
  const newBest = useGame((g) => g.newBest);
  const startDeploy = useGame((g) => g.startDeploy);
  const showSelect = useGame((g) => g.showSelect);
  const openLevel = useGame((g) => g.openLevel);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!result) return;
    setShown(0);
    const start = performance.now();
    let raf = 0;
    const step = () => {
      const p = Math.min(1, (performance.now() - start) / 1100);
      setShown(Math.round(result.score * (1 - (1 - p) ** 3)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [result]);
  if (!result || !level || !run) return null;
  const idx = LEVELS.findIndex((l) => l.id === level.id);
  const next = LEVELS[idx + 1];
  const reason = result.reason === 'errors' ? t(`错误预算在第 ${run.seconds} 秒耗尽：失败的请求太多了。`, `The error budget ran out at ${run.seconds}s: too many requests failed.`)
    : result.reason === 'cost' ? t(`平均成本 ${fmtCost(result.avgCost)}/h 超出了预算 ${fmtCost(level.budget)}/h。`, `Average cost ${fmtCost(result.avgCost)}/h went over the ${fmtCost(level.budget)}/h budget.`)
    : result.reason === 'lag' ? t(`结束时 Kafka 还积压 ${fmtCount(run.lastLag)} 条，超过了 ${fmtCount(level.lagGoal!.max)}。`, `Kafka still had ${fmtCount(run.lastLag)} messages backed up, over the ${fmtCount(level.lagGoal!.max)} goal.`)
    : '';
  return (
    <div className="gm-scrim">
      <div className={`gm gm--result ${result.won ? 'is-won' : 'is-lost'}`} role="dialog" aria-modal="true" aria-labelledby="res-h">
        <div className="res-kicker">{t(`第 ${level.num} 关`, `Level ${level.num}`)}{lang === 'en' ? ': ' : '：'}{level.title[lang]}</div>
        <h2 id="res-h">{result.won ? t('挑战成功', 'Level cleared') : t('挑战失败', 'Level failed')}</h2>
        {result.won ? <Stars n={result.stars} size={44} animate /> : <p className="res-reason">{reason}</p>}
        <div className="res-score"><span>{t('得分', 'Score')}</span><b>{shown}</b>{newBest && <em>{t('新纪录', 'New best')}</em>}</div>
        <table className="res-table">
          <tbody>
            <tr><th scope="row">{t('可靠性（剩余错误预算）', 'Reliability (budget left)')}</th><td>{fmtPct(result.reliability)}</td><td>{result.parts.reliability} / 500</td></tr>
            <tr><th scope="row">{t('延迟达标时间', 'Time within p99 SLO')}</th><td>{fmtPct(result.latencyShare)}</td><td>{result.parts.latency} / 300</td></tr>
            <tr><th scope="row">{t('平均成本', 'Average cost')}</th><td>{fmtCost(result.avgCost)}/h</td><td>{result.parts.cost} / 200</td></tr>
          </tbody>
        </table>
        <div className="gm-actions">
          <button type="button" className="btn btn--ghost" onClick={showSelect}>{t('选关', 'Levels')}</button>
          <button type="button" className="btn btn--ghost" onClick={() => startDeploy(true)}>{t('从初始布局重来', 'Restart from scratch')}</button>
          <button type="button" className={`btn ${result.won && next ? 'btn--ghost' : 'btn--go'}`} onClick={() => startDeploy(false)}>{t('保留配置再试', 'Retry with my setup')}</button>
          {result.won && next && <button type="button" className="btn btn--go" onClick={() => openLevel(next.id)}>{t('下一关', 'Next level')}</button>}
        </div>
      </div>
    </div>
  );
}

export function GameLayer() {
  const mode = useGame((g) => g.mode);
  const phase = useGame((g) => g.phase);
  if (mode !== 'challenge') return null;
  return (
    <>
      {phase === 'brief' && <Brief />}
      {phase === 'over' && <Result />}
    </>
  );
}
