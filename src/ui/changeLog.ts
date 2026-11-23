// Logs your own edits made during a run (instances 3 → 1, CPU cores, a call added…) as events,
// so the Events list lines them up with what the simulation did next.
// Quick successive edits (clicking − twice) are merged into one event: 3 → 1, not 3 → 2, 2 → 1.
import { L, type SimEvent, type Text, type Topology } from '../engine/types';
import { diffConfigs, type ConfigChange } from './configDiff';
import { useRuns } from './runs';
import { useStore } from './store';

const SETTLE_MS = 900;
const MAX_LISTED = 4;

/** Drop the params that only say where to read real metrics; they don't change the model. */
function modelOnly(t: Topology): Topology {
  return { ...t, nodes: t.nodes.map((n) => ({ ...n, params: Object.fromEntries(Object.entries(n.params).filter(([k]) => !k.startsWith('obs'))) })) };
}

function line(c: ConfigChange, lang: 'zh' | 'en'): string {
  if (c.kind === 'added') return lang === 'zh' ? `添加 ${c.where}` : `Added ${c.where}`;
  if (c.kind === 'removed') return lang === 'zh' ? `删除 ${c.where}` : `Removed ${c.where}`;
  return lang === 'zh' ? `${c.where}：${c.what?.zh} ${c.from} → ${c.to}` : `${c.where}: ${c.what?.en} ${c.from} → ${c.to}`;
}

export function configChangeEvents(before: Topology, after: Topology, tSec: number): SimEvent[] {
  const a = modelOnly(before), b = modelOnly(after);
  const zh = diffConfigs(a, b, 'zh');
  const en = diffConfigs(a, b, 'en');
  if (zh.length === 0) return [];
  // the one component (or call) the edit was about, so clicking the event selects it
  const target = (i: number): Pick<SimEvent, 'nodeId' | 'edgeId'> => {
    const c = zh[i];
    const node = after.nodes.find((n) => n.name === c.where);
    if (node) return { nodeId: node.id };
    const edge = after.edges.find((e) => `${after.nodes.find((n) => n.id === e.from)?.name} → ${after.nodes.find((n) => n.id === e.to)?.name}` === c.where);
    return edge ? { edgeId: edge.id } : {};
  };
  if (zh.length <= MAX_LISTED) {
    return zh.map((_, i) => ({ t: tSec, level: 'change', code: 'config', text: L(line(zh[i], 'zh'), line(en[i], 'en')), ...target(i) }));
  }
  // a big edit (a whole topology swapped in, say): one summary event instead of a flood
  const head = (cs: ConfigChange[], lang: 'zh' | 'en') => cs.slice(0, 3).map((c) => line(c, lang)).join(lang === 'zh' ? '；' : '; ');
  const text: Text = L(`${zh.length} 处配置改动：${head(zh, 'zh')} 等`, `${en.length} edits: ${head(en, 'en')} and more`);
  return [{ t: tSec, level: 'change', code: 'config', text }];
}

/** Start watching the topology. Call once at startup. */
export function startChangeLog() {
  let base: Topology | null = null; // configuration before the first edit of the current burst
  let at = 0; // sim time (ms) of that first edit
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    const before = base;
    base = null;
    const st = useStore.getState();
    if (!before || !useRuns.getState().acc) return; // the run ended or was reset meanwhile
    const evs = configChangeEvents(before, st.topology, at / 1000);
    if (evs.length === 0) return;
    // put them where they happened: engine events from the settle window may already be later
    let i = st.events.length;
    while (i > 0 && st.events[i - 1].t > at / 1000) i--;
    const all = [...st.events.slice(0, i), ...evs, ...st.events.slice(i)];
    useStore.setState({
      events: all.length > 400 ? all.slice(all.length - 400) : all,
      unseenEvents: st.dockOpen && st.dockTab === 'events' ? st.unseenEvents : st.unseenEvents + evs.length,
    });
  };

  useStore.subscribe((s, prev) => {
    if (s.topology === prev.topology) return;
    // only edits inside a run (going or paused) are events; between runs the report compares configurations
    if (!useRuns.getState().acc) { base = null; return; }
    if (!base) { base = prev.topology; at = s.simTime; }
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, SETTLE_MS);
  });
}
