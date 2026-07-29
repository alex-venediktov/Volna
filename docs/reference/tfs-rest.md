# Справка: TFS / Azure DevOps Server REST для «Волны»

> Перенесённое в проект знание, добытое на реальном сервере. Читать **до** написания кода,
> который пишет в TFS. Реализация — [`lib/tfs-client.mjs`](../../lib/tfs-client.mjs),
> CLI-обёртка над ней — [`bin/volna-tfs.mjs`](../../bin/volna-tfs.mjs).
>
> Конкретные адреса, имена проектов и путь к PAT здесь не хранятся — они в `.env`
> (см. [`.env.example`](../../.env.example)).

## Подключение

| Что | Как |
|---|---|
| база | `${TFS_BASE_URL}` — URL **коллекции**, например `http://<host>/tfs/<Collection>` |
| версия API | `api-version=5.0` для on-prem; добавляется к каждому запросу |
| авторизация | `Authorization: Basic base64(":" + PAT)` — логин пустой, PAT как пароль |
| PAT | из файла (`TFS_PAT_FILE`), кодировка **utf-8-sig** → срезать BOM и края. В переменной окружения секрет не держим |
| project-scoped | `wiql`, создание work item, загрузка вложений требуют префикс проекта: `${TFS_BASE_URL}/${TFS_PROJECT}/_apis/...` |

## Семь подвохов, которые стоят часа отладки

1. **Тело запроса — UTF8-байтами.** Строка вместо байтов → кириллица бьётся, сервер отвечает
   **TF401319**. Ошибка выглядит как проблема прав или правил поля, но это клиентская
   кодировка. В клиенте: `body: new TextEncoder().encode(JSON.stringify(...))`.
2. **`System.Parent` в обычном ответе пуст.** Родитель, дети, PR и вложения приходят только с
   `$expand=relations`. Типы связей: `System.LinkTypes.Hierarchy-Reverse` — родитель,
   `-Forward` — дети, `ArtifactLink` — PR, `AttachedFile` — вложение.
3. **Многострочные поля — HTML, не Markdown.** `System.Description`,
   `Microsoft.VSTS.TCM.ReproSteps`, `System.History` рендерятся как HTML: Markdown в них видно
   как текст. Писать через `markdownToTfsHtml()`, спецсимволы экранировать. Однострочные поля
   (заголовок, эстимация, назначение) — простым текстом, без HTML.
   Это правило **уровня REST**. Через `bin/volna-tfs.mjs` подаётся **Markdown**: `markdownToTfsHtml()`
   вызывается внутри и вход экранирует, поэтому свёрстанные руками теги уйдут в трекер текстом.
4. **Связь задача-PR — `ArtifactLink`, а не гиперссылка.** Гиперссылка видна в задаче, но
   нативной трассировки не даёт. Адрес собирается из **id** проекта и репозитория, которых в
   веб-ссылке на PR нет:
   `vstfs:///Git/PullRequestId/{projectId}%2F{repositoryId}%2F{pullRequestId}` — разделители
   именно `%2F`, с косыми чертами сервер связь не примет.
5. **`System.History` в ответе work item не равно обсуждению.** Поле хранит только последнюю
   правку и в обычном ответе чаще всего приходит пустым: у задачи с двумя комментариями оно
   пустое, а комментарии лежат в `/updates` (`fields["System.History"].newValue` каждой
   ревизии). Читать обсуждение по полю — значит регулярно терять согласованную постановку.
   В клиенте: `comments(id)`.
6. **Причина и состояние ограничены списком процесса.** Свободный текст в `System.Reason`
   отклоняется с `not in the list of supported values`, и сервер откатывает **весь** patch:
   состояние тоже не меняется. Допустимые значения — только через **preview**-версии API
   (`5.0` отвечает `VssInvalidPreviewVersionException`):
   `GET /{project}/_apis/wit/workitemtypes/{Type}/states?api-version=5.0-preview` и
   `GET /{project}/_apis/wit/workitemtypes/{Type}/fields/System.Reason?$expand=allowedValues&api-version=5.0-preview.2`.
   В CLI: `states <тип>`.
7. **У создания задачи бывают обязательные поля процесса.** Набор свой на каждом сервере
   (контроль проекта, приоритет, вид работ), в ответе он приходит как **TF401320** с
   `fieldReferenceName`, но **без допустимых значений** — их отдаёт тот же preview-справочник
   полей: `GET /{project}/_apis/wit/workitemtypes/{Type}/fields?$expand=allowedValues&api-version=5.0-preview.2`
   (флаг `alwaysRequired` отмечает обязательные). В CLI: `fields <тип>` — посмотреть, `--field
   <ref>=<значение>` — задать, `--like <id>` — снять с существующей задачи. Собирать запрос руками
   в обход CLI не надо.
   Если тело всё же собирается вручную: **значение поля обязано быть скаляром**. Объект сервер
   принимает и отвечает `Unable to cast object of type Dictionary to type String` — ни одного
   поля в ошибке не названо. Типовой источник объекта — чтение файла в PowerShell: строка
   приезжает с техническими свойствами, сериализатор пишет вложенную структуру. Лечится
   приведением к строке до укладки в тело.

## Pull request (`_apis/git`)

| Операция | Метод и путь |
|---|---|
| id проекта | `GET /_apis/projects/{имя}` → `id` (для artifact-ссылки) |
| репозитории проекта | `GET /{project}/_apis/git/repositories` → `[{id, name}]` |
| создать PR | `POST /_apis/git/repositories/{repoId}/pullrequests`, тело `{sourceRefName, targetRefName, title, description}` |
| состояние PR | `GET /_apis/git/repositories/{repoId}/pullrequests/{id}` |
| коммиты PR | `GET /_apis/git/repositories/{repoId}/pullrequests/{id}/commits` |
| связь с задачей | `PATCH /_apis/wit/workitems/{id}`, связь `ArtifactLink` с vstfs-адресом выше |

Тонкости:

- **ветки — полными именами ссылок**: `refs/heads/<ветка>`, короткое имя сервер не примет
  (`normalizeRefName()` дополняет);
- **репозиторий в пути — только id**, имя не подставляется: сперва `resolveRepositoryId()`;
- `mergeStatus` в ответе: `succeeded` — сливается, `conflicts` — конфликты. Смотреть **до**
  того, как обещать человеку, что PR готов;
- **число коммитов в PR** показывает, не тащит ли ветка чужие изменения: ветка, отведённая от
  другой feature-ветки, несёт её коммиты, и тогда важен порядок слияния;
- веб-ссылки на PR в ответе нет, она собирается сама:
  `{base}/{project}/_git/{repoName}/pullrequest/{id}`.

## Эндпоинты

| Операция | Метод и путь |
|---|---|
| один work item | `GET /_apis/wit/workitems/{id}?$expand=relations` |
| пакетно | `GET /_apis/wit/workitems?ids=1,2,3&$expand=relations` — батчами по **200** |
| история/обсуждение | `GET /_apis/wit/workItems/{id}/updates` |
| поиск | `POST /{project}/_apis/wit/wiql`, тело `{"query":"SELECT [System.Id] FROM WorkItems WHERE ..."}` |
| создать | `POST /{project}/_apis/wit/workitems/${Type}`, `Content-Type: application/json-patch+json` |
| обновить | `PATCH /_apis/wit/workitems/{id}`, тот же content-type |
| вложение | `POST /{project}/_apis/wit/attachments?fileName=...`, `application/octet-stream`, затем связь `AttachedFile` |
| скачать вложение | `GET <relation.url>` — **с PAT**: анонимно 401 |
| состояния типа | `GET /{project}/_apis/wit/workitemtypes/{Type}/states?api-version=5.0-preview` |
| допустимые значения поля | `GET /{project}/_apis/wit/workitemtypes/{Type}/fields/{поле}?$expand=allowedValues&api-version=5.0-preview.2` |
| pull request'ы репозитория | `GET /_apis/git/repositories/{repoId}/pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=refs/heads/<ветка>` |

Формат json-patch: `[{"op":"add","path":"/fields/System.Title","value":"..."}]`;
связь — `{"op":"add","path":"/relations/-","value":{"rel":"...","url":"..."}}`.

## Постановка задачи: где реально лежит текст

Описание в `System.Description` часто формальное. Фактическая постановка — в **обсуждении**
(`System.History`, `/updates`) и в **картинках** (ожидаемый и фактический результат
скриншотами). Поэтому:

- вложения скачивать PAT'ом и складывать локально — модели нужны файлы, а не URL,
  требующие авторизации;
- `htmlToMarkdown()` сохраняет `![alt](src)`, чтобы картинка не потерялась при конвертации;
- для бага читать **родительскую US** (`Hierarchy-Reverse`) — там смысл, которого нет в баге.

## Ошибки

| Код | Что означает на практике |
|---|---|
| `TF401319` | кодировка тела запроса, не права (см. подвох 1) |
| `TF401320` | правило поля: переход состояния или обязательное поле не заполнено (см. подвох 7) |
| `Unable to cast ... Dictionary ... String` | значение поля ушло объектом, а не строкой (см. подвох 7) |
| HTTP 401 | PAT истёк, не тот scope, или BOM/пробел не срезан при чтении файла |
| HTTP 403 | PAT валиден, прав на операцию нет |
| status 0 | сеть/VPN, сервер недоступен — отличать от 401/403 (для этого `verifyAccess()`) |

## Правило записи

Любая запись в TFS — **внешнее необратимое действие**: только по явному подтверждению
человека, каждое изменение отдельно (этап `close`). Флага подтверждения у CLI нет — решение
принимает человек в разговоре, а `--dry-run` показывает, что уйдёт в трекер, ничего не отправляя.
Пакетная смена статусов «заодно» запрещена процессом, а не только вежливостью.
