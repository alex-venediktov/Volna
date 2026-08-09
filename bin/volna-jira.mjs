#!/usr/bin/env node
/**
 * CLI над трекером Jira Cloud для «Волны». Обёртка вокруг lib/jira-client.mjs: читает адреса
 * из .env рабочего репозитория, печатает компактный markdown для чтения моделью.
 *
 * Запись выполняется сразу, отдельного флага подтверждения нет: решение о необратимом
 * (смена статуса, комментарий, списание часов) принимает человек в разговоре. Посмотреть, что
 * команда собиралась изменить, ничего не меняя, - флаг --dry-run.
 *
 * Использование:
 *   volna-jira check                       проверить доступ (для /volna:doctor)
 *   volna-jira whoami                      кто мы для трекера: на кого уйдут часы и комментарии
 *   volna-jira get <ключ>                  задача: поля, постановка, обсуждение, связи, вложения
 *   volna-jira query [jql]                 выборка по JQL (без аргумента - JIRA_JQL_MINE)
 *   volna-jira states <ключ|тип>           доступные переходы задачи либо статусы типа задач
 *   volna-jira comment <ключ> <текст>      комментарий в обсуждение (вход - markdown)
 *   volna-jira describe <ключ> --body-file f  дописать абзац в описание ([--replace] - заменить)
 *   volna-jira state <ключ> <статус>       перевести задачу переходом рабочего процесса
 *   volna-jira time <ключ> <часы>          списать часы ([--comment текст])
 *   volna-jira estimate <ключ> --original N   оценка и остаток работ ([--remaining M])
 *
 * Многострочные поля (описание, комментарий) принимают MARKDOWN: wiki-разметка Jira собирается
 * сама. Идентификатор задачи - строковый ключ вида RJDB-2228, а не число.
 *
 * Флаги: --dry-run (напечатать намерение и не менять ничего), --json (сырой ответ вместо markdown).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JiraClient, jiraConfigFromEnv, summarizeIssue, issueKind, SEARCH_FIELDS } from "../lib/jira-client.mjs";
import { loadEnv } from "../lib/env.mjs";

const WRITE_COMMANDS = new Set(["comment", "describe", "state", "time", "estimate"]);

/** Выборка «мои задачи», если проект не задал свою в JIRA_JQL_MINE. */
const DEFAULT_JQL_MINE = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

/** Ключ задачи Jira: буквенный префикс проекта, дефис, число. */
export const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** Разобрать argv в команду, позиционные аргументы и признаки. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const withValue = ["comment", "body", "body-file", "original", "remaining", "max", "pages",
    "project", "fields", "started"];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (withValue.includes(name)) flags[name] = argv[++i] ?? "";
    else flags[name] = true;
  }
  return { command: positional[0], args: positional.slice(1), flags };
}

/**
 * Точка входа, пригодная для тестов: зависимости инжектируются.
 * Возвращает код выхода, ничего не бросает наружу.
 */
export async function run(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  const readFile = deps.readFile ?? ((p) => readFileSync(p, "utf8"));

  const { command, args, flags } = parseArgs(argv);

  if (!command || flags.help || command === "help") {
    log(usage());
    return command ? 0 : 1;
  }

  if (WRITE_COMMANDS.has(command) && flags["dry-run"]) {
    err(describeIntent(command, args, flags));
    err("Это --dry-run: в трекер ничего не отправлено.");
    return 0;
  }

  let client;
  try {
    if (deps.client) {
      client = deps.client;
    } else {
      loadEnv({ env });
      client = new JiraClient(jiraConfigFromEnv(env));
    }
  } catch (e) {
    err(String(e?.message ?? e));
    return 2;
  }

  try {
    switch (command) {
      case "check": return await cmdCheck(client, log);
      case "whoami": return await cmdWhoami(client, log, flags);
      case "get": return await cmdGet(client, args, flags, log, err);
      case "query": return await cmdQuery(client, args, flags, env, log, err);
      case "states": return await cmdStates(client, args, flags, log, err);
      case "comment": return await cmdComment(client, args, flags, log, err, readFile);
      case "describe": return await cmdDescribe(client, args, flags, log, err, readFile);
      case "state": return await cmdState(client, args, log, err);
      case "time": return await cmdTime(client, args, flags, log, err);
      case "estimate": return await cmdEstimate(client, args, flags, log, err);
      default:
        err(`Неизвестная команда: ${command}`);
        err(usage());
        return 1;
    }
  } catch (e) {
    err(String(e?.message ?? e));
    return 1;
  }
}

/** Доступ к трекеру: 401 и 403 различаются, недоступность сети приходит статусом 0. */
async function cmdCheck(client, log) {
  const res = await client.verifyAccess();
  if (res.ok) {
    log(`Доступ есть: ${res.user?.displayName ?? "?"} (${res.user?.emailAddress ?? "почта скрыта"})`);
    return 0;
  }
  if (res.status === 401) log("Отказ 401: токен истёк либо не совпадает с учётной записью из JIRA_EMAIL.");
  else if (res.status === 403) log("Отказ 403: учётной записи не хватает прав.");
  else if (res.status === 0) log(`Сервер недоступен (сеть или адрес): ${res.body}`);
  else log(`Отказ ${res.status}: ${res.body}`);
  return 1;
}

/** Учётная запись токена: ею подпишутся комментарии и списанные часы. */
async function cmdWhoami(client, log, flags) {
  const user = await client.currentUser();
  if (flags.json) {
    log(JSON.stringify(user, null, 2));
    return 0;
  }
  log(`${user.displayName ?? "?"} · accountId ${user.accountId ?? "?"} · ${user.emailAddress ?? "почта скрыта"}`);
  return 0;
}

/** Задача целиком: карточка, постановка и обсуждение одним markdown. */
async function cmdGet(client, args, flags, log, err) {
  const key = args[0];
  if (!key) {
    err("Нужен ключ задачи: volna-jira get RJDB-2228");
    return 1;
  }
  const issue = await client.getIssue(key);
  if (flags.json) {
    log(JSON.stringify(issue, null, 2));
    return 0;
  }
  const comments = await client.comments(key);
  log(summarizeIssue(issue, comments));
  return 0;
}

/** Выборка по JQL: строка на задачу. Обрезанный по пределу страниц ответ называет себя сам. */
async function cmdQuery(client, args, flags, env, log, err) {
  const jql = args.join(" ").trim() || client.jqlMine || env.JIRA_JQL_MINE || DEFAULT_JQL_MINE;
  const fields = flags.fields ? String(flags.fields).split(",") : SEARCH_FIELDS;
  const maxPages = flags.pages ? Number(flags.pages) : undefined;
  const maxResults = flags.max ? Number(flags.max) : undefined;
  const res = await client.searchJql(jql, { fields, maxPages, maxResults });
  if (flags.json) {
    log(JSON.stringify(res.issues, null, 2));
    return 0;
  }
  log(`JQL: ${jql}`);
  log(`найдено: ${res.issues.length}${res.truncated ? " (ответ обрезан пределом страниц: уточни запрос или подними --pages)" : ""}`);
  for (const i of res.issues) {
    const f = i.fields ?? {};
    log(`- ${i.key} · ${f.issuetype?.name ?? "?"} · ${f.status?.name ?? "?"} · ${f.assignee?.displayName ?? "не назначен"} · ${f.summary ?? ""}`);
  }
  return 0;
}

/**
 * Справочник рабочего процесса. Ключ задачи - доступные ИЗ ТЕКУЩЕГО статуса переходы;
 * имя типа - все статусы этого типа в проекте.
 */
async function cmdStates(client, args, flags, log, err) {
  const target = args[0];
  if (!target) {
    err("Нужен ключ задачи или имя типа: volna-jira states RJDB-2228 | volna-jira states Задача");
    return 1;
  }
  if (ISSUE_KEY.test(target)) {
    const list = await client.transitions(target);
    if (flags.json) {
      log(JSON.stringify(list, null, 2));
      return 0;
    }
    log(`Переходы, доступные из текущего статуса ${target}:`);
    if (!list.length) log("- ни одного (проверь права либо статус задачи)");
    for (const t of list) log(`- ${t.name} -> статус ${t.to?.name ?? "?"}`);
    log("Имя перехода не совпадает с именем статуса: команда state принимает и то, и другое.");
    return 0;
  }
  const data = await client.projectStatuses(flags.project);
  if (flags.json) {
    log(JSON.stringify(data, null, 2));
    return 0;
  }
  // имя типа приходит то переведённым, то исходным - сопоставление идёт и по виду задачи
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  const wantedKind = issueKind({ name: target });
  const hit = data.find((t) => norm(t.name) === norm(target))
    ?? data.filter((t) => issueKind(t) === wantedKind && !/sub-?task|подзадач/i.test(t.name))[0]
    ?? null;
  if (!hit) {
    log(`Тип "${target}" в проекте не найден. Есть: ${data.map((t) => t.name).join(", ")}`);
    return 1;
  }
  log(`Статусы типа ${hit.name}: ${(hit.statuses ?? []).map((s) => s.name).join(" · ")}`);
  return 0;
}

/** Комментарий в обсуждение: вход - markdown, в трекер уходит wiki-разметка. */
async function cmdComment(client, args, flags, log, err, readFile) {
  const key = args[0];
  const text = flags["body-file"] ? readFile(flags["body-file"]) : args.slice(1).join(" ");
  if (!key || !String(text).trim()) {
    err("Нужен ключ и текст: volna-jira comment RJDB-2228 \"текст\" (или --body-file файл)");
    return 1;
  }
  const res = await client.addComment(key, text);
  log(`Комментарий добавлен: ${key} (id ${res.id ?? "?"})`);
  return 0;
}

/** Описание задачи: дописать абзац либо заменить целиком. */
async function cmdDescribe(client, args, flags, log, err, readFile) {
  const key = args[0];
  const text = flags["body-file"] ? readFile(flags["body-file"]) : args.slice(1).join(" ");
  if (!key || !String(text).trim()) {
    err("Нужен ключ и текст: volna-jira describe RJDB-2228 --body-file итог.md [--replace]");
    return 1;
  }
  await client.setDescription(key, text, { replace: Boolean(flags.replace) });
  log(`Описание ${flags.replace ? "заменено" : "дополнено"}: ${key}`);
  return 0;
}

/** Статус задачи меняется переходом рабочего процесса, а не записью поля. */
async function cmdState(client, args, log, err) {
  const [key, ...rest] = args;
  const wanted = rest.join(" ").trim();
  if (!key || !wanted) {
    err("Нужен ключ и статус: volna-jira state RJDB-2228 \"В работе\"");
    return 1;
  }
  const hit = await client.transitionTo(key, wanted);
  log(`${key}: выполнен переход "${hit.name}" -> статус ${hit.to?.name ?? "?"}`);
  return 0;
}

/** Списание часов: запись worklog прибавляется к затраченному и уменьшает остаток. */
async function cmdTime(client, args, flags, log, err) {
  const [key, hours] = args;
  if (!key || !hours) {
    err("Нужен ключ и часы: volna-jira time RJDB-2228 1.5 [--comment \"что делали\"]");
    return 1;
  }
  await client.addWorklog(key, String(hours).replace(",", "."), {
    comment: flags.comment || undefined,
    started: flags.started || undefined,
  });
  log(`${key}: списано ${hours} ч`);
  return 0;
}

/** Оценка и остаток работ полем timetracking. */
async function cmdEstimate(client, args, flags, log, err) {
  const key = args[0];
  if (!key || (flags.original === undefined && flags.remaining === undefined)) {
    err("Нужен ключ и хотя бы одно значение: volna-jira estimate RJDB-2228 --original 8 [--remaining 4]");
    return 1;
  }
  await client.setEstimate(key, {
    original: flags.original !== undefined ? Number(String(flags.original).replace(",", ".")) : undefined,
    remaining: flags.remaining !== undefined ? Number(String(flags.remaining).replace(",", ".")) : undefined,
  });
  log(`${key}: оценка обновлена`);
  return 0;
}

/** Что команда собиралась изменить: печатается вместо запроса при --dry-run. */
export function describeIntent(command, args, flags) {
  const key = args[0] ?? "<ключ>";
  switch (command) {
    case "comment": return `Намерение: комментарий к ${key}.`;
    case "describe": return `Намерение: ${flags.replace ? "заменить" : "дополнить"} описание ${key}.`;
    case "state": return `Намерение: перевести ${key} в "${args.slice(1).join(" ")}" переходом рабочего процесса.`;
    case "time": return `Намерение: списать ${args[1] ?? "?"} ч на ${key}.`;
    case "estimate": return `Намерение: записать оценку ${key} (original ${flags.original ?? "-"}, remaining ${flags.remaining ?? "-"}).`;
    default: return `Намерение: ${command} ${args.join(" ")}`;
  }
}

function usage() {
  return `volna-jira - CLI над Jira Cloud для «Волны»

  check                          проверить доступ
  whoami                         учётная запись токена
  get <ключ>                     задача целиком (поля, постановка, обсуждение)
  query [jql]                    выборка по JQL (без аргумента - JIRA_JQL_MINE)
  states <ключ|тип>              переходы задачи либо статусы типа
  comment <ключ> <текст>         комментарий (markdown)
  describe <ключ> --body-file f  описание: дополнить или --replace
  state <ключ> <статус>          перевести переходом рабочего процесса
  time <ключ> <часы>             списать часы
  estimate <ключ> --original N   оценка и остаток (--remaining M)

Переменные: JIRA_BASE_URL, JIRA_EMAIL, JIRA_TOKEN_FILE, JIRA_PROJECT, JIRA_JQL_MINE.
Флаги: --dry-run, --json, --pages N, --max N.`;
}

/**
 * Прямой запуск, а не импорт. Сравниваем сам файл, а не суффикс имени: суффикс совпадает и у
 * теста (test-volna-jira.mjs), из-за чего CLI запускался при импорте и убивал тест.
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2)));
}
