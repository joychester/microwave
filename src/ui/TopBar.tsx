import { useRef, useState } from 'react';
import * as yaml from 'js-yaml';
import { SCENARIOS, TOPOLOGY_PRESETS } from '../engine/presets';
import type { Topology } from '../engine/types';
import { useStore } from './store';
import { useLang, useT } from './i18n';
import { fmtAvail, fmtClock, fmtLatency, fmtRate, sloPct, windowSys } from './format';
import { fmtCost } from '../engine/cost';
import { useLearn } from './learn';
import { useObs } from './obs';
import { FetchAllButton } from './ObsPanel';
import { lessonById } from '../learn/lessons';
import { levelById, useGame } from './game';
import { play } from './sound';
import { DURATIONS, useRuns } from './runs';

const SPEEDS = [1, 2, 5, 10, 20];

export function TopBar() {
  const t = useT();
  const running = useStore((s) => s.running);
  const toggle = useStore((s) => s.toggle);
  const reset = useStore((s) => s.reset);
  const speed = useStore((s) => s.speed);
  const setSpeed = useStore((s) => s.setSpeed);
  const simTime = useStore((s) => s.simTime);
  const achieved = useStore((s) => s.achieved);

  const lagging = running && achieved > 0 && achieved < speed * 0.8 && simTime > 3000;
  const mode = useGame((g) => g.mode);
  const phase = useGame((g) => g.phase);
  const exitChallenge = useGame((g) => g.exitChallenge);
  const showSelect = useGame((g) => g.showSelect);
  const level = levelById(useGame((g) => g.levelId));
  const challenge = mode === 'challenge';
  const learning = useLearn((l) => l.active);
  const openLessons = useLearn((l) => l.openList);
  const exitLesson = useLearn((l) => l.exit);
  const lesson = lessonById(useLearn((l) => l.lessonId));
  const canRun = !challenge || phase === 'playing';

  return (
    <header className="top">
      <div className="brand">
        <svg className="brand-logo" width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
          <rect x="2" y="5" width="22" height="16" rx="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M5.5 13c1.2-2.6 2.4-2.6 3.6 0s2.4 2.6 3.6 0 2.4-2.6 3.6 0" fill="none" stroke="var(--select)" strokeWidth="2" strokeLinecap="round" />
          <circle cx="20.5" cy="10" r="1.2" fill="currentColor" />
          <circle cx="20.5" cy="14" r="1.2" fill="currentColor" />
        </svg>
        <div>
          <div className="brand-name">Microwave</div>
          <div className="brand-sub">{t('微服务性能仿真', 'Microservice sim')}</div>
        </div>
      </div>

      {challenge ? (
        <div className="mode-chip">
          <button type="button" className="menu-btn" onClick={showSelect}>
            <span className="menu-k">{t('挑战', 'Challenge')}</span>
            <span className="menu-v">{level ? t(`第 ${level.num} 关`, `Level ${level.num}`) : t('选关', 'Levels')}</span>
          </button>
          <button type="button" className="btn btn--ghost" onClick={exitChallenge}>{t('退出挑战', 'Exit')}</button>
        </div>
      ) : learning ? (
        <div className="mode-chip">
          <button type="button" className="menu-btn" onClick={() => openLessons('lessons')}>
            <span className="menu-k">{t('学习', 'Learn')}</span>
            <span className="menu-v">{lesson ? t(`第 ${lesson.num} 课`, `Lesson ${lesson.num}`) : t('课程', 'Lessons')}</span>
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => exitLesson(false)}>{t('退出学习', 'Exit')}</button>
        </div>
      ) : (
        <>
          <TopologyMenu />
          <ScenarioMenu />
          <FetchAllButton />
          <button type="button" className="btn btn--learn" onClick={() => { play('click'); openLessons(); }}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 5.5 8 2.5l6.5 3L8 8.5z M4 7v3.5c0 1 1.8 2 4 2s4-1 4-2V7 M14.5 5.5v4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {t('学习', 'Learn')}
          </button>

        </>
      )}

      <div className="transport">
        <button type="button" data-learn="run" className={`play${running ? ' is-running' : ''}`} onClick={toggle} disabled={!canRun} aria-label={running ? t('暂停', 'Pause') : t('运行', 'Run')} title={t('空格键', 'Space')}>
          {running
            ? <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3" width="3" height="10" rx="1" fill="currentColor" /><rect x="9.5" y="3" width="3" height="10" rx="1" fill="currentColor" /></svg>
            : <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z" fill="currentColor" /></svg>}
          <span>{running ? t('暂停', 'Pause') : simTime > 0 ? t('继续', 'Resume') : t('运行', 'Run')}</span>
        </button>
        {!challenge && <button type="button" className="btn btn--ghost" onClick={reset} title={t('清空指标，从 0 秒重新开始', 'Clear metrics and restart from 0 s')}>{t('重置', 'Reset')}</button>}
        <div className="seg seg--speed" role="radiogroup" aria-label={t('仿真速度', 'Simulation speed')}>
          {SPEEDS.map((v) => (
            <button key={v} type="button" data-learn={`speed-${v}`} role="radio" aria-checked={speed === v} className={speed === v ? 'is-on' : ''} onClick={() => setSpeed(v)}>{v}×</button>
          ))}
        </div>
        {challenge ? (
          <div className="clock" aria-label={t('仿真时间', 'Simulated time')}>
            <span className="clock-t">{fmtClock(simTime)}</span>
            {lagging && <span className="clock-lag">{t('实际', 'actual')} {achieved.toFixed(1)}×</span>}
          </div>
        ) : <RunClock lagging={lagging} achieved={achieved} />}
      </div>

      <Kpis />
      <div className="top-tools">
        <LangSwitch />
        <ThemeSwitch />
        <SettingsButton />
        <SoundSwitch />
        <FileMenu sandbox={!challenge} />
      </div>
    </header>
  );
}

function RunClock({ lagging, achieved }: { lagging: boolean; achieved: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const away = useClickAway(open, () => setOpen(false));
  const duration = useRuns((r) => r.duration);
  const setDuration = useRuns((r) => r.setDuration);
  const stopNow = useRuns((r) => r.stopNow);
  const acc = useRuns((r) => r.acc);
  const baseT = useRuns((r) => r.baseT);
  const last = useRuns((r) => r.reports[0]);
  const elapsed = acc ? acc.seconds : baseT > 0 && last ? last.seconds : 0;
  const label = (s: number) => t(`${s / 60} 分钟`, `${s / 60} min`);
  return (
    <div className="menu" {...away}>
      <button type="button" data-learn="clock" className="clock clock--btn" aria-expanded={open} aria-label={t('运行时长', 'Run length')} onClick={() => setOpen(!open)}>
        <span className="clock-t">{fmtClock(elapsed * 1000)}<small> / {fmtClock(duration * 1000)}</small></span>
        <span className="clock-prog" aria-hidden="true"><i style={{ width: `${Math.min(100, (elapsed / duration) * 100)}%` }} /></span>
        {lagging && <span className="clock-lag">{t('实际', 'actual')} {achieved.toFixed(1)}×</span>}
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <p className="menu-note">{t('运行时长（仿真时间），到点自动停止并生成报告。最长 30 分钟。', 'Run length in simulated time. The run stops on time and writes a report. Up to 30 minutes.')}</p>
          {DURATIONS.map((d) => (
            <button key={d} type="button" data-learn={`dur-${d}`} role="menuitemradio" aria-checked={d === duration} className={`menu-item${d === duration ? ' is-on' : ''}`} onClick={() => { setDuration(d); setOpen(false); }}>
              {label(d)}
            </button>
          ))}
          {acc && acc.seconds > 1 && (
            <button type="button" role="menuitem" data-learn="stop-now" className="menu-item menu-item--stop" onClick={() => { stopNow(); setOpen(false); }}>{t('立即结束并生成报告', 'Stop now and write the report')}</button>
          )}
        </div>
      )}
    </div>
  );
}

function Kpis() {
  const t = useT();
  const history = useStore((s) => s.history);
  const topology = useStore((s) => s.topology);
  const w = windowSys(history, 5);
  const client = topology.nodes.find((n) => n.type === 'client');
  const sloA = Number(client?.params.sloAvail ?? 0.999);
  const sloL = Number(client?.params.sloP99 ?? 500);
  const pct = sloPct(topology);
  const burn = w ? (1 - w.avail) / Math.max(1e-9, 1 - sloA) : 0;
  const cost = useGame((g) => g.costNow);
  const items = [
    { k: t('可用性', 'Availability'), v: w ? fmtAvail(w.avail) : '—', note: `SLO ${fmtAvail(sloA)}`, tone: !w ? '' : w.avail < sloA ? 'crit' : '' },
    { k: t(`${pct} 延迟`, `${pct} latency`), v: w ? fmtLatency(w[pct]) : '—', note: `SLO ${fmtLatency(sloL)}`, tone: !w ? '' : w[pct] > sloL ? 'crit' : w[pct] > sloL * 0.8 ? 'warn' : '' },
    { k: t('平均延迟', 'Avg latency'), v: w ? fmtLatency(w.avg) : '—', note: t('最近 5 秒所有请求的平均延迟', 'Mean latency of all requests over the last 5 s'), tone: '' },
    { k: t('成功', 'Succeeded'), v: w ? `${fmtRate(w.okRps)}/s` : '—', note: w ? t(`发出 ${fmtRate(w.offered)}/s`, `${fmtRate(w.offered)}/s sent`) : '', tone: '' },
    { k: t('预算燃烧', 'Burn rate'), v: w ? (burn < 0.05 ? '0×' : `${burn >= 100 ? burn.toFixed(0) : burn.toFixed(1)}×`) : '—', note: t('错误预算消耗速度', 'How fast the error budget is being spent'), tone: !w ? '' : burn >= 10 ? 'crit' : burn >= 1 ? 'warn' : '' },
    { k: t('成本', 'Cost'), v: `${fmtCost(cost)}/h`, note: t('当前配置每小时的运行成本。按粗略单价估算，只用于比较方案，不代表真实账单', 'Running cost of the current setup per hour. Estimated from rough unit prices for comparing designs, not a real bill'), tone: '' },
    { k: t('重试放大', 'Retry amp.'), v: w ? `${w.amplification.toFixed(2)}×` : '—', note: t('调用尝试 ÷ 首次调用', 'All attempts ÷ first attempts'), tone: !w ? '' : w.amplification >= 1.3 ? 'crit' : w.amplification >= 1.08 ? 'warn' : '' },
  ];
  return (
    <dl className="kpis" aria-label={t('系统指标（最近 5 秒）', 'System metrics (last 5 s)')}>
      {items.map((i) => (
        <div key={i.k} className={`kpi${i.tone ? ` kpi--${i.tone}` : ''}`} title={i.note}>
          <dt>{i.k}</dt>
          <dd>{i.v}</dd>
        </div>
      ))}
    </dl>
  );
}

function LangSwitch() {
  const lang = useLang();
  const setLang = useStore((s) => s.setLang);
  return (
    <div className="seg seg--lang" role="radiogroup" aria-label="Language / 语言">
      <button type="button" role="radio" aria-checked={lang === 'zh'} className={lang === 'zh' ? 'is-on' : ''} onClick={() => setLang('zh')} lang="zh-CN">中</button>
      <button type="button" role="radio" aria-checked={lang === 'en'} className={lang === 'en' ? 'is-on' : ''} onClick={() => setLang('en')} lang="en">EN</button>
    </div>
  );
}

function ThemeSwitch() {
  const t = useT();
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const dark = theme === 'dark';
  const label = dark ? t('切换到浅色模式', 'Switch to light mode') : t('切换到深色模式', 'Switch to dark mode');
  return (
    <button type="button" className="icon-btn" aria-label={label} title={label} onClick={() => setTheme(dark ? 'light' : 'dark')}>
      {dark ? (
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M9 1.8v1.8M9 14.4v1.8M1.8 9h1.8M14.4 9h1.8M3.9 3.9l1.3 1.3M12.8 12.8l1.3 1.3M3.9 14.1l1.3-1.3M12.8 5.2l1.3-1.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M14.8 11.2A6.3 6.3 0 0 1 6.8 3.2a6.3 6.3 0 1 0 8 8Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
      )}
    </button>
  );
}

function SoundSwitch() {
  const t = useT();
  const on = useGame((g) => g.sound);
  const toggle = useGame((g) => g.toggleSound);
  const label = on ? t('关闭音效', 'Mute sound effects') : t('打开音效', 'Turn on sound effects');
  return (
    <button type="button" className={`icon-btn${on ? ' is-on' : ''}`} aria-label={label} aria-pressed={on} title={label} onClick={toggle}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <path d="M3 7h3l4-3.5v11L6 11H3Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        {on ? <path d="M12.5 6.5a3.5 3.5 0 0 1 0 5M14.5 4.5a6.4 6.4 0 0 1 0 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          : <path d="M12.5 7l4 4M16.5 7l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
      </svg>
    </button>
  );
}

function useClickAway(open: boolean, close: () => void) {
  return {
    onBlur: (e: React.FocusEvent<HTMLDivElement>) => { if (open && !e.currentTarget.contains(e.relatedTarget as Node)) close(); },
  };
}

function TopologyMenu() {
  const t = useT();
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const setTopology = useStore((s) => s.setTopology);
  const name = useStore((s) => s.topology.name);
  const away = useClickAway(open, () => setOpen(false));
  return (
    <div className="menu" {...away}>
      <button type="button" className="menu-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="menu-k">{t('拓扑', 'Topology')}</span><span className="menu-v">{name}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <p className="menu-note">{t('载入预置拓扑会替换当前画布。需要保留的话，先在右上角导出。', 'Loading a preset replaces the current canvas. Export it first (top right) if you want to keep it.')}</p>
          {TOPOLOGY_PRESETS.map((p) => (
            <button key={p.id} type="button" role="menuitem" className="menu-item" onClick={() => { setTopology(p.make(lang), { reset: true }); setOpen(false); }}>
              {p.label[lang]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ScenarioMenu() {
  const t = useT();
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const away = useClickAway(open, () => setOpen(false));
  const startScenario = useStartScenario();
  return (
    <div className="menu" {...away}>
      <button type="button" className="menu-btn menu-btn--accent" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="menu-v">{t('演示场景', 'Scenarios')}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      </button>
      {open && (
        <div className="menu-pop menu-pop--wide" role="menu">
          {SCENARIOS.map((s) => (
            <button key={s.id} type="button" role="menuitem" className="menu-item menu-item--rich" onClick={() => { startScenario(s.id); setOpen(false); }}>
              <span className="menu-item-t">{s.label[lang]}</span>
              <span className="menu-item-d">{s.description[lang]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const SCENARIO_LEAD_S = 30;

export function useStartScenario() {
  const lang = useLang();
  const setTopology = useStore((s) => s.setTopology);
  const reset = useStore((s) => s.reset);
  const run = useStore((s) => s.run);
  const inject = useStore((s) => s.inject);
  const setScenario = useStore((s) => s.setScenario);
  const showToast = useStore((s) => s.showToast);
  return (id: string) => {
    const sc = SCENARIOS.find((s) => s.id === id);
    if (!sc) return;
    const topo = useStore.getState().topology;
    const need = sc.requires ?? [sc.failure.nodeId];
    if (!need.every((id) => topo.nodes.some((n) => n.id === id))) {
      const preset = TOPOLOGY_PRESETS.find((p) => p.id === sc.topology)!;
      setTopology(preset.make(lang));
      showToast(lang === 'en' ? `Loaded “${preset.label.en}”` : `已载入“${preset.label.zh}”`);
    }
    if (sc.setup) {
      const cur = useStore.getState().topology;
      const patched = { ...cur, nodes: cur.nodes.map((n) => ({ ...n, params: { ...n.params } })) };
      sc.setup(patched);
      useStore.getState().setTopology(patched);
    }
    reset();
    setTimeout(() => {
      inject({ ...sc.failure, id: `sc-${sc.id}-${Date.now()}` }, SCENARIO_LEAD_S);
      setScenario(sc.id);
      run();
    }, 30);
  };
}

function FileMenu({ sandbox }: { sandbox: boolean }) {
  const t = useT();
  const setCalOpen = useStore((s) => s.setCalOpen);
  const calBackup = useStore((s) => s.calBackup);
  const undoCalibration = useStore((s) => s.undoCalibration);
  const [open, setOpen] = useState(false);
  const away = useClickAway(open, () => setOpen(false));
  const topology = useStore((s) => s.topology);
  const setTopology = useStore((s) => s.setTopology);
  const showToast = useStore((s) => s.showToast);
  const fileRef = useRef<HTMLInputElement>(null);
  const [copyText, setCopyText] = useState<string | null>(null);
  const framed = (() => { try { return window.self !== window.top; } catch { return true; } })();
  const copy = async (text: string, label: string) => {
    setOpen(false);
    try {
      await navigator.clipboard.writeText(text);
      showToast(t(`已复制 ${label} 到剪贴板`, `Copied ${label} to the clipboard`));
    } catch {
      setCopyText(text);
    }
  };

  const download = (text: string, name: string, type: string) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const slug = topology.name.replace(/[\s/\\]+/g, '-');

  return (
    <div className="menu menu--end" {...away}>
      <button type="button" className="icon-btn" aria-label={t('导入导出', 'Import / export')} title={t('导入导出拓扑', 'Import or export the topology')} aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2.5v8.5M5.5 7.5 9 11l3.5-3.5M3 12.5v2.5h12v-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <button type="button" role="menuitem" className="menu-item" onClick={() => copy(yaml.dump(topology, { lineWidth: 120 }), 'YAML')}>{t('复制拓扑 YAML', 'Copy topology as YAML')}</button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => copy(JSON.stringify(topology, null, 2), 'JSON')}>{t('复制拓扑 JSON', 'Copy topology as JSON')}</button>
          {!framed && <button type="button" role="menuitem" className="menu-item" onClick={() => { download(yaml.dump(topology, { lineWidth: 120 }), `${slug}.yaml`, 'text/yaml'); setOpen(false); }}>{t('下载 YAML 文件', 'Download YAML file')}</button>}
          <button type="button" role="menuitem" className="menu-item" onClick={() => fileRef.current?.click()}>{t('导入 JSON / YAML…', 'Import JSON / YAML…')}</button>
          {sandbox && <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); setCalOpen(true); }}>{t('用生产指标校准（CSV）…', 'Calibrate from metrics (CSV)…')}</button>}
          {sandbox && calBackup && <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); undoCalibration(); showToast(t('已撤销校准', 'Calibration undone')); }}>{t('撤销校准', 'Undo calibration')}</button>}
        </div>
      )}
      {copyText !== null && (
        <div className="modal-scrim" onClick={() => setCopyText(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label={t('复制拓扑', 'Copy topology')} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>{t('浏览器不允许直接写剪贴板，请全选后复制', 'The browser blocked clipboard access. Select all and copy.')}</span>
              <button type="button" className="icon-btn" aria-label={t('关闭', 'Close')} onClick={() => setCopyText(null)}>
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              </button>
            </div>
            <textarea readOnly value={copyText} autoFocus onFocus={(e) => e.currentTarget.select()} />
          </div>
        </div>
      )}
      <input ref={fileRef} type="file" accept=".json,.yaml,.yml" hidden onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        try {
          const text = await f.text();
          const tp = (f.name.endsWith('.json') ? JSON.parse(text) : yaml.load(text)) as Topology;
          if (!tp || !Array.isArray(tp.nodes) || !Array.isArray(tp.edges)) throw new Error(t('缺少 nodes 或 edges', 'missing nodes or edges'));
          setTopology({ name: tp.name || f.name, nodes: tp.nodes, edges: tp.edges, ...(tp.calibration ? { calibration: tp.calibration } : {}) }, { reset: true });
          showToast(t(`已导入“${tp.name || f.name}”`, `Imported “${tp.name || f.name}”`));
        } catch (err) {
          showToast(t(`导入失败：${(err as Error).message}`, `Import failed: ${(err as Error).message}`), 'warn');
        }
        setOpen(false);
      }} />
    </div>
  );
}

function SettingsButton() {
  const t = useT();
  const setOpen = useObs((o) => o.setOpen);
  const label = t('设置', 'Settings');
  return (
    <button type="button" className="icon-btn" aria-label={label} title={label} onClick={() => setOpen(true)}>
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 6.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Z M8.6 2h2.8l.4 2.1 1.6.9 2-.8 1.4 2.4-1.6 1.4v1.9l1.6 1.4-1.4 2.4-2-.8-1.6.9-.4 2.1H8.6l-.4-2.1-1.6-.9-2 .8-1.4-2.4 1.6-1.4V8l-1.6-1.4 1.4-2.4 2 .8 1.6-.9z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
    </button>
  );
}
