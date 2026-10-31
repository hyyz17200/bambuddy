import type { ResourceLanguage } from 'i18next';

/** The fork's text, under `hyyz17200.*`, kept out of upstream's locale files.
 *  Languages not listed fall back to English. */
const HYYZ17200_LOCALES: Record<string, ResourceLanguage> = {
  en: {
    inAppUpdateLocked: 'In-app updates are disabled on this fork. Build and install it manually.',
    camWall: {
      frameAge: '{{time}} ago',
      maxLiveZero: '0 keeps every tile on snapshots.',
    },
    hiddenFaults: {
      nav: 'Hidden Faults',
      title: 'Hidden Faults',
      description:
        'These codes stop lighting up printer badges and the camera wall, and stop sending notifications. They stay listed, collapsed, in the HMS window, and printing and failure reports are not affected.',
      code: 'Fault code',
      note: 'Note (optional)',
      add: 'Hide code',
      addBmcu: 'Add BMCU firmware mismatch codes',
      remove: 'Stop hiding {{code}}',
      empty: 'No codes are hidden.',
      invalidCode: 'A fault code has 8 or 16 hexadecimal digits.',
      printErrorWarning:
        'An 8-digit code is a print error, which can be a real failed or refused print. You would no longer be alerted about it.',
      saveFailed: 'Could not save the change.',
    },
  },
  'zh-CN': {
    inAppUpdateLocked: '此 fork 已禁用应用内更新，请手动构建安装。',
    camWall: {
      frameAge: '{{time}}前',
      maxLiveZero: '设为 0 时所有单元都使用快照。',
    },
    hiddenFaults: {
      nav: '隐藏故障',
      title: '隐藏故障',
      description:
        '这些故障码不再点亮打印机角标和摄像头墙，也不再发送通知。它们仍折叠显示在 HMS 窗口中，打印流程和失败记录不受影响。',
      code: '故障码',
      note: '备注（可选）',
      add: '隐藏此故障码',
      addBmcu: '添加 BMCU 固件不匹配故障码',
      remove: '取消隐藏 {{code}}',
      empty: '没有隐藏任何故障码。',
      invalidCode: '故障码应为 8 位或 16 位十六进制数字。',
      printErrorWarning: '8 位故障码是打印错误，可能代表打印确实失败或被拒绝。隐藏后你将不再收到相关提醒。',
      saveFailed: '保存失败。',
    },
  },
};

/** A language's upstream strings plus the fork's. */
export function withHyyz17200Locale(language: string, resources: ResourceLanguage): ResourceLanguage {
  const own = HYYZ17200_LOCALES[language];
  return own ? { ...resources, hyyz17200: own } : resources;
}
