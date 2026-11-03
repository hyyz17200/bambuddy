import type { ResourceLanguage } from 'i18next';

/** The fork's text, under `hyyz17200.*`, kept out of upstream's locale files.
 *  Languages not listed fall back to English. */
const HYYZ17200_LOCALES: Record<string, ResourceLanguage> = {
  en: {
    inAppUpdateLocked: 'In-app updates are disabled on this fork. Build and install it manually.',
    printerIntake: {
      menuStop: 'Stop taking jobs',
      menuResume: 'Resume taking jobs',
      pill: 'Not taking jobs',
      pillTitle:
        'The queue sends this printer no new jobs. A running print finishes normally, and every control still works. Click to resume.',
      pipTitle: 'Not taking jobs',
      printButtonTitle: 'Not taking jobs. Click to resume.',
      toastStopped: '{{name}} stopped taking jobs. A running print finishes normally.',
      toastResumed: '{{name}} is taking jobs again.',
      saveFailed: 'Could not change whether {{name}} takes jobs.',
      dialogTitle: 'Not taking jobs',
      dialogPrint:
        '{{name}} is not taking jobs, so the queue sends it nothing: a print added now would only wait. Resume taking jobs and continue?',
      dialogResume: '{{name}} is not taking jobs. Resume, so the queue sends it jobs again?',
      dialogNoPermission:
        '{{name}} is not taking jobs. Someone who can edit printers has to resume it before the queue sends it anything.',
      confirmPrint: 'Resume and continue',
    },
    bulk: {
      chooseAction: 'Choose what to do. Printers already in that state are left alone.',
      applicable: '{{count}} printers',
      applyTo: '{{action}} ({{count}})',
      skippedAlready: '{{count}} other selected printers are already in that state and are left alone.',
      done: '{{action}}: done on {{count}} printers.',
      partial: '{{action}}: {{ok}} done, {{failed}} failed: {{names}}',
      move: {
        button: 'Move to Location',
        newLocation: 'New location…',
        newLocationName: 'Location name',
      },
      maintenance: {
        button: 'Maintenance',
        title: 'Maintenance: {{count}} selected printers',
        enterDescription: 'The printer disconnects and the queue skips it until it leaves maintenance.',
        exitDescription: 'The printer reconnects and takes queue jobs again.',
        enterPrinting:
          'Printing now: {{names}}. Bambuddy stops tracking these prints: no progress, no completion notice, no archive update.',
      },
      intake: {
        button: 'Taking Jobs',
        title: 'Taking jobs: {{count}} selected printers',
        stopDescription: 'The queue sends the printer no new jobs. It stays connected, and a running print finishes normally.',
        resumeDescription: 'The queue sends the printer jobs again.',
      },
      refresh: {
        title: 'Force refresh {{count}} printers?',
        message: 'Asks each printer to send its full status again.',
        skippedOffline: '{{count}} other selected printers are offline or in maintenance and are left out.',
      },
      csv: {
        button: 'Export CSV',
        exported: 'Exported {{count}} printers.',
        name: 'Name',
        wifi: 'WiFi',
        wifiDbm: 'WiFi signal (dBm)',
      },
      spool: {
        button: 'External Spool',
        configureAction: 'Configure external spool',
        resetAction: 'Reset external spool',
        bannerTitle: 'External spool on {{count}} printers ({{model}})',
        bannerTemplate:
          'Presets and K values are listed from {{name}}. Each printer gets its own K value of the same name, or the default.',
        chooseModelTitle: 'Configure which printers?',
        chooseModelMessage: 'Filament presets depend on the printer model, so the external spool is set for one model at a time.',
        modelOption: '{{model}}: {{count}} printers',
        next: 'Next',
        noneTitle: 'No selected printer can be configured',
        skipped: {
          offline: 'Offline or in maintenance, left out: {{names}}',
          dualNozzle: 'Two external spool holders, left out (configure them on the card): {{names}}',
          otherModel: 'Other models, left out: {{names}}',
        },
        confirmConfigureTitle: 'Apply to {{count}} printers?',
        confirmConfigureMessage:
          'Set the external spool to {{name}}, color {{color}}. Each printer uses its own K value of the same name, or the default when it has none.',
        confirmResetTitle: 'Reset the external spool on {{count}} printers?',
        confirmResetMessage: 'Clears the external spool settings on these printers.',
        resetPrintingSkipped: 'Printing, left out: {{names}}',
        apply: 'Apply',
        cancelled: 'Not applied.',
        allFailed: 'Failed on every printer.',
        kDefaulted: 'No K value of the same name on {{names}}; they use the default K.',
      },
    },
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
        'How many printer cards and camera wall tiles share a row on a wide screen. Upstream stops adding columns at 1280px wide (S cards 5 per row, M cards 3, camera wall S 5, M 4). With this on, from 1536px wide the page fits as many as it has room for, up to the limit below. L and XL are unchanged. Applies to every browser.',
      enabled: 'Fit more per row on wide screens',
      enabledHint: 'Off: the upstream layout at every width. Below 1536px wide the upstream layout always applies.',
      maxColumns: 'Most per row',
      minWidth: 'Narrowest (px)',
      minWidthHint:
        'Narrowest is the smallest a card or tile may get, in CSS pixels at 100% browser zoom. A row only reaches its limit when the page is wide enough.',
      grids: {
        printer_s: 'Printer cards, S',
        printer_m: 'Printer cards, M',
        camwall_s: 'Camera wall, S',
        camwall_m: 'Camera wall, M',
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
    printerIntake: {
      menuStop: '停止接单',
      menuResume: '恢复接单',
      pill: '停止接单',
      pillTitle: '队列不会再给这台打印机派发新任务。正在进行的打印会正常完成，其他操作都不受影响。点击可恢复接单。',
      pipTitle: '停止接单',
      printButtonTitle: '已停止接单，点击可恢复。',
      toastStopped: '{{name}} 已停止接单，正在进行的打印会正常完成。',
      toastResumed: '{{name}} 已恢复接单。',
      saveFailed: '无法更改 {{name}} 的接单状态。',
      dialogTitle: '已停止接单',
      dialogPrint: '{{name}} 已停止接单，队列不会给它派发任务，现在添加的打印只会一直等待。要恢复接单并继续吗？',
      dialogResume: '{{name}} 已停止接单。要恢复接单，让队列重新给它派发任务吗？',
      dialogNoPermission: '{{name}} 已停止接单。需要由有编辑打印机权限的人恢复接单，队列才会给它派发任务。',
      confirmPrint: '恢复接单并继续',
    },
    bulk: {
      chooseAction: '选择要执行的操作。已经处于该状态的打印机不会改动。',
      applicable: '{{count}} 台',
      applyTo: '{{action}}（{{count}} 台）',
      skippedAlready: '另外 {{count}} 台已选打印机已处于该状态，不会改动。',
      done: '{{action}}：已完成 {{count}} 台。',
      partial: '{{action}}：成功 {{ok}} 台，失败 {{failed}} 台：{{names}}',
      move: {
        button: '移动到位置',
        newLocation: '新位置…',
        newLocationName: '位置名称',
      },
      maintenance: {
        button: '维护操作',
        title: '维护操作：已选 {{count}} 台',
        enterDescription: '打印机断开连接，退出维护前队列不会给它派单。',
        exitDescription: '打印机重新连接，重新接收队列任务。',
        enterPrinting: '正在打印：{{names}}。进入维护后 Bambuddy 不再跟踪这些打印，不更新进度、不发完成通知、不更新归档。',
      },
      intake: {
        button: '接单开关',
        title: '接单开关：已选 {{count}} 台',
        stopDescription: '队列不再给打印机派发新任务。连接保持，正在进行的打印正常完成。',
        resumeDescription: '队列重新给打印机派发任务。',
      },
      refresh: {
        title: '强制刷新 {{count}} 台打印机？',
        message: '让每台打印机重新上报完整状态。',
        skippedOffline: '另外 {{count}} 台已选打印机离线或在维护中，会跳过。',
      },
      csv: {
        button: '导出 CSV',
        exported: '已导出 {{count}} 台打印机。',
        name: '名称',
        wifi: 'WiFi',
        wifiDbm: 'WiFi 信号（dBm）',
      },
      spool: {
        button: '外部料盘',
        configureAction: '配置外部料盘',
        resetAction: '重置外部料盘',
        bannerTitle: '批量配置外部料盘：{{count}} 台（{{model}}）',
        bannerTemplate: '预设和 K 值按 {{name}} 列出。每台打印机使用自己的同名 K 值，没有则用默认值。',
        chooseModelTitle: '配置哪些打印机？',
        chooseModelMessage: '耗材预设和打印机型号有关，一次只能配置一种型号的外部料盘。',
        modelOption: '{{model}}：{{count}} 台',
        next: '下一步',
        noneTitle: '所选打印机都不能配置',
        skipped: {
          offline: '离线或在维护中，跳过：{{names}}',
          dualNozzle: '有两个外部料盘，跳过（请在卡片上单独配置）：{{names}}',
          otherModel: '其他型号，跳过：{{names}}',
        },
        confirmConfigureTitle: '应用到 {{count}} 台打印机？',
        confirmConfigureMessage: '将外部料盘设为 {{name}}，颜色 {{color}}。每台打印机使用自己的同名 K 值，没有则用默认值。',
        confirmResetTitle: '重置 {{count}} 台打印机的外部料盘？',
        confirmResetMessage: '清除这些打印机的外部料盘设置。',
        resetPrintingSkipped: '正在打印，跳过：{{names}}',
        apply: '应用',
        cancelled: '未应用。',
        allFailed: '所有打印机都失败了。',
        kDefaulted: '{{names}} 没有同名 K 值，已使用默认 K 值。',
      },
    },
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
        '宽屏上每行显示多少张打印机卡片和摄像头墙画面。原版在窗口宽 1280px 以后就不再增加列数（S 卡每行 5 台，M 卡 3 台，摄像头墙 S 5 个、M 4 个）。开启后，窗口宽度达到 1536px 时按页面实际宽度能放几台就放几台，不超过下面的上限。L 和 XL 不变。对所有浏览器生效。',
      enabled: '宽屏时每行放更多',
      enabledHint: '关闭后在任何宽度下都使用原版布局。窗口宽度不到 1536px 时始终使用原版布局。',
      maxColumns: '每行最多',
      minWidth: '最小宽度（px）',
      minWidthHint: '最小宽度是单张卡片或画面最窄能到多少，按浏览器 100% 缩放下的 CSS 像素计。页面足够宽时，一行才会排满上限。',
      grids: {
        printer_s: '打印机卡片 S',
        printer_m: '打印机卡片 M',
        camwall_s: '摄像头墙 S',
        camwall_m: '摄像头墙 M',
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
