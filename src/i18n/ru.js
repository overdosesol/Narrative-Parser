/**
 * Russian translations
 */
import { LIFESPAN_VALUES, assertCoversLifespans } from '../analysis/lifespan.js';

const ru = {
  // ── Bot welcome & commands ─────────────────────────────────────────────
  welcome: `<b>Catalyst</b> - \u0441\u043a\u0430\u043d\u0435\u0440 \u043d\u0430\u0440\u0440\u0430\u0442\u0438\u0432\u043e\u0432

\u0421\u043b\u0435\u0434\u0438\u043c \u0437\u0430 <b>Twitter</b>, <b>TikTok</b>, <b>Reddit</b> \u0438 <b>Google Trends</b> \u0432 \u0440\u0435\u0430\u043b\u044c\u043d\u043e\u043c \u0432\u0440\u0435\u043c\u0435\u043d\u0438 \u0438 \u043f\u0438\u043d\u0433\u0443\u0435\u043c, \u043a\u043e\u0433\u0434\u0430 \u0438\u0441\u0442\u043e\u0440\u0438\u044f \u0442\u043e\u043b\u044c\u043a\u043e \u043d\u0430\u0447\u0438\u043d\u0430\u0435\u0442 \u0440\u0430\u0437\u0433\u043e\u043d\u044f\u0442\u044c\u0441\u044f - \u0434\u043e \u0442\u043e\u0433\u043e, \u043a\u0430\u043a \u043e\u043d\u0430 \u0432\u0435\u0437\u0434\u0435.

<b>\u0412 \u043a\u0430\u0436\u0434\u043e\u043c \u0430\u043b\u0435\u0440\u0442\u0435:</b>
\u{1F3AF}  \u041d\u0430\u0441\u043a\u043e\u043b\u044c\u043a\u043e \u043a\u0440\u0443\u043f\u043d\u043e (\u0441\u043a\u043e\u0440 0-100)
\u{26A1}  \u0421 \u0447\u0435\u0433\u043e \u043d\u0430\u0447\u0430\u043b\u043e\u0441\u044c
\u{1F4D6}  \u041f\u043e\u0447\u0435\u043c\u0443 \u0440\u0430\u0441\u0445\u043e\u0434\u0438\u0442\u0441\u044f
\u{1F4CA}  \u0416\u0438\u0432\u044b\u0435 \u043c\u0435\u0442\u0440\u0438\u043a\u0438 (\u043f\u0440\u043e\u0441\u043c\u043e\u0442\u0440\u044b \u00b7 \u043b\u0430\u0439\u043a\u0438 \u00b7 \u0440\u0435\u043f\u043e\u0441\u0442\u044b)

\u041e\u0442\u043a\u0440\u043e\u0439 \u043c\u0435\u043d\u044e \u043d\u0438\u0436\u0435 - \u0432\u044b\u0431\u0435\u0440\u0438 \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0438, \u043d\u0430\u0441\u0442\u0440\u043e\u0439 \u0433\u0440\u043e\u043c\u043a\u043e\u0441\u0442\u044c \u0430\u043b\u0435\u0440\u0442\u043e\u0432 \u0438 \u043f\u043e\u0434\u0431\u0435\u0440\u0438 \u043f\u043b\u0430\u043d.

<a href="https://x.com/Catalystparser">\u{1D54F} \u041f\u043e\u0434\u043f\u0438\u0441\u0430\u0442\u044c\u0441\u044f</a>`,

  welcomeBack: (plan) => `<b>Catalyst</b> \u00b7 \u043f\u043b\u0430\u043d: <b>${plan}</b>\n\n/menu - \u043d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438\n/top - \u0442\u043e\u043f \u043d\u0430\u0440\u0440\u0430\u0442\u0438\u0432\u043e\u0432 \u0441\u0435\u0439\u0447\u0430\u0441`,

  // ── Main menu ──────────────────────────────────────────────────────────
  // menuTitle — функция для live-статус строки в шапке.
  menuTitle: (info = {}) => {
    const dot      = info.paused ? '\u{1F7E0}' : '\u{1F7E2}';
    const status   = info.paused ? 'На паузе' : 'Активно';
    const planMap  = { free: 'Free', test: 'Test', pro: 'Pro', admin: 'Admin' };
    const planCap  = planMap[info.plan] || 'Free';
    const daysPart = (info.daysLeft != null) ? ` · ${info.daysLeft}д` : '';
    return `\u{2699}\u{FE0F} <b>Настройки</b>\n${dot} ${status} · ${planCap}${daysPart}`;
  },
  btnSources: '\u{1F4E1} \u{0418}\u{0441}\u{0442}\u{043E}\u{0447}\u{043D}\u{0438}\u{043A}\u{0438}',
  btnLanguage: '\u{1F310} \u{042F}\u{0437}\u{044B}\u{043A}',
  btnThreshold: '\u{1F39A}\u{FE0F} Порог',
  btnSubscription: '\u{1F48E} План',
  // 🔔 Типы алертов
  btnAlertTypes: '\u{1F514} \u{0422}\u{0438}\u{043F}\u{044B} \u{0430}\u{043B}\u{0435}\u{0440}\u{0442}\u{043E}\u{0432}',
  btnTop: '\u{1F525} \u{0422}\u{043E}\u{043F} \u{0442}\u{0440}\u{0435}\u{043D}\u{0434}\u{043E}\u{0432}',
  btnStartStop: (paused) => paused ? '\u{25B6}\u{FE0F} \u{0412}\u{043E}\u{0437}\u{043E}\u{0431}\u{043D}\u{043E}\u{0432}\u{0438}\u{0442}\u{044C}' : '\u{23F8}\u{FE0F} \u{041F}\u{0430}\u{0443}\u{0437}\u{0430}',
  btnFollowX: '\u{1D54F} \u{041D}\u{0430}\u{0448} X: @Catalystparser',
  btnAskQuestion: '\u{1F4AC} \u{0417}\u{0430}\u{0434}\u{0430}\u{0442}\u{044C} \u{0432}\u{043E}\u{043F}\u{0440}\u{043E}\u{0441}',
  btnDashboard: '\u{1F4CA} Открыть дашборд',
  dashboardPrompt: (url) => `\u{1F310} <b>Веб-дашборд</b>\n\nПолный фид нарративов, фильтры по фазе / типу / источнику, ручной анализ ссылок (Pro). Вход через ваш Telegram-аккаунт.\n\n<a href="${url}">${url}</a>`,
  btnOpenMenu: '\u{2699}\u{FE0F} \u{041E}\u{0442}\u{043A}\u{0440}\u{044B}\u{0442}\u{044C} \u{043C}\u{0435}\u{043D}\u{044E}',
  btnBack: '\u{25C0}\u{FE0F} \u{041D}\u{0430}\u{0437}\u{0430}\u{0434}',
  btnClose: '\u{274C} Закрыть',
  // Бэйджи текущих значений на кнопках главного меню
  badgeSources:    (enabled, total) => ` · ${enabled}/${total}`,
  badgeThreshold:  (val)            => ` · ${val}`,
  badgeLanguage:   (code)           => ` · ${code.toUpperCase()}`,
  // Всегда показываем N/total — понятнее чем «все».
  badgeAlertTypes: (count, total)   => ` · ${count === 0 ? total : count}/${total}`,
  // Бэйдж плана: « · Pro · 12д» для платных, « · Free» для бесплатного.
  badgePlan:       (plan, daysLeft) => {
    const planMap = { free: 'Free', test: 'Test', pro: 'Pro', admin: 'Admin' };
    const cap = planMap[plan] || 'Free';
    return (daysLeft != null) ? ` · ${cap} · ${daysLeft}д` : ` · ${cap}`;
  },
  // Маркер «открывает подменю» (на кнопке Топ трендов).
  badgeSubmenu:    () => ' ▸',

  // ── Sources ────────────────────────────────────────────────────────────
  sourcesTitle: '\u{1F4E1} <b>Источники данных</b>\n\nНажмите на платформу, чтобы включить или отключить её алерты.',
  sourceToggled: (name, enabled) => `${enabled ? '\u{2705}' : '\u{274C}'} <b>${name}</b> ${enabled ? '\u{0432}\u{043A}\u{043B}\u{044E}\u{0447}\u{0435}\u{043D}' : '\u{0432}\u{044B}\u{043A}\u{043B}\u{044E}\u{0447}\u{0435}\u{043D}'}`,
  sourceNames: {
    reddit: 'Reddit',
    google_trends: 'Google Trends',
    twitter: 'Twitter/X',
    tiktok: 'TikTok',
    x_trends: 'X Trends',
  },

  // ── Типы алертов ───────────────────────────────────────────────────────
  // \u{1F514} <b>Типы алертов</b>
  // Выберите, какие типы алертов получать.
  // 📰 Событие - конкретный триггер (кто-то что-то сделал/сказал)
  // 📈 Тренд - нарратив набирает обороты на разных платформах
  // 🚀 Пост - один вирусный пост
  // ✅ = вкл, ❌ = выкл. Если выключить все - будут приходить все.
  alertTypesTitle: '\u{1F514} <b>Типы алертов</b>\n\nВыберите, какие алерты вы хотите получать:\n\n\u{1F4F0} <b>Событие</b> - конкретный триггер (кто-то что-то сделал/сказал)\n\u{1F4C8} <b>Тренд</b> - нарратив набирает обороты в нескольких постах\n\u{1F680} <b>Пост</b> - один вирусный пост\n\n<i>Подсказка: если выключить все три - приходят все. Молчания не будет.</i>',
  alertTypeNameEvent: '\u{0421}\u{043E}\u{0431}\u{044B}\u{0442}\u{0438}\u{0435}',
  alertTypeNameTrend: '\u{0422}\u{0440}\u{0435}\u{043D}\u{0434}',
  alertTypeNamePost:  '\u{041F}\u{043E}\u{0441}\u{0442}',
  alertTypeToggled: (name, enabled) => `${enabled ? '\u{2705}' : '\u{274C}'} <b>${name}</b> \u{0430}\u{043B}\u{0435}\u{0440}\u{0442}\u{044B} ${enabled ? '\u{0432}\u{043A}\u{043B}\u{044E}\u{0447}\u{0435}\u{043D}\u{044B}' : '\u{0432}\u{044B}\u{043A}\u{043B}\u{044E}\u{0447}\u{0435}\u{043D}\u{044B}'}`,

  // ── Language ───────────────────────────────────────────────────────────
  languageTitle: '\u{1F310} <b>\u{042F}\u{0437}\u{044B}\u{043A}</b>\n\n\u{0412}\u{044B}\u{0431}\u{0435}\u{0440}\u{0438}\u{0442}\u{0435} \u{044F}\u{0437}\u{044B}\u{043A} \u{0430}\u{043B}\u{0435}\u{0440}\u{0442}\u{043E}\u{0432} \u{0438} \u{0438}\u{043D}\u{0442}\u{0435}\u{0440}\u{0444}\u{0435}\u{0439}\u{0441}\u{0430}:',
  languageSet: (lang) => `\u{2705} \u{042F}\u{0437}\u{044B}\u{043A} \u{0443}\u{0441}\u{0442}\u{0430}\u{043D}\u{043E}\u{0432}\u{043B}\u{0435}\u{043D}: <b>${lang === 'en' ? 'English' : '\u{0420}\u{0443}\u{0441}\u{0441}\u{043A}\u{0438}\u{0439}'}</b>`,

  // ── Threshold ──────────────────────────────────────────────────────────
  thresholdTitle: (current) => `\u{1F3AF} <b>\u041F\u043E\u0440\u043E\u0433 \u0430\u043B\u0435\u0440\u0442\u043E\u0432</b>\n\n\u0421\u0435\u0439\u0447\u0430\u0441: <b>${current}/100</b>\n\n\u0423\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0435 \u043F\u0440\u0438\u0434\u0451\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u0435\u0441\u043B\u0438 \u0442\u0440\u0435\u043D\u0434 \u043D\u0430\u0431\u0438\u0440\u0430\u0435\u0442 \u0432\u044B\u0448\u0435 \u044D\u0442\u043E\u0433\u043E \u0447\u0438\u0441\u043B\u0430.\n<i>\u041D\u0438\u0436\u0435 \u2192 \u0431\u043E\u043B\u044C\u0448\u0435 \u0430\u043B\u0435\u0440\u0442\u043E\u0432.  \u0412\u044B\u0448\u0435 \u2192 \u043C\u0435\u043D\u044C\u0448\u0435, \u0442\u043E\u043B\u044C\u043A\u043E \u0441\u0430\u043C\u044B\u0435 \u0433\u0440\u043E\u043C\u043A\u0438\u0435.</i>\n\n\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043F\u0440\u0435\u0441\u0435\u0442 \u0438\u043B\u0438 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \u00AB\u0421\u0432\u043E\u0451 \u0447\u0438\u0441\u043B\u043E\u00BB:`,
  thresholdSet: (val) => `\u{2705} \u041F\u043E\u0440\u043E\u0433 \u0443\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D: <b>${val}/100</b>`,
  thresholdLow:    '\u{1F7E2} \u041D\u0438\u0437\u043A\u0438\u0439 (52+) \u00B7 \u0431\u043E\u043B\u044C\u0448\u0435 \u0430\u043B\u0435\u0440\u0442\u043E\u0432',
  thresholdMedium: '\u{1F7E1} \u0421\u0440\u0435\u0434\u043D\u0438\u0439 (67+) \u00B7 \u0431\u0430\u043B\u0430\u043D\u0441',
  thresholdHigh:   '\u{1F534} \u0412\u044B\u0441\u043E\u043A\u0438\u0439 (75+) \u00B7 \u0442\u043E\u043B\u044C\u043A\u043E \u0433\u0440\u043E\u043C\u043A\u0438\u0435',
  thresholdCustomBtn: '\u270F\uFE0F \u0421\u0432\u043E\u0451 \u0447\u0438\u0441\u043B\u043E',
  // \u041C\u0430\u0440\u043A\u0435\u0440, \u043E\u0442\u043C\u0435\u0447\u0430\u044E\u0449\u0438\u0439 \u0430\u043A\u0442\u0438\u0432\u043D\u044B\u0439 \u043F\u0440\u0435\u0441\u0435\u0442 \u0432 \u043A\u043B\u0430\u0432\u0438\u0430\u0442\u0443\u0440\u0435 \u043F\u043E\u0440\u043E\u0433\u0430
  thresholdActiveMark: '\u25B8 ',
  thresholdCustomPrompt: '\u270F\uFE0F <b>\u{0421}\u{0432}\u{043E}\u{0439} \u{043F}\u{043E}\u{0440}\u{043E}\u{0433}</b>\n\n\u{041D}\u{0430}\u{043F}\u{0438}\u{0448}\u{0438}\u{0442}\u{0435} \u{0446}\u{0435}\u{043B}\u{043E}\u{0435} \u{0447}\u{0438}\u{0441}\u{043B}\u{043E} \u{043E}\u{0442} 1 \u{0434}\u{043E} 100:',
  thresholdCustomInvalid: '\u274C \u041D\u0435\u0432\u0435\u0440\u043D\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435. \u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u0446\u0435\u043B\u043E\u0435 \u0447\u0438\u0441\u043B\u043E \u043E\u0442 1 \u0434\u043E 100.',

  // ── Subscription ───────────────────────────────────────────────────────
  subscriptionTitle: (plan, status, expires) => {
    let msg = `\u{1F4B3} <b>\u{041F}\u{043E}\u{0434}\u{043F}\u{0438}\u{0441}\u{043A}\u{0430}</b>\n\n\u{041F}\u{043B}\u{0430}\u{043D}: <b>${plan}</b>\n\u{0421}\u{0442}\u{0430}\u{0442}\u{0443}\u{0441}: <b>${status}</b>`;
    if (expires) msg += `\n\u{0418}\u{0441}\u{0442}\u{0435}\u{043A}\u{0430}\u{0435}\u{0442}: <b>${expires}</b>`;
    return msg;
  },
  btnUpgrade: '\u{2B06}\u{FE0F} \u{0423}\u{043B}\u{0443}\u{0447}\u{0448}\u{0438}\u{0442}\u{044C}',
  btnManageSub: '\u{1F527} \u{0423}\u{043F}\u{0440}\u{0430}\u{0432}\u{043B}\u{0435}\u{043D}\u{0438}\u{0435}',
  planFree: '\u{0411}\u{0435}\u{0441}\u{043F}\u{043B}\u{0430}\u{0442}\u{043D}\u{044B}\u{0439}',
  planTest: 'Test Plan ($5 / 1 \u{0434}\u{0435}\u{043D}\u{044C}, \u{043E}\u{0434}\u{0438}\u{043D} \u{0440}\u{0430}\u{0437})',
  planPro: 'Pro ($100 / 30 \u{0434}\u{043D}\u{0435}\u{0439})',

  // ── Payment ────────────────────────────────────────────────────────────
  paymentTitle: '💰 <b>Выберите план:</b>\n\n🆓 <b>Free</b>\n• Источники: Reddit, Google Trends\n• Безлимит алертов\n• Ручной анализ: 🔒 недоступен\n• Каталист: 🔒 недоступен\n\n🧪 <b>Test - $5 / 1 день (один раз)</b>\n• Источники: Twitter(X), TikTok, Reddit, X Trends, Google Trends\n• Безлимит алертов\n• Ручной анализ: 5/день\n• Каталист: 5/день\n\n🚀 <b>Pro - $100 / 30 дней</b>\n• Источники: Twitter(X), TikTok, Reddit, X Trends, Google Trends\n• Безлимит алертов\n• Ручной анализ: Безлимит\n• Каталист: Безлимит',
  paymentMethod: '\u{1F4B0} <b>\u{041E}\u{043F}\u{043B}\u{0430}\u{0442}\u{0430}</b>\n\n\u{0412}\u{044B}\u{0431}\u{0435}\u{0440}\u{0438}\u{0442}\u{0435} \u{0441}\u{043F}\u{043E}\u{0441}\u{043E}\u{0431} \u{043E}\u{043F}\u{043B}\u{0430}\u{0442}\u{044B}:',
  btnPaySOL:  '\u{26A1} Оплатить через SOL',
  btnPayUSDC: '\u{1F4B5} Оплатить через USDC',
  paymentInstructions: (amount, currency, address, reference) =>
    `\u{1F4B0} <b>Оплата ${amount} ${currency}</b>\n\n` +
    `\u{1F4F2} <b>Просто</b>\n` +
    `Отсканируйте QR ниже в своём SOL-кошельке - сумма и адрес подставятся сами.\n\n` +
    `✍️ <b>Вручную</b>\n` +
    `Отправьте ровно:\n<code>${amount} ${currency}</code>\n\n` +
    `На SOL-адрес:\n<code>${address}</code>\n\n` +
    `⏱ Подтвердится автоматически в течение 1-5 минут после транзакции.`,
  btnOpenWallet: '\u{1F4F1} \u{041E}\u{0442}\u{043A}\u{0440}\u{044B}\u{0442}\u{044C} \u{0432} \u{043A}\u{043E}\u{0448}\u{0435}\u{043B}\u{044C}\u{043A}\u{0435}',
  paymentConfirmed: (plan) => `\u{2705} <b>\u{041E}\u{043F}\u{043B}\u{0430}\u{0442}\u{0430} \u{043F}\u{043E}\u{0434}\u{0442}\u{0432}\u{0435}\u{0440}\u{0436}\u{0434}\u{0435}\u{043D}\u{0430}!</b>\n\n\u{0412}\u{0430}\u{0448} \u{043F}\u{043B}\u{0430}\u{043D} \u{043E}\u{0431}\u{043D}\u{043E}\u{0432}\u{043B}\u{0451}\u{043D} \u{0434}\u{043E} <b>${plan}</b>.\n\u{041D}\u{0430}\u{0441}\u{043B}\u{0430}\u{0436}\u{0434}\u{0430}\u{0439}\u{0442}\u{0435}\u{0441}\u{044C} \u{043F}\u{0440}\u{0435}\u{043C}\u{0438}\u{0443}\u{043C}-\u{0444}\u{0443}\u{043D}\u{043A}\u{0446}\u{0438}\u{044F}\u{043C}\u{0438}!`,
  paymentExpired: '\u{274C} \u{0421}\u{0435}\u{0441}\u{0441}\u{0438}\u{044F} \u{043E}\u{043F}\u{043B}\u{0430}\u{0442}\u{044B} \u{0438}\u{0441}\u{0442}\u{0435}\u{043A}\u{043B}\u{0430}. \u{041F}\u{043E}\u{043F}\u{0440}\u{043E}\u{0431}\u{0443}\u{0439}\u{0442}\u{0435} \u{0441}\u{043D}\u{043E}\u{0432}\u{0430}.',
  paymentPending: '\u{23F3} \u{041E}\u{0436}\u{0438}\u{0434}\u{0430}\u{043D}\u{0438}\u{0435} \u{043F}\u{043E}\u{0434}\u{0442}\u{0432}\u{0435}\u{0440}\u{0436}\u{0434}\u{0435}\u{043D}\u{0438}\u{044F} \u{043E}\u{043F}\u{043B}\u{0430}\u{0442}\u{044B}...',

  // ── Alerts ─────────────────────────────────────────────────────────────
  alertHeader: (score) => `${scoreEmoji(score)} <b>${score}/100</b> \u00B7 \u{0422}\u{0420}\u{0415}\u{041D}\u{0414} \u{0410}\u{041B}\u{0415}\u{0420}\u{0422}`,
  alertTrigger: '\u{041F}\u{043E}\u{0432}\u{043E}\u{0434}',
  // СОБЫТИЕ / ТРЕНД / ПОСТ - отрисовывается чипом в первой строке алерта.
  alertTypeEvent: '\u{0421}\u{041E}\u{0411}\u{042B}\u{0422}\u{0418}\u{0415}',
  alertTypeTrend: '\u{0422}\u{0420}\u{0415}\u{041D}\u{0414}',
  alertTypePost:  '\u{041F}\u{041E}\u{0421}\u{0422}',
  alertAI: '\u{0418}\u{0418}',
  alertCategory: '\u{041A}\u{0430}\u{0442}\u{0435}\u{0433}\u{043E}\u{0440}\u{0438}\u{044F}',
  alertViralityScore: '\u{041E}\u{0445}\u{0432}\u{0430}\u{0442}',
  alertSentiment: '\u{041D}\u{0430}\u{0441}\u{0442}\u{0440}\u{043E}\u{0435}\u{043D}\u{0438}\u{0435}',
  alertForecast: '\u{041F}\u{0440}\u{043E}\u{0433}\u{043D}\u{043E}\u{0437}',
  alertSources: '\u{0418}\u{0441}\u{0442}\u{043E}\u{0447}\u{043D}\u{0438}\u{043A}\u{0438}',
  alertUpvotes:    (count, velocity) => `\u{1F4C8} <b>${count}</b> \u{0430}\u{043F}\u{0432}\u{043E}\u{0439}\u{0442}\u{043E}\u{0432} (\u2191${velocity}/\u{0447}\u{0430}\u{0441})`,
  alertLikes:      (count, velocity) => `\u{2764}\u{FE0F} <b>${count}</b> \u{043B}\u{0430}\u{0439}\u{043A}\u{043E}\u{0432} (\u2191${velocity}/\u{0447}\u{0430}\u{0441})`,
  alertPlays:      (count, velocity) => `\u{25B6}\u{FE0F} <b>${count}</b> \u{043F}\u{0440}\u{043E}\u{0441}\u{043C}\u{043E}\u{0442}\u{0440}\u{043E}\u{0432} (\u2191${velocity}/\u{0447}\u{0430}\u{0441})`,
  alertGoogleHits: (count)           => `\u{1F4CA} \u{0418}\u{043D}\u{0442}\u{0435}\u{0440}\u{0435}\u{0441} \u{043F}\u{043E}\u{0438}\u{0441}\u{043A}\u{0430}: <b>${count}</b>`,
  alertComments: (count) => `\u{1F4AC} <b>${count}</b> \u{043A}\u{043E}\u{043C}\u{043C}\u{0435}\u{043D}\u{0442}\u{0430}\u{0440}\u{0438}\u{0435}\u{0432}`,
  alertGoogleTraffic: (traffic) => `\u{1F4CA} Google \u{0442}\u{0440}\u{0430}\u{0444}\u{0438}\u{043A}: <b>${traffic}</b>`,
  alertTwitterHeader: (hours) => `\u{1F426} <b>Twitter \u00B7 ${hours}\u{0447}</b>`,
  alertOpen: '\u{041E}\u{0442}\u{043A}\u{0440}\u{044B}\u{0442}\u{044C} \u{0441}\u{0441}\u{044B}\u{043B}\u{043A}\u{0443}',

  // ── Top command ────────────────────────────────────────────────────────
  topSelectorTitle: '\uD83D\uDD25 <b>\u0422\u043E\u043F \u043D\u0430\u0440\u0440\u0430\u0442\u0438\u0432\u043E\u0432 \u00B7 24 \u0447\u0430\u0441\u0430</b>\n\n\u0421\u043A\u043E\u043B\u044C\u043A\u043E \u0442\u0440\u0435\u043D\u0434\u043E\u0432 \u043F\u043E\u043A\u0430\u0437\u0430\u0442\u044C?',
  topBtnCount: (n) => '\u{1F4CA} \u{0422}\u{041E}\u{041F}-' + n,
  topTitle: (n) => '\u{1F525} <b>\u{0422}\u{041E}\u{041F}-' + n + ' \u{041D}\u{0410}\u{0420}\u{0420}\u{0410}\u{0422}\u{0418}\u{0412}\u{041E}\u{0412} \u00B7 24\u{0427}</b>',
  topEmpty: '\u{1F937} \u{0417}\u{0430} \u{043F}\u{043E}\u{0441}\u{043B}\u{0435}\u{0434}\u{043D}\u{0438}\u{0435} 24 \u{0447}\u{0430}\u{0441}\u{0430} \u{043D}\u{0435}\u{0442} \u{0434}\u{0435}\u{0433}\u{0435}\u{043D}\u{0435}\u{0440}\u{0430}\u{0442}\u{0438}\u{0432}\u{043D}\u{044B}\u{0445} \u{0442}\u{0440}\u{0435}\u{043D}\u{0434}\u{043E}\u{0432}.',
  topSource: '\u041E\u0442\u043A\u0440\u044B\u0442\u044C',
  topTgPost: 'TG',
  topCatIcons: {
    meme: '\u{1F923}', celebrity: '\u{2B50}', animals: '\u{1F43E}',
    tech: '\u{1F4BB}', gambling: '\u{1F3B0}', sports: '\u{1F3C6}',
    politics: '\u{1F3DB}\u{FE0F}', entertainment: '\u{1F3AC}', gaming: '\u{1F3AE}',
    boring: '\u{1F634}', other: '\u{1F4CC}',
  },
  topLifeIcons: {
    // Keys derive from LIFESPAN_VALUES - see src/analysis/lifespan.js.
    // Legacy descriptive forms normalized away upstream.
    flash: '\u26A1', short: '\u{1F552}', medium: '\u{1F4C5}', long: '\u{1F4C6}',
  },

  // ── Status ─────────────────────────────────────────────────────────────
  paused: '\u{23F8}\u{FE0F} <b>\u{0410}\u{043B}\u{0435}\u{0440}\u{0442}\u{044B} \u{043D}\u{0430} \u{043F}\u{0430}\u{0443}\u{0437}\u{0435}.</b>\n\u{041D}\u{0430}\u{0436}\u{043C}\u{0438}\u{0442}\u{0435} /menu \u{0434}\u{043B}\u{044F} \u{0432}\u{043E}\u{0437}\u{043E}\u{0431}\u{043D}\u{043E}\u{0432}\u{043B}\u{0435}\u{043D}\u{0438}\u{044F}.',
  resumed: '\u{25B6}\u{FE0F} <b>\u{0410}\u{043B}\u{0435}\u{0440}\u{0442}\u{044B} \u{0432}\u{043E}\u{0437}\u{043E}\u{0431}\u{043D}\u{043E}\u{0432}\u{043B}\u{0435}\u{043D}\u{044B}!</b>\n\u{0412}\u{044B} \u{0431}\u{0443}\u{0434}\u{0435}\u{0442}\u{0435} \u{043F}\u{043E}\u{043B}\u{0443}\u{0447}\u{0430}\u{0442}\u{044C} \u{0443}\u{0432}\u{0435}\u{0434}\u{043E}\u{043C}\u{043B}\u{0435}\u{043D}\u{0438}\u{044F} \u{043E} \u{0442}\u{0440}\u{0435}\u{043D}\u{0434}\u{0430}\u{0445}.',

  // ── X Analysis ─────────────────────────────────────────────────────────
  xAnalysisBtn: '\u{1F426} X \u{0410}\u{043D}\u{0430}\u{043B}\u{0438}\u{0437}',
  btnAskGrok:   '\u{1F9E0} \u{0421}\u{043F}\u{0440}\u{043E}\u{0441}\u{0438}\u{0442}\u{044C} Grok',
  xAnalysisLockedBtn: '\u{1F512} X \u{0410}\u{043D}\u{0430}\u{043B}\u{0438}\u{0437} (\u{0437}\u{0430}\u{043A}\u{0440}\u{044B}\u{0442})',
  xAnalysisLocked: '🔒 X Analysis доступен на Test/Pro. Обновись в /menu → План.',
  xAnalysisLimitReached: (cap) => `⛔ Дневной лимит X Analysis исчерпан (${cap}/24ч). Обнови до Pro для безлимита.`,
  xAnalysisLoading: '\u{23F3} \u{0417}\u{0430}\u{0433}\u{0440}\u{0443}\u{0437}\u{043A}\u{0430}...',
  xAnalysisTitle: '\u{1F426} <b>X / Twitter \u{0410}\u{043D}\u{0430}\u{043B}\u{0438}\u{0437}</b>',
  xAnalysisQuery: '\u{0417}\u{0430}\u{043F}\u{0440}\u{043E}\u{0441}',
  xAnalysisVirality: '\u{0412}\u{0438}\u{0440}\u{0430}\u{043B}\u{044C}\u{043D}\u{043E}\u{0441}\u{0442}\u{044C}',
  xAnalysisTweets: '\u{0422}\u{0432}\u{0438}\u{0442}\u{043E}\u{0432} \u{043D}\u{0430}\u{0439}\u{0434}\u{0435}\u{043D}\u{043E}',
  xAnalysisViews: '\u{041F}\u{0440}\u{043E}\u{0441}\u{043C}\u{043E}\u{0442}\u{0440}\u{043E}\u{0432}',
  xAnalysisLikes: '\u{041B}\u{0430}\u{0439}\u{043A}\u{043E}\u{0432}',
  xAnalysisRetweets: '\u{0420}\u{0435}\u{0442}\u{0432}\u{0438}\u{0442}\u{043E}\u{0432}',
  xAnalysisReplies: '\u{041E}\u{0442}\u{0432}\u{0435}\u{0442}\u{043E}\u{0432}',
  xAnalysisAuthors: '\u{041A}\u{0442}\u{043E} \u{043F}\u{0438}\u{0448}\u{0435}\u{0442}',
  xAnalysisNone: (query) => `\u{1F426} <b>X / Twitter:</b> \u{043D}\u{0435}\u{0442} \u{0442}\u{0432}\u{0438}\u{0442}\u{043E}\u{0432} \u{043F}\u{043E} \u{0437}\u{0430}\u{043F}\u{0440}\u{043E}\u{0441}\u{0443} <code>${query}</code>`,
  xAnalysisError: (err) => `\u{274C} \u{041E}\u{0448}\u{0438}\u{0431}\u{043A}\u{0430} X \u{0410}\u{043D}\u{0430}\u{043B}\u{0438}\u{0437}\u{0430}: ${err}`,
  xAnalysisNoKeywords: '\u{041D}\u{0435}\u{0434}\u{043E}\u{0441}\u{0442}\u{0430}\u{0442}\u{043E}\u{0447}\u{043D}\u{043E} \u{043A}\u{043B}\u{044E}\u{0447}\u{0435}\u{0432}\u{044B}\u{0445} \u{0441}\u{043B}\u{043E}\u{0432} \u{0434}\u{043B}\u{044F} \u{043F}\u{043E}\u{0438}\u{0441}\u{043A}\u{0430} \u{0432} X',

  // Inline-кнопки на карточке результата
  xAnalysisRefreshBtn: '\u{1F504} \u{041E}\u{0431}\u{043D}\u{043E}\u{0432}\u{0438}\u{0442}\u{044C}',
  xAnalysisSearchBtn:  '\u{1F517} \u{041F}\u{043E}\u{0438}\u{0441}\u{043A} \u{0432} X',

  // Cooldown (cooldown refresh'а 1ч)
  xAnalysisCooldown: (min) =>
    `\u{23F3} \u{041E}\u{0431}\u{043D}\u{043E}\u{0432}\u{0438}\u{0442}\u{044C} \u{043C}\u{043E}\u{0436}\u{043D}\u{043E} \u{0447}\u{0435}\u{0440}\u{0435}\u{0437} ${min} \u{043C}\u{0438}\u{043D}`,

  // Cache / актёр-фолбэк пометки
  xAnalysisFromCache: (min) =>
    `\u{1F4BE} \u{0418}\u{0437} \u{043A}\u{044D}\u{0448}\u{0430} \u{00B7} ${min} \u{043C}\u{0438}\u{043D} \u{043D}\u{0430}\u{0437}\u{0430}\u{0434}`,
  xAnalysisFallbackNote: (actor) =>
    `\u{26A0}\u{FE0F} \u{041E}\u{0441}\u{043D}\u{043E}\u{0432}\u{043D}\u{043E}\u{0439} \u{0430}\u{043A}\u{0442}\u{043E}\u{0440} \u{0443}\u{043F}\u{0430}\u{043B}, \u{0438}\u{0441}\u{043F}\u{043E}\u{043B}\u{044C}\u{0437}\u{0443}\u{0435}\u{0442}\u{0441}\u{044F} ${actor}`,

  // Delta (предыдущий балл виральности)
  xAnalysisDelta: (prev, sign) =>
    `\u{1F4C8} \u{0411}\u{044B}\u{043B}\u{043E}: <b>${prev}/100</b> (${sign})`,
  xAnalysisDeltaNeutral: (prev) =>
    `\u{1F4C8} \u{0411}\u{044B}\u{043B}\u{043E}: <b>${prev}/100</b> (=)`,

  // Concentration-предупреждение
  xAnalysisConcentration: (pct, author) =>
    `\u{26A0}\u{FE0F} <b>@${author}</b> \u{0434}\u{0430}\u{0451}\u{0442} <b>${pct}%</b> \u{0432}\u{0441}\u{0435}\u{0433}\u{043E} \u{043E}\u{0445}\u{0432}\u{0430}\u{0442}\u{0430} (\u{043E}\u{0434}\u{0438}\u{043D} \u{0430}\u{043A}\u{043A}\u{0430}\u{0443}\u{043D}\u{0442})`,

  // Grok snapshot из сохранённого xSearchData
  xAnalysisGrokHeader:
    '\u{1F9E0} <b>Grok \u{0441}\u{043D}\u{044F}\u{043B} \u{043F}\u{0440}\u{0438} \u{0441}\u{043A}\u{0430}\u{043D}\u{0435}:</b>',
  xAnalysisGrokLine: (buzz, momentum, organicity) =>
    `buzz=${buzz} \u00B7 momentum=${momentum} \u00B7 organicity=${organicity}`,

  // ── Прогноз каталиста (on-demand Grok reasoning, forward-looking) ──────
  triggerBtn:        '\u{1F52E} Найти Каталиста',
  triggerCachedBtn:  '\u{2728} Каталист',
  triggerLockedBtn:  '\u{1F512} Найти Каталиста (Pro)',
  triggerLocked:     '\u{1F512} Поиск Каталиста доступен только на Pro плане.',
  triggerLoading:    '\u{1F52E} Ищу Каталиста... (~30-60с, reasoning)',
  triggerInFlight:   '\u{1F52E} Другой пользователь уже ищет Каталиста для этого тренда. Попробуй через ~30с.',
  triggerCooldown:   (min) => `\u{23F3} Следующий поиск Каталиста через ${min} мин`,
  triggerHeader:     '\u{1F52E} <b>Каталист:</b>',
  triggerPhaseHdr:   '\u{1F300} <b>Фаза:</b>',
  triggerWindowHdr:  '\u{23F1} <b>Окно:</b>',
  triggerDriversHdr: '\u{1F4C8} <b>Факторы роста:</b>',
  triggerRisksHdr:   '\u{26A0}\u{FE0F} <b>Риски:</b>',
  triggerSourcesHdr: '\u{1F4E1} <b>Источники:</b>',
  triggerConfidence: (pct) => `<i>Уверенность: ${pct}%</i>`,
  triggerPhaseValues: {
    early:     'Зарождается',
    building:  'Набирает',
    peaking:   'На пике',
    saturated: 'Насыщен',
    fading:    'Угасает',
  },
  triggerNotFound:   'Чёткого Каталиста впереди не видно - нарратив выглядит насыщенным, свежих факторов роста нет.',
  triggerError:      (err) => `\u{274C} Ошибка поиска Каталиста: ${err}`,
  triggerDisabled:   '\u{274C} Поиск Каталиста недоступен (XAI_API_KEY не настроен).',

  // ── Errors ─────────────────────────────────────────────────────────────
  dbUnavailable: '\u{274C} \u{0411}\u{0430}\u{0437}\u{0430} \u{0434}\u{0430}\u{043D}\u{043D}\u{044B}\u{0445} \u{043D}\u{0435}\u{0434}\u{043E}\u{0441}\u{0442}\u{0443}\u{043F}\u{043D}\u{0430}',
  trendNotFound: '\u{274C} \u{041D}\u{0430}\u{0440}\u{0440}\u{0430}\u{0442}\u{0438}\u{0432} \u{043D}\u{0435} \u{043D}\u{0430}\u{0439}\u{0434}\u{0435}\u{043D}.',
  errorGeneric: (err) => `\u{274C} \u{041E}\u{0448}\u{0438}\u{0431}\u{043A}\u{0430}: ${err}`,

  // ── Categories ─────────────────────────────────────────────────────────
  categories: {
    meme: '\u{1F602} \u{041C}\u{0435}\u{043C}',
    celebrity: '\u{2B50} \u{0417}\u{043D}\u{0430}\u{043C}\u{0435}\u{043D}\u{0438}\u{0442}\u{043E}\u{0441}\u{0442}\u{044C}',
    animals: '\u{1F43E} \u{0416}\u{0438}\u{0432}\u{043E}\u{0442}\u{043D}\u{044B}\u{0435}',
    tech: '\u{1F4BB} Tech/AI',
    gambling: '\u{1F3B0} \u{0413}\u{044D}\u{043C}\u{0431}\u{043B}\u{0438}\u{043D}\u{0433}',
    sports: '\u{1F3C6} \u{0421}\u{043F}\u{043E}\u{0440}\u{0442}',
    politics: '\u{1F3DB}\u{FE0F} \u{041F}\u{043E}\u{043B}\u{0438}\u{0442}\u{0438}\u{043A}\u{0430}',
    entertainment: '\u{1F3AC} \u{0420}\u{0430}\u{0437}\u{0432}\u{043B}\u{0435}\u{0447}\u{0435}\u{043D}\u{0438}\u{044F}',
    gaming: '\u{1F3AE} \u{0418}\u{0433}\u{0440}\u{044B}',
    boring: '\u{1F634} \u{0421}\u{043A}\u{0443}\u{043A}\u{043E}\u{0442}\u{0430}',
    other: '\u{1F4CC} \u{0420}\u{0430}\u{0437}\u{043D}\u{043E}\u{0435}',
  },

  sentiments: {
    positive: '\u{1F60A} \u{041F}\u{043E}\u{0437}\u{0438}\u{0442}\u{0438}\u{0432}\u{043D}\u{043E}\u{0435}',
    negative: '\u{1F620} \u{041D}\u{0435}\u{0433}\u{0430}\u{0442}\u{0438}\u{0432}\u{043D}\u{043E}\u{0435}',
    neutral: '\u{1F610} \u{041D}\u{0435}\u{0439}\u{0442}\u{0440}\u{0430}\u{043B}\u{044C}\u{043D}\u{043E}\u{0435}',
    mixed: '\u{1F914} \u{0421}\u{043C}\u{0435}\u{0448}\u{0430}\u{043D}\u{043D}\u{043E}\u{0435}',
  },

  lifespans: {
    // Keys derive from LIFESPAN_VALUES - see src/analysis/lifespan.js.
    flash:  '\u{26A1} \u{041C}\u{043E}\u{043B}\u{043D}\u{0438}\u{044F} (\u{0447}\u{0430}\u{0441}\u{044B})',
    short:  '\u{1F550} \u{041A}\u{043E}\u{0440}\u{043E}\u{0442}\u{043A}\u{0438}\u{0439} (1-2 \u{0434}\u{043D}\u{044F})',
    medium: '\u{1F4C5} \u{0421}\u{0440}\u{0435}\u{0434}\u{043D}\u{0438}\u{0439} (3-7 \u{0434}\u{043D}\u{0435}\u{0439})',
    long:   '\u{1F4C6} \u{0414}\u{043B}\u{0438}\u{043D}\u{043D}\u{044B}\u{0439} (\u{043D}\u{0435}\u{0434}\u{0435}\u{043B}\u{0438}+)',
    'unknown': '\u{2753} \u{041D}\u{0435}\u{0438}\u{0437}\u{0432}\u{0435}\u{0441}\u{0442}\u{043D}\u{043E}',
  },

  // Причина оценки - Feedback reason wizard
  btnFeedbackReason: '\u{270F}\u{FE0F} Причина оценки',
  feedbackReasonPrompt: '\u{1F4DD} <b>Почему такая оценка?</b>\n\nНапиши одно короткое предложение (любой язык). /skip - отменить. Макс 240 символов.',
  feedbackReasonSaved: '\u{2705} <b>Причина сохранена.</b> AI учтёт это при оценке похожих трендов.',
  feedbackReasonSkipped: '\u{1F44C} Отменено - ваша оценка осталась без изменений.',
  feedbackReasonNoVote: '\u{26A0}\u{FE0F} Вы не голосовали за этот тренд, или голос уже удалён. Сначала проголосуйте.',
  feedbackReasonTooLong: '\u{26A0}\u{FE0F} Слишком длинно (макс 240 символов). Нажмите кнопку ещё раз.',
};

// Loud failure at module load if the i18n maps drift from LIFESPAN_VALUES.
assertCoversLifespans('ru.topLifeIcons', ru.topLifeIcons);
assertCoversLifespans('ru.lifespans',    ru.lifespans);

export default ru;

function scoreEmoji(score) {
  if (score >= 90) return '\u{1F525}\u{1F525}\u{1F525}';
  if (score >= 75) return '\u{1F525}\u{1F525}';
  if (score >= 60) return '\u{1F525}';
  return '\u{1F4CA}';
}
