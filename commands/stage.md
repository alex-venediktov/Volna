---
description: Перейти к указанному этапу флоу «Волны»
argument-hint: <intake|analyze|spec|plan|implement|advocate|fixtures|unit-tests|visual|commit|push-pr|close|capture>
---

Перейди к этапу `$ARGUMENTS` активной задачи.

1. Прочитай `skills/volna-flow/stages/$ARGUMENTS.md` — **только этот файл**, не весь набор.
2. Обнови `stage` во frontmatter журнала и отметку в трекере задач сессии.
3. Выполняй этап по его инструкции; в конце допиши секцию в журнал.

Этап уровня **required** (`intake`, `commit`, `push-pr`, `close`) — необратимые действия
выполняй только после явного «да» от человека.

Аргумент не указан или не из списка — покажи карту этапов из скилла `volna-flow` с текущей
позицией и спроси вариантами (`AskUserQuestion`), куда перейти. Перепрыгивание вперёд через
незакрытые этапы допустимо: отметь пропущенные как skipped с причиной.
