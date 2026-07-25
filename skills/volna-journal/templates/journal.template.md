---
task: <ID>
title: "<заголовок из TFS>"
type: <bug|story|task>
tracker: "<ссылка на задачу в трекере>"
parent:                    # родительская US — источник постановки (для bug)
fix_task:                  # id задачи-фикса в TFS (появится на push-pr)
branch: <bugfix|feature>/<ID>-<slug>
repos: []                  # back | front | agent
stage: intake
stages_done: []
skipped: []
open: []
started: <YYYY-MM-DDTHH:MM>
updated: <YYYY-MM-DDTHH:MM>
---

# <ID> — <заголовок>

## intake · итерация 1 · <YYYY-MM-DD HH:MM>
**что:** принята задача <ID> (<тип>) из TFS; создана ветка `<branch>`; рабочее дерево было чистым.
**зачем:** <одна строка: какую проблему пользователя закрывает задача>
**как:** <как делать>
**сделано:** журнал создан, ветка создана, тип задачи определён.
**осталось:** анализ постановки и эталона.

