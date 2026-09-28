# Прямой прогон hook с windows-путём в JSON читает .volna рабочего каталога, а не песочницы

**тип:** побочный эффект · **предмет:** прямой прогон hooks · **этапы:** implement, unit-tests, advocate
**раздел:** process

**вывод:** hook, запущенный руками (`echo '{"cwd":"<путь>",...}' | node hooks/<hook>.mjs`), с
путём вида `C:\Users\...` внутри строки JSON получает невалидный JSON: `\U`, `\a` - запрещённые
экранирования. `readHookInput` проглатывает ошибку разбора и отдаёт пустой объект, `cwd` пропадает,
и поиск `.volna` начинается с `process.cwd()` - то есть с репозитория, откуда запущен `node`. Hook
печатает правдоподобный ответ по **настоящей** активной задаче, и проверка песочницы выглядит
пройденной или странно проваленной, хотя до песочницы дело не дошло.

В Git Bash на Windows `$TEMP` и `$TMP` раскрываются именно в такой вид (`C:\Users\...\Temp`), поэтому
путь к песочнице `test-hooks.mjs`, собранный из них, ломает JSON всегда.

Путь в ручной JSON подставляется с прямыми слэшами (`cygpath -m "$TEMP/..."` даёт
`C:/Users/...`) либо JSON собирается через `JSON.stringify`, как в `run()` набора
`hooks/test-hooks.mjs`. Признак подмены - в выводе hook стоит id задачи, которой в песочнице нет.

**источник:**
- `hooks/lib/volna-state.mjs:17` — `return raw ? JSON.parse(raw) : {};`
- `hooks/lib/volna-state.mjs:31` — `let dir = resolve(startDir || process.cwd());`

**проверено:** 2026-09-29

**связи:** [[shell-grep-cyrillic-needs-node]], [[plugin-live-run-finds-what-tests-miss]]
