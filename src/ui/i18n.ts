import { useCallback } from 'react';
import type { Lang, Text } from '../engine/types';
import { useStore } from './store';

export type T = (zh: string, en: string) => string;

export function useLang(): Lang {
  return useStore((s) => s.lang);
}

/** t('中文', 'English') picks the string for the current language. */
export function useT(): T {
  const lang = useLang();
  return useCallback((zh: string, en: string) => (lang === 'en' ? en : zh), [lang]);
}

export function tx(text: Text | undefined, lang: Lang): string {
  return text ? text[lang] : '';
}

/** Chinese uses full-width separators; English uses ASCII ones. */
export function sep(lang: Lang) {
  return lang === 'en' ? { comma: ', ', colon: ': ', semi: '; ' } : { comma: '，', colon: '：', semi: '；' };
}
