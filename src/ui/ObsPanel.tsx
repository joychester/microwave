// "Real metrics" in the inspector: fetch a component's real numbers (a service's traffic, latency and
// CPU; a cache's commands, command time and hit ratio; a database's queries, query time and
// connections) from Prometheus, Grafana or the Grafana MCP server, next to the simulation's numbers.
import { useEffect, useMemo, useState } from 'react';
import type { NodeCfg } from '../engine/types';
import { histPct, mergeHists } from '../engine/hist';
import { useStore } from './store';
import { useLang, useT } from './i18n';
import { fmtCount, fmtLatency, fmtPct, fmtRate, windowNode } from './format';
import {
  KIND_LABEL, KIND_METRICS, NO_QUERY, NO_UID, OBS_KINDS, PRESETS, kindOf, metricLabel, metricShort, WINDOWS, windowLabel, connFor, rateForReal, ratePatch, realMetricsCsv, fetchAll, fetchFor, fetchObsConfig, runQuery, serviceFor, useObs, useObsResults,
  type ObsConn, type ObsFetched, type ObsKind, type ObsMetric, type ObsSource,
} from './obs';

const SOURCE_LABEL: Record<ObsSource, { zh: string; en: string }> = {
  prometheus: { zh: 'Prometheus', en: 'Prometheus' },
  grafana: { zh: 'Grafana', en: 'Grafana' },
  mcp: { zh: 'Grafana MCP', en: 'Grafana MCP' },
};


let configPromise: Promise<Record<ObsSource, boolean> | null> | null = null;
function useObsConfig(enabled = true) {
  const [cfg, setCfg] = useState<Record<ObsSource, boolean> | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    configPromise ??= fetchObsConfig();
    let live = true;
    configPromise.then((c) => { if (live) setCfg(c); });
    return () => { live = false; };
  }, [enabled]);
  return cfg;
}

function fmt(m: ObsMetric, v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  if (m === 'rps') return `${fmtRate(v)}/s`;
  if (m === 'cpu' || m === 'hit') return fmtPct(v);
  if (m === 'conns' || m === 'maxconn') return fmtCount(Math.round(v));
  return fmtLatency(v);
}

/** Marks the real-metrics feature as a preview: usable now, to be standardized and extended later. */
export function PreviewBadge() {
  const t = useT();
  return <span className="pv-badge" title={t('预览功能：可以先试用；接口和配置格式之后会规范和加强，可能会变化', 'Preview: usable now; the interface and settings format will be standardized and extended later and may change')}>{t('预览', 'Preview')}</span>;
}

type TFn = (zh: string, en: string) => string;
/** What the label field is called for a kind of component. */
export const labelName = (kind: ObsKind, t: TFn) => (kind === 'http' ? t('服务标签', 'Service label') : t('Prometheus job', 'Prometheus job'));
export const labelHint = (kind: ObsKind, t: TFn) => (kind === 'cache' ? t('例如 redis-cart', 'e.g. redis-cart') : kind === 'database' ? t('例如 orders-db', 'e.g. orders-db') : t('例如 order-service', 'e.g. order-service'));

/** The simulation's numbers for a component over the last 5 s, on the same footing as the top bar. */
export function useSimMetrics(id: string): Record<ObsMetric, number> | null {
  const history = useStore((s) => s.history);
  const type = useStore((s) => s.topology.nodes.find((n) => n.id === id)?.type);
  return useMemo(() => {
    const w = windowNode(history, id, 5);
    if (!w) return null;
    const last5 = history.slice(-5).map((s) => s.nodes[id]).filter(Boolean);
    const hs = last5.map((x) => x!.hist);
    const p90 = hs.length && hs.every(Boolean) ? histPct(mergeHists(hs), 0.9) : NaN;
    // weighted by count, ignoring seconds with no data
    const wavg = (k: string, wk?: string) => {
      let sum = 0, n = 0;
      for (const x of last5) {
        const v = x!.extra[k], c = wk ? x!.extra[wk] ?? 0 : 1;
        if (v !== undefined && isFinite(v) && c > 0) { sum += v * c; n += c; }
      }
      return n > 0 ? sum / n : NaN;
    };
    // a cache's command time leaves out the origin fetch on a miss, like Redis reports it
    const avg = type === 'cache' ? wavg('cmdMs', 'cmdN') : w.mean ?? NaN;
    return { rps: w.arr, avg, p90, cpu: w.cpu, hit: wavg('hitRatio'), conns: wavg('conns'), maxconn: w.extra.maxConns ?? NaN };
  }, [history, id, type]);
}

/** Real vs simulated, for the metrics that were fetched. */
export function CompareResult({ nodeId, kind, saved, sim, compact = false }: { nodeId: string; kind: ObsKind; saved: ObsFetched; sim: Record<ObsMetric, number> | null; compact?: boolean }) {
  const t = useT();
  const lang = useLang();
  const data = saved.data;
  const shown = KIND_METRICS[kind].filter((m) => data[m]);
  const real = data.rps?.value;
  const rpsGap = real && sim?.rps ? Math.abs(sim.rps - real) / real : 0;
  const errText = (e?: string) => (e === NO_UID ? t('这个数据来源还没填 Prometheus 数据源 UID，请在设置里补上', 'This source has no Prometheus datasource UID yet; add it in Settings')
    : e === NO_QUERY ? t(`这个数据来源没有这项指标的 PromQL 模板，请在设置的\u201c${KIND_LABEL[kind].zh}\u201d模板里补上`, `This source has no PromQL template for this metric; add one under ${KIND_LABEL[kind].en} in Settings`) : e);
  const errs = shown.filter((m) => data[m]!.error);
  return (
    <>
      <table className="obs-table">
        <thead>
          <tr>
            <th scope="col">{t('指标', 'Metric')}</th>
            <th scope="col" className="r">{t('真实', 'Real')}</th>
            <th scope="col" className="r">{t('仿真', 'Sim')}</th>
            <th scope="col" className="r">{t('差异', 'Diff')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((m) => {
            const r = data[m]!;
            const s = sim ? sim[m] : NaN;
            const d = r.value && isFinite(s) ? (s - r.value) / r.value : NaN;
            const big = isFinite(d) && Math.abs(d) > 0.2;
            return (
              <tr key={m}>
                <th scope="row" title={r.query}>{metricShort(kind, m, lang)}</th>
                <td className="r">{r.error ? <span className="obs-err" title={errText(r.error)}>{t('查询失败', 'Failed')}</span> : fmt(m, r.value)}</td>
                <td className="r">{fmt(m, s)}</td>
                <td className={`r${big ? ' obs-big' : ''}`}>{isFinite(d) ? `${d > 0 ? '+' : ''}${Math.round(d * 100)}%` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="obs-foot">
        {t(`真实：${saved.conn}，最近 ${windowLabel(saved.window, lang)}；仿真：最近 5 秒。获取于 ${new Date(saved.at).toLocaleTimeString()}。`, `Real: ${saved.conn}, last ${windowLabel(saved.window, lang)}; sim: last 5 s. Fetched at ${new Date(saved.at).toLocaleTimeString()}.`)}
        {!sim && t(' 仿真还没运行，先运行一会儿再对比。', ' The simulation hasn\u2019t run yet; run it for a while to compare.')}
      </p>
      <RealActions nodeId={nodeId} real={real} />
      {rpsGap > 0.2 && (
        <p className="obs-note">{kind === 'http'
          ? t(`仿真流量和真实流量差了 ${Math.round(rpsGap * 100)}%，延迟和 CPU 的对比参考意义有限。可以先把用户流量调到真实值再看。`, `Simulated and real traffic differ by ${Math.round(rpsGap * 100)}%, so latency and CPU aren\u2019t directly comparable. Set the traffic source to the real rate first.`)
          : t(`仿真和真实的${kind === 'cache' ? '命令数' : '查询数'}差了 ${Math.round(rpsGap * 100)}%。先把入口流量对齐；如果还对不上，检查上游每个请求调用它几次。`, `Simulated and real ${kind === 'cache' ? 'commands' : 'queries'} per second differ by ${Math.round(rpsGap * 100)}%. Match the traffic source first; if it still differs, check how many calls per request its callers make.`)}</p>
      )}
      {errs.length > 0 && !compact && (
        <ul className="obs-errs">
          {errs.map((m) => <li key={m}><b>{metricLabel(kind, m)[lang]}</b>: {errText(data[m]!.error)}</li>)}
        </ul>
      )}
    </>
  );
}

/** Turn real metrics into the model: match the traffic, or calibrate from every fetched component. */
function RealActions({ nodeId, real }: { nodeId: string; real: number | null | undefined }) {
  const t = useT();
  const topo = useStore((s) => s.topology);
  const running = useStore((s) => s.running);
  const update = useStore((s) => s.updateNodeParams);
  const toast = useStore((s) => s.showToast);
  const openCal = useStore((s) => s.setCalOpen);
  const by = useObsResults((r) => r.by);
  const rate = real ? rateForReal(topo, nodeId, real) : null;
  const needRate = !!rate && Math.abs(rate.to - rate.from) / Math.max(1, rate.from) > 0.02;
  const csv = useMemo(() => realMetricsCsv(topo, by), [topo, by]);
  const paused = running ? t('暂停后可用：这会修改仿真模型', 'Pause first: this changes the model') : undefined;
  const setRate = () => {
    if (!rate) return;
    const client = topo.nodes.find((n) => n.id === rate.clientId);
    if (!client) return;
    update(client.id, ratePatch(client, rate.to));
    toast(t(`入口流量已从 ${fmtRate(rate.from)}/s 调到 ${fmtRate(rate.to)}/s。运行一会儿后再对比延迟和 CPU。`, `Traffic source set from ${fmtRate(rate.from)}/s to ${fmtRate(rate.to)}/s. Run for a while, then compare latency and CPU.`));
  };
  const calibrate = () => openCal(true, { text: csv.text, source: t(`真实指标（${csv.rows} 个组件）`, `real metrics (${csv.rows} components)`) });
  if (!needRate && csv.rows === 0) return null;
  return (
    <div className="obs-actions">
      {needRate && (
        <button type="button" className="btn" disabled={running} title={paused ?? t('按容量分析推算，让这个组件的流量和真实值一致', 'Scaled with the capacity analysis so this component gets its real traffic')} onClick={setRate}>
          {t(`把入口流量调到 ${fmtRate(rate!.to)}/s`, `Set traffic to ${fmtRate(rate!.to)}/s`)}
        </button>
      )}
      {csv.rows > 0 && (
        <button type="button" className="btn" disabled={running} title={paused ?? t('用已拉取的真实指标反推模型参数，先预览再应用，可撤销', 'Backsolve model parameters from the fetched metrics; preview first, undoable')} onClick={calibrate}>
          {csv.rows > 1 ? t(`按真实值校准（${csv.rows} 个组件）…`, `Calibrate from real metrics (${csv.rows})…`) : t('按真实值校准…', 'Calibrate from real metrics…')}
        </button>
      )}
    </div>
  );
}

export function RealMetrics({ node }: { node: NodeCfg }) {
  const t = useT();
  const lang = useLang();
  const conns = useObs((o) => o.conns);
  const openSettings = useObs((o) => o.setOpen);
  const cfg = useObsConfig();
  const update = useStore((s) => s.updateNodeParams);
  const saved = useObsResults((r) => r.by[node.id]);
  const [busy, setBusy] = useState(false);
  const service = serviceFor(node);
  const [draft, setDraft] = useState(service);
  useEffect(() => setDraft(service), [service, node.id]);
  // the component's chosen source; with a single source configured, that one
  const conn: ObsConn | undefined = connFor(node, conns);

  const sim = useSimMetrics(node.id);
  const kind = kindOf(node.type);

  if (conns.length === 0) {
    return (
      <div className="obs">
        <p className="obs-note">{t(`还没有配置性能数据来源。在\u201c设置\u201d里添加 Prometheus、Grafana 或 Grafana MCP 后，就能在这里一键获取${KIND_METRICS[kind].map((m) => metricShort(kind, m, 'zh')).join('、')}，和仿真结果对比。`, `No performance-data source yet. Add Prometheus, Grafana or Grafana MCP in Settings, then fetch ${KIND_METRICS[kind].map((m) => metricShort(kind, m, 'en').toLowerCase()).join(', ')} here to compare with the simulation.`)}</p>
        <button type="button" className="btn" onClick={() => openSettings(true)}>{t('打开设置', 'Open settings')}</button>
      </div>
    );
  }

  const noProxy = cfg === null;
  const notConfigured = !!(conn && cfg && !cfg[conn.source]);
  const commitService = () => { if (draft.trim() !== service) update(node.id, { obsService: draft.trim() }); };
  const go = async () => {
    commitService();
    const svc = draft.trim();
    if (!svc || !conn) return;
    setBusy(true);
    try { await fetchFor(node, conn, svc); } finally { setBusy(false); }
  };

  return (
    <div className="obs">
      <div className="obs-row">
        <label className="obs-field">
          <span>{t('数据来源', 'Source')}</span>
          <select value={conn?.id ?? ''} onChange={(e) => update(node.id, { obsConn: e.target.value })}>
            {!conn && <option value="">{t('请选择', 'Choose one')}</option>}
            {conns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="obs-field">
          <span>{labelName(kind, t)}</span>
          <input
            value={draft}
            placeholder={labelHint(kind, t)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitService}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void go(); } }}
          />
        </label>
      </div>
      <div className="obs-bar">
        <button type="button" className="btn btn--primary" disabled={busy || !draft.trim() || !conn || noProxy || notConfigured} onClick={() => void go()}>
          {busy ? t('获取中…', 'Fetching…') : t('获取真实指标', 'Fetch real metrics')}
        </button>
        {conn && <span className="obs-src">{SOURCE_LABEL[conn.source][lang]} · {t(`最近 ${windowLabel(conn.window, lang)}`, `last ${windowLabel(conn.window, lang)}`)}</span>}
        <button type="button" className="link" onClick={() => openSettings(true)}>{t('设置', 'Settings')}</button>
      </div>
      {noProxy && <p className="obs-note">{t('需要用 npm run dev 或 npm run preview 运行，并在 .env.local 里配置地址（见 .env.example）。', 'Run with npm run dev or npm run preview, and set the address in .env.local (see .env.example).')}</p>}
      {notConfigured && conn && <p className="obs-note">{t(`服务器还没配置 ${SOURCE_LABEL[conn.source].zh} 的地址，请在 .env.local 里添加。`, `The server has no ${SOURCE_LABEL[conn.source].en} address yet; add it to .env.local.`)}</p>}

      {saved && <CompareResult nodeId={node.id} kind={kind} saved={saved} sim={sim} />}
    </div>
  );
}

// ---------------------------------------------------------------- settings dialog
function ConnEditor({ c, cfg }: { c: ObsConn; cfg: Record<ObsSource, boolean> | null | undefined }) {
  const t = useT();
  const lang = useLang();
  const update = useObs((o) => o.update);
  const remove = useObs((o) => o.remove);
  const usePreset = useObs((o) => o.usePreset);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const set = (p: Partial<ObsConn>) => { update(c.id, p); setTest(null); };
  const runTest = async () => {
    setTesting(true); setTest(null);
    try {
      const v = await runQuery('vector(1)', c);
      setTest(v === 1 ? { ok: true, text: t('连接正常', 'Connected') } : { ok: false, text: t(`返回了意外的结果：${v}`, `Unexpected result: ${v}`) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTest({ ok: false, text: msg === NO_UID ? t('请先填写 Prometheus 数据源 UID', 'Fill in the Prometheus datasource UID first') : msg });
    } finally { setTesting(false); }
  };
  return (
    <div className="obs-conn">
      <div className="obs-grid">
        <label>
          <span>{t('名称', 'Name')}</span>
          <input value={c.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label>
          <span>{t('类型', 'Type')}</span>
          <select value={c.source} onChange={(e) => set({ source: e.target.value as ObsSource })}>
            {(['mcp', 'grafana', 'prometheus'] as ObsSource[]).map((s) => (
              <option key={s} value={s}>{SOURCE_LABEL[s][lang]}{cfg === undefined ? '' : cfg?.[s] ? '' : t('（服务器未配置）', ' (not configured on server)')}</option>
            ))}
          </select>
        </label>
        {c.source !== 'prometheus' && (
          <label>
            <span>{t('Prometheus 数据源 UID', 'Prometheus datasource UID')}</span>
            <input value={c.datasourceUid} placeholder={t('Grafana 数据源设置页 URL 里的 ID', 'The ID in the datasource settings URL')} onChange={(e) => set({ datasourceUid: e.target.value })} />
          </label>
        )}
        <label>
          <span>{t('统计窗口', 'Window')}</span>
          <select value={c.window} onChange={(e) => set({ window: e.target.value })}>
            {WINDOWS.map((w) => <option key={w} value={w}>{t(`最近 ${windowLabel(w, lang)}`, `Last ${windowLabel(w, lang)}`)}</option>)}
          </select>
        </label>
      </div>
      <div className="obs-presets">
        <span className="obs-presets-h">{t('PromQL 预设', 'PromQL presets')}</span>
        {OBS_KINDS.map((k) => (
          <label key={k} className="obs-preset">
            <span>{KIND_LABEL[k][lang]}</span>
            <select value={c.preset[k]} onChange={(e) => { usePreset(c.id, k, e.target.value); setTest(null); }}>
              {PRESETS[k].map((p) => <option key={p.id} value={p.id}>{p.label[lang]}</option>)}
              {!PRESETS[k].some((p) => p.id === c.preset[k]) && <option value={c.preset[k]}>{t('自定义', 'Custom')}</option>}
            </select>
          </label>
        ))}
      </div>
      <details className="obs-qs">
        <summary>{t('查看或修改 PromQL 模板', 'View or edit the PromQL templates')}</summary>
        <p className="obs-hint">{t('{service} 替换成组件卡片上填的标签（服务标签或 job），{window} 替换成统计窗口。延迟以毫秒返回，CPU 和命中率以 0–1 返回。', '{service} becomes the label set on the card (service label or job) and {window} the window. Latency comes back in ms, CPU and hit ratio as 0–1.')}</p>
        {OBS_KINDS.map((k) => (
          <fieldset key={k} className="obs-qgroup">
            <legend>{KIND_LABEL[k][lang]}</legend>
            {KIND_METRICS[k].map((m) => (
              <label key={m} className="obs-q">
                <span>{metricLabel(k, m)[lang]}</span>
                <textarea rows={2} spellCheck={false} value={c.queries[k]?.[m] ?? ''} onChange={(e) => set({ preset: { ...c.preset, [k]: 'custom' }, queries: { ...c.queries, [k]: { ...c.queries[k], [m]: e.target.value } } })} />
              </label>
            ))}
          </fieldset>
        ))}
      </details>
      <div className="obs-conn-foot">
        <button type="button" className="btn" disabled={testing} onClick={() => void runTest()}>{testing ? t('测试中…', 'Testing…') : t('测试连接', 'Test connection')}</button>
        {test && <span className={test.ok ? 'obs-ok' : 'obs-err'}>{test.text}</span>}
        <button type="button" className="link obs-del" onClick={() => remove(c.id)}>{t('删除', 'Delete')}</button>
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const t = useT();
  const lang = useLang();
  const open = useObs((o) => o.open);
  const setOpen = useObs((o) => o.setOpen);
  const conns = useObs((o) => o.conns);
  const add = useObs((o) => o.add);
  const cfg = useObsConfig(open);
  if (!open) return null;
  return (
    <div className="gm-scrim" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="gm gm--obs" role="dialog" aria-modal="true" aria-labelledby="set-h">
        <header className="gm-head">
          <div><h2 id="set-h">{t('设置', 'Settings')}</h2></div>
          <button type="button" className="btn btn--ghost" onClick={() => setOpen(false)}>{t('完成', 'Done')}</button>
        </header>
        <section className="set-sec">
          <h3>{t('性能数据来源', 'Performance-data sources')} <PreviewBadge /></h3>
          <p className="obs-note pv-note">{t('这是预览功能：现在就可以连接 Prometheus、Grafana 或 Grafana MCP 试用。之后会进一步规范和加强，配置格式和接口可能会调整。', 'This is a preview: you can connect Prometheus, Grafana or Grafana MCP and try it now. It will be standardized and extended later, and the settings format and interface may change.')}</p>
          <p className="obs-hint">{t('在这里配置真实监控数据从哪里来。服务、网关、缓存和数据库卡片可以各自选用其中一个（卡片右下角的吸管，或检查器的\u201c真实指标\u201d），一键获取真实指标，和仿真对比。', 'Configure where real monitoring data comes from. Service, gateway, cache and database cards each pick one (the pipette at a card\u2019s bottom right, or Real metrics in the inspector) to fetch real metrics and compare them with the simulation.')}</p>
          <p className="obs-hint">{cfg === null
            ? t('当前没有 /obs 代理：需要用 npm run dev 或 npm run preview 运行，并在 .env.local 里填写地址和 token（见 .env.example）。', 'No /obs proxy right now: run with npm run dev or npm run preview and put addresses and tokens in .env.local (see .env.example).')
            : t('地址和 token 在服务器端的 .env.local 里（不进浏览器）。服务器已配置：', 'Addresses and tokens live in .env.local on the server (never in the browser). Configured on the server: ') + (cfg ? (['mcp', 'grafana', 'prometheus'] as ObsSource[]).filter((s) => cfg[s]).map((s) => SOURCE_LABEL[s][lang]).join(lang === 'zh' ? '、' : ', ') || t('无', 'none') : '…')}</p>
          {conns.map((c) => <ConnEditor key={c.id} c={c} cfg={cfg} />)}
          <button type="button" className="btn btn--primary" onClick={() => add(lang)}>{t('添加数据来源', 'Add a source')}</button>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- one click for everything (top bar)
export function FetchAllButton() {
  const t = useT();
  const has = useObs((o) => o.conns.length > 0);
  const busy = useObsResults((r) => r.busy);
  const toast = useStore((s) => s.showToast);
  if (!has) return null;
  const go = async () => {
    const { ok, failed, skipped } = await fetchAll(useStore.getState().topology.nodes);
    if (ok + failed === 0) {
      toast(t('没有可拉取的组件：用卡片上的吸管给组件选数据来源、填标签。', 'Nothing to fetch: use a card\u2019s pipette to pick a source and a label.'), 'warn');
      return;
    }
    const tail = skipped ? t(`，${skipped} 个未配置标签`, `, ${skipped} without a label`) : '';
    toast(failed
      ? t(`拉取完成：${ok} 个成功，${failed} 个失败${tail}。点开组件看详情。`, `Fetched: ${ok} ok, ${failed} failed${tail}. Open a component for details.`)
      : t(`已拉取 ${ok} 个组件的真实指标${tail}。点开组件，在\u201c真实指标\u201d里和仿真对比。`, `Fetched real metrics for ${ok} components${tail}. Open a component to compare with the simulation.`), failed ? 'warn' : 'info');
  };
  const label = t('拉取真实指标', 'Fetch real metrics');
  return (
    <button type="button" className="btn obs-all" disabled={busy} title={t('为所有配置了标签的服务、网关、缓存和数据库拉取真实指标', 'Fetch real metrics for every service, gateway, cache and database with a label')} onClick={() => void go()}>
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8 M4.5 6.8 8 10.3l3.5-3.5 M2.5 12.5v1.5h11v-1.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      {busy ? t('拉取中…', 'Fetching…') : label}
      <PreviewBadge />
    </button>
  );
}
