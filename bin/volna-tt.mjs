#!/usr/bin/env node
/**
 * CLI над локальным трекером task-tracker для «Волны» - шлюз volna-tracker при профиле
 * `трекер: task-tracker`. Обёртка вокруг lib/tt-client.mjs: читает адрес и проект из .env
 * рабочего репозитория, печатает компактный markdown для чтения моделью.
 *
 * Запись выполняется сразу, отдельного флага подтверждения нет: решение о необратимом
 * принимает человек в разговоре. Посмотреть намерение, ничего не меняя, - флаг --dry-run.
 *
 * Использование:
 *   volna-tt check                         проверить доступ к серверу (для /volna:doctor)
 *   volna-tt get <id>                      задача: поля, вид для флоу, постановка с обсуждением
 *   volna-tt query [статус] [--tag t] [--all]   задачи своего проекта (без статуса - кроме done)
 *   volna-tt states                        статусы сервера
 *   volna-tt comment <id> <текст>          комментарий в «Обсуждение» (или --body-file f)
 *   volna-tt describe <id> --body-file f   дописать абзац в постановку ([--replace] - заменить)
 *   volna-tt state <id> <статус>           перевести задачу в статус (колонку доски)
 *   volna-tt create <вид> --title T        завести задачу с id <префикс>-<N>: bug -> bugfix,
 *                                          task/story -> feature, research -> research;
 *                                          [--parent id] [--body-file f] [--status s] [--id свой]
 *
 * Id задачи - номер (`1`) либо строка (`feature-3`); номер новой - наибольший по серверу + 1.
 * Флаги: --dry-run (напечатать намерение и не менять ничего), --json (сырой ответ вместо markdown).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskTrackerClient, ttConfigFromEnv, taskKind, prefixFor, TT_STATUSES, ID_PREFIXES } from "../lib/tt-client.mjs";
import { loadEnv } from "../lib/env.mjs";

const WRITE_COMMANDS = new Set(["comment", "describe", "state", "create"]);

/** Сколько раз create берёт следующий номер, если вычисленный id успели занять. */
const CREATE_ATTEMPTS = 3;

/** Разобрать argv в команду, позиционные аргументы и признаки. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const withValue = ["body", "body-file", "title", "parent", "status", "tag", "id"];
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
      client = new TaskTrackerClient(ttConfigFromEnv(env));
    }
  } catch (e) {
    err(String(e?.message ?? e));
    return 2;
  }

  try {
    switch (command) {
      case "check": return await cmdCheck(client, log);
      case "get": return await cmdGet(client, args, flags, log, err);
      case "query": return await cmdQuery(client, args, flags, log);
      case "states": return cmdStates(log);
      case "comment": return await cmdComment(client, args, flags, log, err, readFile);
      case "describe": return await cmdDescribe(client, args, flags, log, err, readFile);
      case "state": return await cmdState(client, args, log, err);
      case "create": return await cmdCreate(client, args, flags, log, err, readFile);
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

/** Доступ к серверу: ответил ли он и есть ли на нём свой проект. */
async function cmdCheck(client, log) {
  const res = await client.verifyAccess();
  if (!res.ok) {
    log(res.status === 0 ? `Сервер недоступен: ${res.body}` : `Отказ: ${res.body}`);
    return 1;
  }
  const own = res.projects.find((p) => p.project === client.project);
  log(`Доступ есть: ${client.url}, проект ${client.project} - ` +
    (own ? `задач ${own.tasks ?? "?"}` : "задач пока нет (проект появится с первой задачей)"));
  return 0;
}

/** Задача целиком: карточка, вид для флоу и постановка одним markdown. */
async function cmdGet(client, args, flags, log, err) {
  const id = args[0];
  if (!id) {
    err("Нужен id задачи: volna-tt get feature-3");
    return 1;
  }
  const task = await client.getTask(id);
  if (flags.json) {
    log(JSON.stringify(task, null, 2));
    return 0;
  }
  log(summarizeTask(task));
  return 0;
}

/** Карточка задачи для модели: поля строкой, затем постановка как есть. */
export function summarizeTask(task) {
  const lines = [
    `# ${task.id} · ${task.title ?? ""}`,
    `проект: ${task.project ?? "?"} · статус: ${task.status ?? "?"} · вид для флоу: ${taskKind(task)}` +
      ` · теги: ${(task.tags ?? []).join(", ") || "-"}`,
    `автор: ${task.author ?? "?"} · создана: ${task.created ?? "?"} · обновлена: ${task.updated ?? "?"}`,
  ];
  if (task.url) lines.push(`ссылка: ${task.url}`);
  lines.push("", String(task.body ?? "").trim() || "(постановка пуста)");
  return lines.join("\n");
}

/** Задачи своего проекта: строка на задачу; без статуса и без --all закрытые не показываются. */
async function cmdQuery(client, args, flags, log) {
  const status = args[0];
  const tag = typeof flags.tag === "string" ? flags.tag : undefined;
  const all = await client.listTasks({ status, tag });
  const tasks = (all ?? []).filter((t) => status || flags.all || t.status !== "done");
  if (flags.json) {
    log(JSON.stringify(tasks, null, 2));
    return 0;
  }
  log(`проект ${client.project}${status ? `, статус ${status}` : flags.all ? "" : ", кроме done"}${tag ? `, тег ${tag}` : ""}`);
  log(`найдено: ${tasks.length}`);
  for (const t of tasks) log(`- ${t.id} · ${t.status} · ${t.title}${t.tags?.length ? ` · ${t.tags.join(", ")}` : ""}`);
  return 0;
}

/** Статусы сервера: набор постоянный, справочник без запроса. */
function cmdStates(log) {
  log(`Статусы task-tracker: ${TT_STATUSES.join(" · ")}`);
  return 0;
}

/** Комментарий в секцию «Обсуждение» постановки. */
async function cmdComment(client, args, flags, log, err, readFile) {
  const id = args[0];
  const text = flags["body-file"] ? readFile(flags["body-file"]) : args.slice(1).join(" ");
  if (!id || !String(text).trim()) {
    err("Нужен id и текст: volna-tt comment feature-3 \"текст\" (или --body-file файл)");
    return 1;
  }
  await client.commentTask(id, text);
  log(`Комментарий добавлен: ${id}`);
  return 0;
}

/** Постановка: дописать абзац либо заменить целиком; сервер принимает поле только целиком. */
async function cmdDescribe(client, args, flags, log, err, readFile) {
  const id = args[0];
  const text = flags["body-file"] ? readFile(flags["body-file"]) : args.slice(1).join(" ");
  if (!id || !String(text).trim()) {
    err("Нужен id и текст: volna-tt describe feature-3 --body-file итог.md [--replace]");
    return 1;
  }
  let body = String(text).trim();
  if (!flags.replace) {
    const task = await client.getTask(id);
    const before = String(task.body ?? "").trimEnd();
    body = before ? `${before}\n\n${body}` : body;
  }
  await client.updateTask(id, { body });
  log(`Постановка ${flags.replace ? "заменена" : "дополнена"}: ${id}`);
  return 0;
}

/** Статус задачи: имя проверяется до запроса, набор у сервера постоянный. */
async function cmdState(client, args, log, err) {
  const [id, ...rest] = args;
  const wanted = rest.join(" ").trim().toLowerCase();
  if (!id || !wanted) {
    err("Нужен id и статус: volna-tt state feature-3 doing");
    return 1;
  }
  if (!TT_STATUSES.includes(wanted)) {
    err(`Статуса «${wanted}» у task-tracker нет. Есть: ${TT_STATUSES.join(", ")}`);
    return 1;
  }
  const task = await client.moveTask(id, wanted);
  log(`${id}: статус ${task?.status ?? wanted}`);
  return 0;
}

/** Завести задачу с id вида <префикс>-<N>; родитель - строкой в постановке и комментарием у него. */
async function cmdCreate(client, args, flags, log, err, readFile) {
  const kind = String(args[0] ?? "").trim();
  const title = typeof flags.title === "string" ? flags.title.trim() : "";
  if (!kind || !title) {
    err("Нужен вид и заголовок: volna-tt create <вид> --title <заголовок> [--parent id] [--body-file f]");
    return 1;
  }
  const prefix = prefixFor(kind);
  if (!prefix) {
    err(`Вид «${kind}» неизвестен. Есть: ${Object.keys(ID_PREFIXES).join(", ")}`);
    return 1;
  }
  if (flags.status !== undefined && !TT_STATUSES.includes(String(flags.status))) {
    err(`Статуса «${flags.status}» у task-tracker нет. Есть: ${TT_STATUSES.join(", ")}`);
    return 1;
  }
  const parent = typeof flags.parent === "string" && flags.parent ? flags.parent : undefined;
  const text = flags["body-file"] ? readFile(flags["body-file"]) : typeof flags.body === "string" ? flags.body : "";
  const body = [parent ? `родитель: ${parent}` : "", String(text).trim()].filter(Boolean).join("\n\n");
  const tag = kindTag(kind);

  let created;
  for (let attempt = 1; !created; attempt++) {
    const taskId = typeof flags.id === "string" && flags.id ? flags.id : await client.nextId(kind);
    try {
      created = await client.createTask({ title, body, status: flags.status, tags: tag ? [tag] : [], taskId });
    } catch (e) {
      // id успели занять между подсчётом и заведением - считаем заново, свой id не перебираем
      if (flags.id || attempt >= CREATE_ATTEMPTS || !/уже занят/.test(String(e?.message))) {
        err(`Задача не создана: ${e?.message ?? e}`);
        return 1;
      }
      continue;
    }
    if (!created?.id) {
      err(`Сервер не вернул id задачи ${taskId}: заведена ли она - volna-tt get ${taskId}`);
      return 1;
    }
  }
  log(`Задача ${created.id} создана: ${title}`);
  if (!parent) return 0;
  log(`родитель: ${parent}`);
  try {
    await client.commentTask(parent, `ребёнок: ${created.id} - ${title}`);
  } catch (e) {
    err(`Комментарий у родителя ${parent} не записан (задача ${created.id} создана): ${e?.message ?? e}`);
  }
  return 0;
}

/** Тег вида: по нему вид узнаётся и у задачи, которой сменили id. */
function kindTag(kind) {
  const k = String(kind).toLowerCase();
  if (k === "bug" || k === "bugfix") return "bug";
  if (k === "research") return "research";
  return null;
}

/** Что команда собиралась изменить: печатается вместо запроса при --dry-run. */
export function describeIntent(command, args, flags) {
  const id = args[0] ?? "<id>";
  switch (command) {
    case "comment": return `Намерение: комментарий к ${id}.`;
    case "describe": return `Намерение: ${flags.replace ? "заменить" : "дополнить"} постановку ${id}.`;
    case "state": return `Намерение: перевести ${id} в "${args.slice(1).join(" ")}".`;
    case "create": return `Намерение: завести ${args[0] ?? "<вид>"} "${flags.title ?? ""}"` +
      ` с id ${typeof flags.id === "string" ? flags.id : `${prefixFor(args[0]) ?? "<префикс>"}-<N> (N - наибольший по серверу + 1)`}` +
      `${flags.parent ? `, родитель ${flags.parent}` : ""}.`;
    default: return `Намерение: ${command} ${args.join(" ")}`;
  }
}

function usage() {
  return `volna-tt - CLI над локальным трекером task-tracker для «Волны»

  check                          проверить доступ к серверу
  get <id>                       задача целиком (поля, вид для флоу, постановка)
  query [статус] [--tag t]       задачи своего проекта (без статуса - кроме done; --all - все)
  states                         статусы сервера
  comment <id> <текст>           комментарий (или --body-file f)
  describe <id> --body-file f    постановка: дополнить или --replace
  state <id> <статус>            перевести в статус: ${TT_STATUSES.join(", ")}
  create <вид> --title T         завести задачу <префикс>-<N> ([--parent id] [--body-file f]
                                 [--status s] [--id свой]); вид: ${Object.keys(ID_PREFIXES).join(", ")}

Переменные: TT_MCP_URL, TT_PROJECT, TT_TIMEOUT_MS (мс, по умолчанию 5000).
Флаги: --dry-run, --json.`;
}

/** Прямой запуск, а не импорт: сравнивается сам файл, суффикс имени совпадает и у теста. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2)));
}
