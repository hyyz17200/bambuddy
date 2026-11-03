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
    enhancedSettings: {
      nav: 'Enhanced Settings',
      title: 'Enhanced Settings',
      description: "Settings for this fork's own features. They apply to everyone using this instance.",
    },
    wideGrid: {
      title: 'Wide Screen Grid',
      description:
        'How many printer cards and camera wall tiles share a row on a wide screen. Upstream stops adding columns at 1280px wide (S cards 5 per row, M cards 3, camera wall S 5, M 4). With this on, from 1536px wide the page fits as many as it has room for, up to the limit below. L and XL start at the upstream 2 and 1 per row; raise their limit to fit more. Applies to every browser.',
      enabled: 'Fit more per row on wide screens',
      enabledHint: 'Off: the upstream layout at every width. Below 1536px wide the upstream layout always applies.',
      maxColumns: 'Most per row',
      minWidth: 'Narrowest (px)',
      minWidthHint:
        'Narrowest is the smallest a card or tile may get, in CSS pixels at 100% browser zoom. A row only reaches its limit when the page is wide enough.',
      grids: {
        printer_s: 'Printer cards, S',
        printer_m: 'Printer cards, M',
        printer_l: 'Printer cards, L',
        printer_xl: 'Printer cards, XL',
        camwall_s: 'Camera wall, S',
        camwall_m: 'Camera wall, M',
        camwall_l: 'Camera wall, L',
        camwall_xl: 'Camera wall, XL',
      },
      save: 'Save',
      reset: 'Restore defaults',
      saved: 'Saved.',
      saveFailed: 'Could not save the change.',
    },
    hiddenFaults: {
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
    enhancedSettings: {
      nav: '增强设置',
      title: '增强设置',
      description: '此 fork 自有功能的设置，对使用此实例的所有人生效。',
    },
    wideGrid: {
      title: '宽屏布局',
      description:
        '宽屏上每行显示多少张打印机卡片和摄像头墙画面。原版在窗口宽 1280px 以后就不再增加列数（S 卡每行 5 台，M 卡 3 台，摄像头墙 S 5 个、M 4 个）。开启后，窗口宽度达到 1536px 时按页面实际宽度能放几台就放几台，不超过下面的上限。L 和 XL 默认和原版一样每行 2 个、1 个，调高上限才会多放。对所有浏览器生效。',
      enabled: '宽屏时每行放更多',
      enabledHint: '关闭后在任何宽度下都使用原版布局。窗口宽度不到 1536px 时始终使用原版布局。',
      maxColumns: '每行最多',
      minWidth: '最小宽度（px）',
      minWidthHint: '最小宽度是单张卡片或画面最窄能到多少，按浏览器 100% 缩放下的 CSS 像素计。页面足够宽时，一行才会排满上限。',
      grids: {
        printer_s: '打印机卡片 S',
        printer_m: '打印机卡片 M',
        printer_l: '打印机卡片 L',
        printer_xl: '打印机卡片 XL',
        camwall_s: '摄像头墙 S',
        camwall_m: '摄像头墙 M',
        camwall_l: '摄像头墙 L',
        camwall_xl: '摄像头墙 XL',
      },
      save: '保存',
      reset: '恢复默认',
      saved: '已保存。',
      saveFailed: '保存失败。',
    },
    hiddenFaults: {
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
