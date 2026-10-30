import type { ResourceLanguage } from 'i18next';

/** The fork's text, under `hyyz17200.*`, kept out of upstream's locale files.
 *  Languages not listed fall back to English. */
const HYYZ17200_LOCALES: Record<string, ResourceLanguage> = {
  en: {
    inAppUpdateLocked: 'In-app updates are disabled on this fork. Build and install it manually.',
  },
  'zh-CN': {
    inAppUpdateLocked: '此 fork 已禁用应用内更新，请手动构建安装。',
  },
};

/** A language's upstream strings plus the fork's. */
export function withHyyz17200Locale(language: string, resources: ResourceLanguage): ResourceLanguage {
  const own = HYYZ17200_LOCALES[language];
  return own ? { ...resources, hyyz17200: own } : resources;
}
