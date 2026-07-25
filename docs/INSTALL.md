# Установка «Волны»

Репозиторий: `https://github.com/alex-venediktov/Volna` (маркетплейс и плагин — в нём же).

Установка состоит из двух независимых частей:

| Часть | Что это | Ставится |
|---|---|---|
| **процессная** | скиллы `volna-flow`, `volna-journal` и команды `/volna:*` | плагином, один раз на машину |
| **проектная** | `.volna/project.md`, `.env`, правила `.gitignore` | в каждом рабочем репозитории |

Секреты не входят ни в одну из них: `.env` заполняется **после** установки и не коммитится.

---

## Способ 1. Штатный плагин (рекомендуется)

Внутри сессии Claude Code:

```
/plugin marketplace add alex-venediktov/Volna
/plugin install volna@volna          # процесс
/plugin install volna-craft@volna    # ремесленные скиллы (опционально)
```

Дальше — проектная часть, тоже из сессии:

```
/volna:init
```

`/volna:init` создаёт `.volna/`, `.env` и правила `.gitignore`, задаёт вопросы по незаполненному
и ничего не перезаписывает. Затем `/volna:doctor` — проверка.

Обновление: `/plugin marketplace update volna`. Откат — установка с тегом (см. ниже).

## Способ 2. Одна команда PowerShell

Без сторонних менеджеров пакетов (никакого `uv`, `npm`, `pip`) — только `powershell` и,
для установки плагина, CLI `claude`:

```powershell
irm https://raw.githubusercontent.com/alex-venediktov/Volna/main/install.ps1 | iex
```

Ставит плагин **и** разворачивает проектную часть в текущем каталоге. С параметрами:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/alex-venediktov/Volna/main/install.ps1))) `
    -Path D:\work\my-repo -Scope user
```

| Параметр | Смысл | По умолчанию |
|---|---|---|
| `-Path` | рабочий репозиторий для проектной части | текущий каталог |
| `-Repo` | откуда ставить (`owner/repo`) | `alex-venediktov/Volna` |
| `-Ref` | ветка или тег | `main` |
| `-Scope` | область установки плагина: `user`, `project`, `local` | `user` |
| `-SkipPlugin` | только проектная часть | — |

Скрипт идемпотентен: повторный запуск обновляет маркетплейс и не трогает существующие
`.env`, `.volna/project.md` и уже добавленные правила `.gitignore`.

## Способ 3. Автоматически, без ручных команд

Чтобы плагин появлялся у всей команды сам, положить в `.claude/settings.json` **рабочего**
репозитория (файл коммитится):

```json
{
  "extraKnownMarketplaces": {
    "volna": {
      "source": {
        "source": "github",
        "repo": "alex-venediktov/Volna"
      }
    }
  },
  "enabledPlugins": {
    "volna@volna": true,
    "volna-craft@volna": true
  }
}
```

При следующем запуске Claude Code в этом репозитории маркетплейс регистрируется и плагин
включается без участия разработчика: `/plugin marketplace add` вручную не нужен. Проектную
часть всё равно надо развернуть один раз — `/volna:init`.

Закрепить версию: `"source": { "source": "github", "repo": "alex-venediktov/Volna", "ref": "v0.1.0" }`.
Тогда обновление — смена тега в коммите, а не «поехало у всех сразу».

---

## Локальная разработка самой «Волны»

Правки в «Волне» должны подхватываться сразу, без переустановки плагина. Из корня рабочего
репозитория (junction прав администратора не требует):

```cmd
mkdir .claude\skills 2>nul
mkdir .claude\commands 2>nul
mklink /J .claude\skills\volna-flow    D:\Projects\AI\Volna\skills\volna-flow
mklink /J .claude\skills\volna-journal D:\Projects\AI\Volna\skills\volna-journal
mklink /J .claude\commands\volna       D:\Projects\AI\Volna\commands
```

Команды окажутся в пространстве имён `volna` — `/volna:task`, `/volna:status` и далее, то же,
что и у плагина. Держать одновременно junction и установленный плагин не стоит: команды
задвоятся.

Проверить манифесты перед публикацией: `claude plugin validate .`

---

## Что заполнить после установки

1. **`.env`** в рабочем репозитории (шаблон — [`.env.example`](../.env.example)):
   адрес трекера и проект, путь к файлу с PAT, пути репозиториев и корень эталона.
   Токен — **в отдельном файле**, в `.env` только путь к нему.
2. **`.volna/project.md`**: команды сборки и тестов, конвенции ветвления, коммитов,
   комментариев и тестов. Плейсхолдеры `<заполнить>` — то, что нельзя угадать за вас.
3. **`/volna:doctor`** — проверка: файлы, переменные, попадание `.env` в `.gitignore`,
   доступность базы знаний, совпадение активной задачи с текущей веткой.

Первая задача — `/volna:task <номер>`. Система команд — в [`README.md`](../README.md).

---

## Ограничения установки

- **Плагин ставит только процессную часть.** Проектные скиллы конкретного продукта остаются
  в рабочем репозитории — см. [`PROJECT-SKILLS.md`](PROJECT-SKILLS.md).
- **`install.ps1` требует CLI `claude`** для установки плагина. Нет его — скрипт всё равно
  развернёт проектную часть и напечатает, что выполнить в сессии вручную.
- **Windows-first.** `install.ps1` рассчитан на PowerShell 5.1; скрипт сохранён в UTF-8 **с
  BOM** — без BOM PowerShell 5.1 читает кириллицу как ANSI и падает на разборе. При правках
  файла кодировку сохранять.
- **Hooks (шапка сессии, гейт на commit) появятся в W2** — сейчас плагин их не содержит,
  флоу целиком добровольный.
