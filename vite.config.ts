import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Real-metrics proxy. Set any of these in .env.local (never committed):
 *   MICROWAVE_PROMETHEUS_URL   e.g. http://localhost:9090          (optional MICROWAVE_PROMETHEUS_TOKEN)
 *   MICROWAVE_GRAFANA_URL      e.g. https://grafana.example.com    with MICROWAVE_GRAFANA_TOKEN (service account)
 *   MICROWAVE_MCP_URL          e.g. http://localhost:8000/mcp      (optional MICROWAVE_MCP_TOKEN)
 * The older SIMBENCH_ prefix is still read when the MICROWAVE_ one isn't set.
 * The browser only ever calls /obs/...; tokens are added here, on the dev/preview server.
 */
type Env = (key: string) => string | undefined;

function obsProxy(env: Env): Record<string, ProxyOptions> {
  const out: Record<string, ProxyOptions> = {};
  const add = (name: string, url: string | undefined, token: string | undefined) => {
    if (!url) return;
    const u = new URL(url);
    const base = u.pathname.replace(/\/+$/, '');
    out[`/obs/${name}`] = {
      target: u.origin,
      changeOrigin: true,
      rewrite: (p) => base + p.replace(new RegExp(`^/obs/${name}`), ''),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    };
  };
  add('prometheus', env('PROMETHEUS_URL'), env('PROMETHEUS_TOKEN'));
  add('grafana', env('GRAFANA_URL'), env('GRAFANA_TOKEN'));
  add('mcp', env('MCP_URL'), env('MCP_TOKEN'));
  return out;
}

/** GET /obs/config: which sources have a target (booleans only, no URLs or tokens). */
function obsConfig(env: Env): Plugin {
  const body = JSON.stringify({ prometheus: !!env('PROMETHEUS_URL'), grafana: !!env('GRAFANA_URL'), mcp: !!env('MCP_URL') });
  const mw = (req: { url?: string }, res: { setHeader: (k: string, v: string) => void; end: (b: string) => void }, next: () => void) => {
    if (req.url !== '/obs/config') return next();
    res.setHeader('Content-Type', 'application/json');
    res.end(body);
  };
  return {
    name: 'simbench-obs-config',
    configureServer: (server) => { server.middlewares.use(mw); },
    configurePreviewServer: (server) => { server.middlewares.use(mw); },
  };
}

export default defineConfig(({ mode }) => {
  const raw = loadEnv(mode, process.cwd(), ['MICROWAVE_', 'SIMBENCH_']);
  const env: Env = (key) => raw[`MICROWAVE_${key}`] || raw[`SIMBENCH_${key}`] || undefined;
  const proxy = obsProxy(env);
  return {
    plugins: [react(), viteSingleFile(), obsConfig(env)],
    build: { target: 'es2020', assetsInlineLimit: 100000000, chunkSizeWarningLimit: 5000 },
    worker: { format: 'iife' },
    server: { proxy },
    preview: { proxy },
  };
});
