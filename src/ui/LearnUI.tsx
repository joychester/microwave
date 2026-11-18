import { useEffect, useState } from 'react';
import { LESSONS, PLANNED, lessonById } from '../learn/lessons';
import { dyn } from '../learn/types';
import type { Text } from '../engine/types';
import { useStore } from './store';
import { lessonCtx, useLearn } from './learn';
import { useLang, useT } from './i18n';
import { play } from './sound';

/** Paragraphs separated by blank lines; lines starting with "•" become a list. */
function Prose({ text }: { text: string }) {
  const blocks = text.split(/\n\n+/).filter((b) => b.trim());
  return (
    <>
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        if (lines.every((ln) => ln.trim().startsWith('•'))) {
          return <ul key={i} className="lg-list">{lines.map((ln, j) => <li key={j}>{ln.replace(/^\s*•\s*/, '')}</li>)}</ul>;
        }
        return <p key={i}>{b}</p>;
      })}
    </>
  );
}

// ---------------------------------------------------------------- lesson list
export function LessonList() {
  const t = useT();
  const lang = useLang();
  const open = useLearn((l) => l.listOpen);
  const close = useLearn((l) => l.closeList);
  const start = useLearn((l) => l.start);
  const completed = useLearn((l) => l.completed);
  const active = useLearn((l) => l.active);
  const current = useLearn((l) => l.lessonId);
  if (!open) return null;
  return (
    <div className="gm-scrim" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="gm gm--learn" role="dialog" aria-modal="true" aria-labelledby="learn-h">
        <header className="gm-head">
          <div>
            <h2 id="learn-h">{t('学习模式', 'Learn')}</h2>
            <p>{t('一课一个概念，跟着步骤动手做。每课 5–10 分钟，建议按顺序学。', 'One idea per lesson, learned by doing. Each takes 5–10 minutes; going in order works best.')}</p>
          </div>
          <button type="button" className="btn btn--ghost" onClick={close}>{t('关闭', 'Close')}</button>
        </header>
        <ol className="ls-list">
          {LESSONS.map((l) => {
            const done = completed[l.id];
            const here = active && current === l.id;
            return (
              <li key={l.id} className={`ls${done ? ' is-done' : ''}`}>
                <span className="ls-num">{done ? '✓' : l.num}</span>
                <div className="ls-main">
                  <div className="ls-title">{l.title[lang]}</div>
                  <p className="ls-sum">{l.summary[lang]}</p>
                </div>
                <span className="ls-min">{t(`约 ${l.minutes} 分钟`, `${l.minutes} min`)}</span>
                <button type="button" className="btn btn--primary" onClick={() => { play('click'); start(l.id); }}>
                  {here ? t('重新开始', 'Start over') : done ? t('再学一次', 'Do it again') : t('开始', 'Start')}
                </button>
              </li>
            );
          })}
          {PLANNED.map((l) => (
            <li key={l.id} className="ls is-soon">
              <span className="ls-num">{l.num}</span>
              <div className="ls-main">
                <div className="ls-title">{l.title[lang]}</div>
                <p className="ls-sum">{l.summary[lang]}</p>
              </div>
              <span className="ls-min">{t('即将推出', 'Coming soon')}</span>
            </li>
          ))}
        </ol>
        <p className="ls-note">{t('开始一课时，当前工作台会先保存起来；退出学习后原样恢复。', 'Starting a lesson saves your current workbench; it comes back when you leave.')}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- first visit
export function Welcome() {
  const t = useT();
  const show = useLearn((l) => l.welcome);
  const start = useLearn((l) => l.start);
  const dismiss = useLearn((l) => l.dismissWelcome);
  if (!show) return null;
  return (
    <div className="gm-scrim">
      <div className="gm gm--welcome" role="dialog" aria-modal="true" aria-labelledby="wel-h">
        <h2 id="wel-h">{t('欢迎使用 SimBench', 'Welcome to SimBench')}</h2>
        <p>{t('在这里搭建微服务系统，加流量、注入故障，看它在哪里、怎么撑不住。', 'Build a microservice system, add traffic, inject faults, and see where and how it gives way.')}</p>
        <p>{t('第一次用的话，建议从第 1 课开始：约 6 分钟，边做边学会这个工具。', 'If this is your first time, start with lesson 1: about 6 minutes, and you learn the tool as you go.')}</p>
        <div className="wel-actions">
          <button type="button" className="btn btn--primary" onClick={() => start(LESSONS[0].id)}>{t('从第 1 课开始', 'Start lesson 1')}</button>
          <button type="button" className="btn btn--ghost" onClick={dismiss}>{t('直接进入工作台', 'Go to the workbench')}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- guide card
export function LessonGuide() {
  const t = useT();
  const lang = useLang();
  const l = useLearn();
  // re-render on store changes so dynamic text stays current
  useStore((s) => s.latest);
  useStore((s) => s.topology);
  const running = useStore((s) => s.running);
  const lesson = lessonById(l.lessonId);
  if (!l.active || !lesson) return null;
  const step = lesson.steps[l.step];
  const c = lessonCtx();
  const tx = (v: Text) => v[lang];
  const last = l.step === lesson.steps.length - 1;
  const head = t(`第 ${lesson.num} 课 · ${lesson.title.zh}`, `Lesson ${lesson.num} · ${lesson.title.en}`);

  if (l.collapsed) {
    return (
      <button type="button" className="lg lg--min" onClick={() => l.setCollapsed(false)}>
        <span>{head}</span>
        <span className="lg-count">{l.step + 1} / {lesson.steps.length}</span>
      </button>
    );
  }

  return (
    <section className="lg" aria-label={t('课程引导', 'Lesson guide')} aria-live="polite">
      <header className="lg-head">
        <div className="lg-kicker">{head}</div>
        <button type="button" className="icon-btn" aria-label={t('收起', 'Collapse')} onClick={() => l.setCollapsed(true)}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 9l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </header>
      <div className="lg-dots" aria-label={t(`第 ${l.step + 1} 步，共 ${lesson.steps.length} 步`, `Step ${l.step + 1} of ${lesson.steps.length}`)}>
        {lesson.steps.map((s, i) => <i key={s.id} className={i < l.step ? 'is-done' : i === l.step ? 'is-on' : ''} />)}
      </div>
      <h3 className="lg-title">{tx(step.title)}</h3>
      <div className="lg-body"><Prose text={tx(dyn(step.body, c))} /></div>

      {step.kind === 'predict' && (
        <div className="lg-options" role="group" aria-label={t('你的预测', 'Your prediction')}>
          {step.options.map((o, i) => (
            <button key={i} type="button" className="lg-opt" onClick={() => l.answer(step.id, i)}>{tx(o.label)}</button>
          ))}
        </div>
      )}

      {step.kind === 'do' && !l.stepDone && step.hold && l.since !== null && (
        <div className="lg-hold">
          <div className="lg-bar"><i style={{ width: `${Math.min(100, (l.held / step.hold) * 100)}%` }} /></div>
          <span>{running ? t(`已观察 ${Math.floor(l.held)} / ${step.hold} 秒`, `Watched ${Math.floor(l.held)} of ${step.hold} s`) : l.held > 0 ? t('仿真已暂停，点"运行"继续', 'Paused. Press Run to continue') : t('点"运行"开始计时', 'Press Run to start the clock')}</span>
        </div>
      )}

      {step.kind === 'do' && l.stepDone && (
        <div className="lg-feedback">
          <div className="lg-ok">{t('完成', 'Done')}</div>
          {step.feedback && <Prose text={tx(dyn(step.feedback, c))} />}
        </div>
      )}

      <footer className="lg-foot">
        {last ? (
          <>
            <button type="button" className="btn btn--primary" onClick={() => l.exit(true)}>{t('用这个拓扑继续自由实验', 'Keep experimenting here')}</button>
            <button type="button" className="btn btn--ghost" onClick={() => l.openList()}>{t('课程列表', 'Lessons')}</button>
            <button type="button" className="btn btn--ghost" onClick={() => l.exit(false)}>{t('退出并恢复工作台', 'Leave and restore my workbench')}</button>
          </>
        ) : step.kind === 'read' || (step.kind === 'do' && l.stepDone) ? (
          <button type="button" className="btn btn--primary" onClick={() => { play('click'); l.next(); }}>{t('下一步', 'Next')}</button>
        ) : step.kind === 'do' ? (
          <button type="button" className="link" onClick={l.skip}>{t('跳过这一步', 'Skip this step')}</button>
        ) : null}
        {!last && <button type="button" className="link lg-restart" onClick={l.restart}>{t('重新开始本课', 'Restart lesson')}</button>}
      </footer>
    </section>
  );
}

// ---------------------------------------------------------------- pointing at the UI
interface Spot { x: number; y: number; w: number; h: number }

/** Game-tutorial style pointer: a pulsing ring around the target and a bouncing arrow next to it. */
export function LessonHighlight() {
  const active = useLearn((l) => l.active);
  const lessonId = useLearn((l) => l.lessonId);
  const stepIdx = useLearn((l) => l.step);
  const done = useLearn((l) => l.stepDone);
  const collapsed = useLearn((l) => l.collapsed);
  const [spot, setSpot] = useState<Spot | null>(null);
  useEffect(() => {
    setSpot(null);
    if (!active) return;
    const step = lessonById(lessonId)?.steps[stepIdx];
    if (!step?.highlight || done) return;
    let el: Element | null = null;
    let last = '';
    let raf = 0;
    let tick = 0;
    const loop = () => {
      // look the target up a few times a second (it can appear later, e.g. after a selection)
      if (tick++ % 20 === 0) {
        const sel = dyn(step.highlight!, lessonCtx());
        const next = sel ? document.querySelector(sel) : null;
        if (next !== el) {
          el = next;
          if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }
      const r = el?.getBoundingClientRect();
      const visible = !!r && r.width > 0 && r.height > 0;
      const key = visible ? `${Math.round(r!.left)},${Math.round(r!.top)},${Math.round(r!.width)},${Math.round(r!.height)}` : '';
      if (key !== last) {
        last = key;
        setSpot(visible ? { x: r!.left, y: r!.top, w: r!.width, h: r!.height } : null);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, lessonId, stepIdx, done]);
  if (!spot || collapsed) return null;
  const pad = 6;
  // arrow to the right of targets in the left component bar, below targets at the top of the window, otherwise above
  const side = spot.x + spot.w < 160 ? 'right' : spot.y < 90 ? 'below' : 'above';
  return (
    <div className="hl-layer" aria-hidden="true">
      <div className="hl-ring" style={{ left: spot.x - pad, top: spot.y - pad, width: spot.w + pad * 2, height: spot.h + pad * 2 }} />
      <div className="hl-ring hl-ring--wave" style={{ left: spot.x - pad, top: spot.y - pad, width: spot.w + pad * 2, height: spot.h + pad * 2 }} />
      <div className={`hl-arrow hl-arrow--${side}`} style={side === 'right' ? { left: spot.x + spot.w + pad + 6, top: spot.y + spot.h / 2 } : { left: spot.x + spot.w / 2, top: side === 'below' ? spot.y + spot.h + pad + 6 : spot.y - pad - 6 }}>
        <svg width="26" height="30" viewBox="0 0 26 30"><path d="M13 29 2 15h7V1h8v14h7z" /></svg>
      </div>
    </div>
  );
}
