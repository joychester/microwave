import { useEffect } from 'react';
import { useStore, type Theme } from './store';

// Categorical chart palettes, validated with the dataviz validator:
// light on #ffffff: worst adjacent CVD ΔE 9.1, normal-vision 19.6
// dark on #1b2128:  worst adjacent CVD ΔE 8.4, normal-vision 19.3, all ≥ 3:1 contrast
export const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];
export const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c'];

export const CHART_CHROME: Record<Theme, { axis: string; grid: string; neutral: string; cursor: string }> = {
  light: { axis: '#6b7884', grid: '#e3e8ed', neutral: '#8593a0', cursor: '#9aa6b2' },
  dark: { axis: '#93a0ad', grid: '#2a323b', neutral: '#7d8a97', cursor: '#5d6a77' },
};

export function useSeries(): string[] {
  const theme = useStore((s) => s.theme);
  return theme === 'dark' ? SERIES_DARK : SERIES_LIGHT;
}

export function useChrome() {
  return CHART_CHROME[useStore((s) => s.theme)];
}

/** Mirrors theme + language onto <html> so CSS and assistive tech follow. */
export function useDocumentPrefs() {
  const theme = useStore((s) => s.theme);
  const lang = useStore((s) => s.lang);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);
  useEffect(() => {
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
    document.title = lang === 'en' ? 'SimBench microservice performance simulator' : 'SimBench 微服务性能仿真';
  }, [lang]);
}
