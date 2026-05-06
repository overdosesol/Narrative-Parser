# Catalyst — instructions for Claude

## Перед работой

1. **Обязательно** прочитай `ai-context/AGENT_RULES.md` — там правила для всех агентных сессий.
2. Затем `ai-context/SESSION_CONTEXT.md` — state-spec проекта. **Не читай целиком**: используй TOC сверху файла + Grep по `## <Имя секции>` + offset/limit reads. Файл ~650 строк, чтение целиком жжёт контекст.
3. Если нужна история изменений — `ai-context/WORKLOG.md` (последние ~10 entries) или `ai-context/WORKLOG_ARCHIVE.md` (старше).

## После работы (если правил код)

1. Допиши новый entry на верх `ai-context/WORKLOG.md` (формат: дата · модель · цель · файлы · деплой · риски).
2. Если изменилось архитектурное **состояние** проекта — обнови `ai-context/SESSION_CONTEXT.md` (state, не change). Если просто фикс — только WORKLOG.
3. Ротация WORKLOG → ARCHIVE при >12 entries — см. `AGENT_RULES.md §6`.

## Стиль общения

- Отвечай на **русском**, общайся на **ты**. Сленг и англицизмы разрешены.
- Не скидывай код в чат, если можно показать через diff в файле.
- Объясняй проще, без академического тона.

## Деплой и git

- Прод деплоится **только** через `deploy.ps1` (Windows) или `deploy.sh` (Linux). Никогда не трогай прод напрямую через ssh, кроме одноразовой диагностики (`docker ps`, чтение файла, и т.п.).
- **Коммиты создавай только когда я явно прошу** («закоммить», «запушь»). Не комитить автоматически после изменений.
- Деструктивные git-команды (`reset --hard`, force push, `branch -D`) — только по явной просьбе.

## Делегирование подагентам

- Чтение больших файлов / массовый поиск / суммаризация → `Agent({model: "haiku", subagent_type: "general-purpose"})`. Дёшево и быстро.
- Code review / архитектурный анализ → дефолт sonnet через `Agent` (без указания модели).
- Сложный reasoning → `Agent({model: "opus"})` только когда задача реально требует.

## Project gotchas (всегда помнить)

- **`src/dashboard/server.js` и `src/admin/server.js`** — огромные inline React SPA внутри template literal. Backticks в комментариях / `\n` в строках / двойной escape в `new RegExp('...')` → чёрный экран. Подробности в `SESSION_CONTEXT.md` секция «Ловушка server.js». **После любого изменения этих файлов** запускай `node scripts/check-{admin,dashboard}-spa.cjs`.
- **SQLite TEXT timestamps** — лексикографическое сравнение пробел < `T`. Используй `sqliteCutoff(msAgo)` helper для сравнений с `CURRENT_TIMESTAMP`-колонками, не голый `toISOString()`.
