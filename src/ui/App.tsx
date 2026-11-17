import { useEffect } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { NODE_SPECS } from '../engine/specs';
import { SCENARIOS, newNode } from '../engine/presets';
import type { NodeType } from '../engine/types';
import { useStore } from './store';
import { Canvas } from './Canvas';
import { Inspector } from './Inspector';
import { Dock } from './Dock';
import { TopBar, SCENARIO_LEAD_S } from './TopBar';
import { Glyph } from './Glyph';
import { useLang, useT } from './i18n';
import { useDocumentPrefs } from './theme';
import { levelById, useGame } from './game';
import { Countdown, GameHud, GameLayer } from './GameUI';
import { CalibrateDialog } from './CalibrateDialog';

const PALETTE: NodeType[] = ['client', 'gateway', 'lb', 'service', 'cache', 'database', 'queue', 'external'];
const SHORT: Record<NodeType, { zh: string; en: string }> = {
  client: { zh: '流量源', en: 'Traffic' }, gateway: { zh: 'Gateway', en: 'Gateway' }, lb: { zh: 'LB', en: 'LB' },
  service: { zh: '微服务', en: 'Service' }, cache: { zh: '缓存', en: 'Cache' }, database: { zh: '数据库', en: 'Database' }, queue: { zh: '消息队列', en: 'Queue' },
  external: { zh: '外部依赖', en: '3rd-party' },
};

function Palette() {
  const t = useT();
  const lang = useLang();
  const addNode = useStore((s) => s.addNode);
  const mode = useGame((g) => g.mode);
  const level = levelById(useGame((g) => g.levelId));
  const allowed = (ty: NodeType) => mode !== 'challenge' || !level || level.allowedComponents.includes(ty);
  const { screenToFlowPosition } = useReactFlow();
  return (
    <nav className="palette" aria-label={t('组件', 'Components')}>
      <h2 className="palette-h">{t('组件', 'Components')}</h2>
      <ul>
        {PALETTE.map((ty) => {
          const spec = NODE_SPECS[ty];
          const ok = allowed(ty);
          return (
            <li key={ty}>
              <button
                type="button"
                className={`pal-item${ok ? '' : ' is-locked'}`}
                disabled={!ok}
                draggable={ok}
                onDragStart={(e) => { e.dataTransfer.setData('application/simbench', ty); e.dataTransfer.effectAllowed = 'copy'; }}
                onClick={() => {
                  const el = document.querySelector('.canvas');
                  const r = el?.getBoundingClientRect();
                  const p = screenToFlowPosition({ x: (r?.left ?? 0) + (r?.width ?? 800) / 2, y: (r?.top ?? 0) + (r?.height ?? 600) / 2 });
                  const n = newNode(ty, Math.round(p.x - 104 + (Math.random() - 0.5) * 60), Math.round(p.y - 50 + (Math.random() - 0.5) * 60), useStore.getState().topology.nodes, lang);
                  const d = mode === 'challenge' ? level?.newNodeDefaults[ty] : undefined;
                  if (d) n.params = { ...n.params, ...d };
                  addNode(n);
                }}
                title={!ok ? t('本关不能添加这个组件', 'Not available in this level') : lang === 'en' ? `${spec.label.en}: ${spec.blurb.en}. Drag onto the canvas or click to add` : `${spec.label.zh}：${spec.blurb.zh}。拖到画布，或点击添加`}
                aria-label={t(`添加${spec.label.zh}`, `Add ${spec.label.en.toLowerCase()}`)}
              >
                <span className="pal-glyph"><Glyph type={ty} /></span>
                <span className="pal-text">
                  <span className="pal-name">{SHORT[ty][lang]}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="palette-tip">{t('拖到画布', 'Drag to canvas')}</p>
    </nav>
  );
}

function ScenarioBanner() {
  const mode = useGame((g) => g.mode);
  const t = useT();
  const lang = useLang();
  const id = useStore((s) => s.activeScenario);
  const setScenario = useStore((s) => s.setScenario);
  const simTime = useStore((s) => s.simTime);
  const failures = useStore((s) => s.failures);
  const pending = useStore((s) => s.pending);
  const sc = SCENARIOS.find((s) => s.id === id);
  if (!sc || mode === 'challenge') return null;
  const mine = failures.find((f) => f.id.startsWith(`sc-${sc.id}`));
  const waiting = pending.find((p) => p.id.startsWith(`sc-${sc.id}`));
  let status = '';
  const ended = t('故障已结束，观察系统能否回到基线', 'Fault over. Watch whether the system returns to baseline');
  if (waiting) {
    const n = Math.max(0, Math.ceil((waiting.at - simTime) / 1000));
    status = t(`基线运行中，${n} 秒后注入故障`, `Running baseline, fault in ${n}s`);
  } else if (mine && (mine.end < 0 || simTime < mine.end)) {
    const n = Math.ceil((mine.end - simTime) / 1000);
    status = mine.end > 0 ? t(`故障进行中，还剩 ${n} 秒`, `Fault active, ${n}s left`) : t('故障进行中', 'Fault active');
  } else if (mine) status = mine.recovery_s > 0 && simTime < mine.end + mine.recovery_s * 1000 ? t('故障已结束，正在逐步恢复，观察系统能否回到基线', 'Fault over, recovering gradually. Watch whether the system returns to baseline') : ended;
  else if (simTime > SCENARIO_LEAD_S * 1000 + 1500) status = ended;
  else status = t(`故障在第 ${SCENARIO_LEAD_S} 秒注入`, `Fault starts at ${SCENARIO_LEAD_S}s`);
  return (
    <div className="banner" role="status">
      <div className="banner-main">
        <div className="banner-t">{sc.label[lang]}</div>
        <p className="banner-d">{sc.description[lang]}</p>
        <p className="banner-s">{status}</p>
      </div>
      <button type="button" className="icon-btn" aria-label={t('关闭场景说明', 'Close scenario note')} onClick={() => setScenario(null)}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}

function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return <div key={toast.id} className={`toast toast--${toast.tone}`} role="status">{toast.text}</div>;
}

function Shortcuts() {
  const toggle = useStore((s) => s.toggle);
  const mode = useGame((g) => g.mode);
  const phase = useGame((g) => g.phase);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (mode === 'challenge' && phase !== 'playing') return;
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, mode, phase]);
  return null;
}

function DocPrefs() {
  useDocumentPrefs();
  return null;
}

export function App() {
  return (
    <ReactFlowProvider>
      <div className="app">
        <TopBar />
        <Palette />
        <main className="stage">
          <Canvas />
          <ScenarioBanner />
          <GameHud />
          <Countdown />
          <Toast />
        </main>
        <aside className="inspector" aria-label="Inspector">
          <Inspector />
        </aside>
        <Dock />
        <Shortcuts />
        <DocPrefs />
        <GameLayer />
        <CalibrateDialog />
      </div>
    </ReactFlowProvider>
  );
}
