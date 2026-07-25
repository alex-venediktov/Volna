#!/usr/bin/env node
/**
 * CLI над трекером (TFS / Azure DevOps Server) для «Волны». Обёртка вокруг lib/tfs-client.mjs:
 * читает адреса из .env рабочего репозитория, печатает компактный markdown для чтения моделью.
 *
 * ЛЮБАЯ запись требует флага --confirm, который ставит человек. Без него команда объясняет,
 * что именно она собиралась изменить, и выходит с кодом 1: смена статусов и комментарии в
 * трекере необратимы и видны команде.
 *
 * Использование:
 *   volna-tfs check                        проверить доступ (для /volna:doctor)
 *   volna-tfs get <id>                     задача: поля, постановка, обсуждение, связи, вложения
 *   volna-tfs query <запрос>               выборка WIQL: id, тип, состояние, заголовок
 *   volna-tfs comment <id> <текст>         комментарий в обсуждение (markdown -> HTML)
 *   volna-tfs time <id> <часы> [--set]     затраченное время: прибавить или заменить
 *   volna-tfs link-pr <id> <url> [--title] ссылка на PR
 *   volna-tfs attach <id> <файл> [--discussion] [--comment <текст>]
 *   volna-tfs state <id> <состояние> [--assign <кому>] [--reason <причина>]
 *
 * Флаги: --confirm (обязателен для записи), --json (сырой ответ вместо markdown).
 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TfsClient, tfsConfigFromEnv, summarize, pullRequestLinks, markdownToTfsHtml, htmlToMarkdown }
  from "../lib/tfs-client.mjs";
import { loadEnv } from "../lib/env.mjs";

const WRITE_COMMANDS = new Set(["comment", "time", "link-pr", "attach", "state"]);

/** Разобрать argv в команду, позиционные аргументы и флаги. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const name = a.slice(2);
    // флаги со значением: --comment "текст", --assign "кто"
    if (["comment", "assign", "reason", "title", "top"].includes(name)) {
      flags[name] = argv[++i] ?? "";
    } else {
      flags[name] = true;
    }
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
  const readFile = deps.readFile ?? ((p) => readFileSync(p));

  const { command, args, flags } = parseArgs(argv);

  if (!command || flags.help || command === "help") {
    log(usage());
    return command ? 0 : 1;
  }

  if (WRITE_COMMANDS.has(command) && !flags.confirm) {
    err(describeIntent(command, args, flags));
    err("Запись в трекер не выполнена: нет флага --confirm. Его ставит человек, а не агент.");
    return 1;
  }

  let client;
  try {
    if (deps.client) {
      client = deps.client;
    } else {
      loadEnv({ cwd: deps.cwd ?? process.cwd(), env });
      client = new TfsClient({ ...tfsConfigFromEnv(env), fetchFn: deps.fetchFn });
    }
  } catch (e) {
    err(`Не удалось настроить доступ к трекеру: ${e.message}`);
    return 2;
  }

  try {
    switch (command) {
      case "check": return await cmdCheck(client, log);
      case "get": return await cmdGet(client, args, flags, log, err);
      case "query": return await cmdQuery(client, args, flags, log, err);
      case "comment": return await cmdComment(client, args, log, err);
      case "time": return await cmdTime(client, args, flags, log, err);
      case "link-pr": return await cmdLinkPr(client, args, flags, log, err);
      case "attach": return await cmdAttach(client, args, flags, log, err, readFile);
      case "state": return await cmdState(client, args, flags, log, err);
      default:
        err(`Неизвестная команда: ${command}`);
        err(usage());
        return 1;
    }
  } catch (e) {
    err(`Ошибка: ${e.message}`);
    return 2;
  }
}

// -- команды чтения -----------------------------------------------------------

async function cmdCheck(client, log) {
  const res = await client.verifyAccess();
  if (res.ok) {
    log("Доступ к трекеру есть.");
    return 0;
  }
  const hint = res.status === 401 ? "PAT истёк, не тот scope, или в файле остался BOM/пробел"
    : res.status === 403 ? "PAT валиден, но прав на операцию нет"
    : res.status === 0 ? "сервер недоступен: сеть или VPN"
    : "смотри ответ сервера";
  log(`Доступа нет: HTTP ${res.status} - ${hint}.`);
  return 1;
}

async function cmdGet(client, args, flags, log, err) {
  const id = args[0];
  if (!id) { err("Нужен id задачи: volna-tfs get <id>"); return 1; }

  const wi = await client.getWorkItem(id, true);
  if (flags.json) { log(JSON.stringify(wi, null, 2)); return 0; }

  const s = summarize(wi);
  const out = [`# ${s.id} ${s.title}`, ""];
  out.push(`тип: ${s.type} · состояние: ${s.state}` +
    `${s.assignedTo ? ` · на ком: ${s.assignedTo}` : ""}${s.area ? ` · область: ${s.area}` : ""}`);
  if (s.parent) out.push(`родитель: ${s.parent} (постановка часто там)`);
  if (s.children.length) out.push(`дочерние: ${s.children.join(", ")}`);

  const prs = pullRequestLinks(wi);
  if (prs.length) out.push(`связанные PR: ${prs.length}`);

  const attachments = (wi.relations ?? []).filter((r) => r.rel === "AttachedFile");
  if (attachments.length) {
    out.push("", "## Вложения");
    for (const a of attachments) {
      out.push(`- ${a.attributes?.name ?? "без имени"} - ${a.url}`);
    }
    out.push("(скачивать PAT'ом: анонимно трекер отдаёт 401)");
  }

  if (s.description) out.push("", "## Описание", s.description);
  if (s.repro) out.push("", "## Шаги воспроизведения", s.repro);
  if (s.history) out.push("", "## Обсуждение", s.history);

  const fields = wi.fields ?? {};
  const done = fields["Microsoft.VSTS.Scheduling.CompletedWork"];
  const estimate = fields["Microsoft.VSTS.Scheduling.OriginalEstimate"];
  if (done != null || estimate != null) {
    out.push("", `часы: списано ${done ?? 0}${estimate != null ? `, оценка ${estimate}` : ""}`);
  }

  if (!s.description && !s.repro && !s.history) {
    out.push("", "Текста нет ни в описании, ни в обсуждении - постановка может быть только в",
      "картинках-вложениях. Скачай их и посмотри, прежде чем спрашивать человека.");
  }

  log(out.join("\n"));
  return 0;
}

async function cmdQuery(client, args, flags, log, err) {
  const text = args.join(" ").trim();
  if (!text) {
    err("Нужен запрос: volna-tfs query <WIQL или условие после WHERE>");
    return 1;
  }

  const ids = await client.wiql(toWiql(text));
  if (!ids.length) { log("Ничего не найдено."); return 0; }
  if (flags.ids) { log(ids.join(",")); return 0; }

  const top = Number(flags.top);
  const shown = Number.isFinite(top) && top > 0 ? ids.slice(0, top) : ids;
  const items = await client.getWorkItems(shown);
  if (flags.json) { log(JSON.stringify(items, null, 2)); return 0; }

  // порядок сортировки задаёт запрос, а пакетное чтение его не обещает
  const byId = new Map(items.map((w) => [String(w.id), w]));
  const out = [`Найдено: ${ids.length}` +
    (shown.length < ids.length ? `, показано ${shown.length} (--top)` : ""), ""];
  for (const id of shown) {
    const wi = byId.get(String(id));
    if (!wi) { out.push(`- ${id} · нет доступа к задаче`); continue; }
    const s = summarize(wi);
    out.push(`- ${s.id} · ${s.type} · ${s.state}` +
      `${s.assignedTo ? ` · ${s.assignedTo}` : ""} · ${s.title}`);
  }
  if (shown.length < ids.length) {
    out.push("", "Показаны не все: подробности по остальным - уточни запрос или подними --top.");
  }
  log(out.join("\n"));
  return 0;
}

/** Условие после WHERE дополнить до полного WIQL; готовый SELECT уходит как есть. */
function toWiql(text) {
  if (/^\s*select\b/i.test(text)) return text;
  return `SELECT [System.Id] FROM WorkItems WHERE ${text} ORDER BY [System.Id] DESC`;
}

// -- команды записи (только с --confirm) --------------------------------------

async function cmdComment(client, args, log, err) {
  const id = args[0];
  const text = args.slice(1).join(" ");
  if (!id || !text) { err("Нужны id и текст: volna-tfs comment <id> <текст> --confirm"); return 1; }
  await client.addComment(id, markdownToTfsHtml(text));
  log(`Задача ${id}: комментарий добавлен.`);
  return 0;
}

async function cmdTime(client, args, flags, log, err) {
  const id = args[0];
  const hours = Number(String(args[1] ?? "").replace(",", "."));
  if (!id || !Number.isFinite(hours)) {
    err("Нужны id и часы: volna-tfs time <id> <часы> [--set] --confirm");
    return 1;
  }
  const FIELD = "Microsoft.VSTS.Scheduling.CompletedWork";
  let total = hours;
  if (!flags.set) {
    const wi = await client.getWorkItem(id);
    const current = Number(wi.fields?.[FIELD] ?? 0);
    total = (Number.isFinite(current) ? current : 0) + hours;
  }
  await client.updateWorkItem(id, client.fieldOps({ [FIELD]: total }));
  log(`Задача ${id}: списано часов - ${total}${flags.set ? " (заменено)" : ` (+${hours})`}.`);
  return 0;
}

async function cmdLinkPr(client, args, flags, log, err) {
  const id = args[0];
  const url = args[1];
  if (!id || !url) { err("Нужны id и URL: volna-tfs link-pr <id> <url> --confirm"); return 1; }
  // Гиперссылка, а не ArtifactLink: artifact-ссылку на PR не собрать из URL без id проекта и
  // репозитория, а гиперссылка работает всегда и видна в задаче так же.
  await client.updateWorkItem(id, [{
    op: "add",
    path: "/relations/-",
    value: { rel: "Hyperlink", url, attributes: { comment: flags.title || "Pull Request" } },
  }]);
  log(`Задача ${id}: ссылка на PR добавлена.`);
  return 0;
}

async function cmdAttach(client, args, flags, log, err, readFile) {
  const id = args[0];
  const file = args[1];
  if (!id || !file) {
    err("Нужны id и файл: volna-tfs attach <id> <файл> [--discussion] --confirm");
    return 1;
  }
  const bytes = readFile(file);
  const res = await client.addAttachment(id, basename(file), bytes, {
    comment: flags.comment || "",
    discussion: flags.discussion === true,
  });
  log(`Задача ${id}: вложение ${basename(file)} добавлено${flags.discussion ? " и встроено в обсуждение" : ""}.`);
  log(`url: ${res.url}`);
  return 0;
}

async function cmdState(client, args, flags, log, err) {
  const id = args[0];
  const state = args[1];
  if (!id || !state) {
    err("Нужны id и состояние: volna-tfs state <id> <состояние> [--assign <кому>] --confirm");
    return 1;
  }
  const fields = { "System.State": state };
  if (flags.assign) fields["System.AssignedTo"] = flags.assign;
  if (flags.reason) fields["System.Reason"] = flags.reason;
  await client.updateWorkItem(id, client.fieldOps(fields));
  log(`Задача ${id}: состояние -> ${state}` +
    `${flags.assign ? `, назначено ${flags.assign}` : ""}${flags.reason ? `, причина «${flags.reason}»` : ""}.`);
  log("Проверь в трекере: правила перехода состояний могут потребовать других полей (TF401320).");
  return 0;
}

// -- служебное ----------------------------------------------------------------

/** Что команда собиралась изменить - печатается вместо записи, когда нет --confirm. */
function describeIntent(command, args, flags) {
  const id = args[0] ?? "<id>";
  switch (command) {
    case "comment": return `Собирался добавить комментарий к задаче ${id}: «${args.slice(1).join(" ")}».`;
    case "time": return `Собирался ${flags.set ? "заменить" : "прибавить"} часы задачи ${id}: ${args[1]}.`;
    case "link-pr": return `Собирался привязать к задаче ${id} ссылку ${args[1]}.`;
    case "attach": return `Собирался приложить к задаче ${id} файл ${args[1]}.`;
    case "state": return `Собирался сменить состояние задачи ${id} на «${args[1]}»` +
      `${flags.assign ? ` и назначить ${flags.assign}` : ""}.`;
    default: return `Собирался изменить задачу ${id}.`;
  }
}

function usage() {
  return [
    "volna-tfs - CLI над трекером для «Волны». Запись только с --confirm.",
    "",
    "  check                                   проверить доступ",
    "  get <id> [--json]                       задача: поля, постановка, обсуждение, связи, вложения",
    "  query <запрос> [--top N] [--ids] [--json]   выборка WIQL; можно только условие после WHERE",
    "  comment <id> <текст> --confirm          комментарий в обсуждение",
    "  time <id> <часы> [--set] --confirm      списать часы (по умолчанию прибавить)",
    "  link-pr <id> <url> [--title T] --confirm    ссылка на PR",
    "  attach <id> <файл> [--discussion] [--comment T] --confirm",
    "  state <id> <состояние> [--assign кто] [--reason почему] --confirm",
    "",
    "Адреса и путь к файлу PAT - в .env рабочего репозитория (шаблон .env.example).",
  ].join("\n");
}

/**
 * Прямой запуск, а не импорт. Сравниваем сам файл, а не суффикс имени: суффикс совпадал и у
 * теста (test-volna-tfs.mjs), из-за чего CLI запускался при импорте и убивал тест.
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2)));
}

export { htmlToMarkdown };
