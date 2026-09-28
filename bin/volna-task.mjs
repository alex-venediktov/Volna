#!/usr/bin/env node
/**
 * CLI дерева задач «Волны»: заводит детей и передаёт им работу. Журналы и ссылки пишет код, а не
 * модель по шаблону - обе стороны связи появляются одним вызовом.
 *
 * Использование:
 *   volna-task add <родитель> --slug слова-через-дефис --title "заголовок" --goal "постановка"
 *              [--type task] [--date ГГММДД]   завести ребёнка в конец очереди родителя
 *   volna-task start <ребёнок>                ребёнок становится активной задачей, родитель ждёт детей
 *
 * Каталог `.volna` ищется вверх от рабочего до корня репозитория.
 * Коды возврата: 0 сделано, 1 отказ (ничего не записано), 3 сбой инструмента.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { childIds, findVolnaDir, localStamp, parseFrontmatter, safeTaskId, taskStatus } from "../hooks/lib/volna-state.mjs";

/** Slug ребёнка: латиница и цифры словами через дефис (`stages/intake.md`, шаг 4). */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+){0,5}$/;

/** Разбор аргументов: команда, свободные слова и флаги `--имя значение` либо `--имя=значение`. */
export function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { args.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[a.slice(2)] = next; i++; }
    else flags[a.slice(2)] = true;
  }
  return { command: args.shift(), args, flags };
}

/** Дата для id ребёнка: ГГММДД по часам машины (`stages/intake.md`, шаг 4). */
export function idDate(now) {
  const p = (n) => String(n).padStart(2, "0");
  return `${String(now.getFullYear()).slice(2)}${p(now.getMonth() + 1)}${p(now.getDate())}`;
}

/** Позиция комментария в значении строки frontmatter; внутри кавычек `#` не считается. */
function commentAt(s) {
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"' || s[i] === "'") quoted = !quoted;
    if (s[i] === "#" && !quoted) return i;
  }
  return -1;
}

/**
 * Записать поле frontmatter: строка поля заменяется с сохранением хвостового комментария, элементы
 * блочного списка под ней убираются; поля нет - вставляется после `after`, иначе в конец. Нет frontmatter - null.
 */
export function setField(text, key, value, after = null) {
  const m = /^---(\r?\n)([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const eol = m[1];
  const lines = m[2].split(/\r?\n/);
  const own = new RegExp(`^${key}:(.*)$`);
  const line = value === "" ? `${key}:` : `${key}: ${value}`;
  const at = lines.findIndex((l) => own.test(l));
  if (at >= 0) {
    const rest = own.exec(lines[at])[1];
    const c = commentAt(rest);
    const col = key.length + 1 + c;
    lines[at] = c >= 0 ? `${line.length < col ? line.padEnd(col) : `${line} `}${rest.slice(c)}` : line;
    let end = at + 1;
    while (end < lines.length && /^\s*-\s/.test(lines[end])) end++;
    lines.splice(at + 1, end - at - 1);
  } else {
    const anchor = after ? lines.findIndex((l) => new RegExp(`^${after}:`).test(l)) : -1;
    lines.splice(anchor >= 0 ? anchor + 1 : lines.length, 0, line);
  }
  return `---${eol}${lines.join(eol)}${eol}---${text.slice(m[0].length)}`;
}

/** Строка для YAML-значения в кавычках: пробелы и переводы строк - одним пробелом, двойная кавычка - одинарной. */
function quoted(s) {
  return `"${String(s).replace(/\s+/g, " ").replace(/"/g, "'")}"`;
}

/** Журнал нового ребёнка: frontmatter по шаблону журнала, постановка - в «цели» (`volna-journal/templates`). */
export function childJournal({ id, title, goal, type, parent, repos, now }) {
  const stamp = localStamp(now);
  const iso = stamp.replace(" ", "T");
  return [
    "---",
    `task: ${id}`,
    `title: ${quoted(title)}`,
    `type: ${type}`,
    "mode: local",
    'tracker: ""',
    "source: текст в журнале",
    `parent: ${parent}`,
    "children: []",
    "status: новая",
    "fix_task:",
    "branch:",
    `repos: [${repos.join(", ")}]`,
    "part:",
    "parts:",
    "stage: intake",
    "stages_done: []",
    "skipped: []",
    "open: []",
    `started: ${iso}`,
    `updated: ${iso}`,
    "---",
    "",
    `# ${id} — ${title.replace(/\s+/g, " ")}`,
    "",
    `## Состояние · ${stamp}`,
    "",
    `**цель:** ${goal}`,
    `**сделано:** не начата - заведена разделением задачи ${parent}.`,
    "**следующий шаг:**",
    "1. приём (`intake`): постановка из «цели» - в `вход:` лога дословно, дальше `analyze`.",
    "",
  ].join("\n");
}

export async function run(argv, deps = {}) {
  const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  const readFile = deps.readFile ?? ((p) => { try { return readFileSync(p, "utf8"); } catch { return null; } });
  const writeFile = deps.writeFile ?? ((p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t, "utf8"); });
  const now = deps.now ?? new Date();

  const { command, args, flags } = parseArgs(argv);
  if (!command || command === "help" || flags.help) {
    log("volna-task add <родитель> --slug s --title t --goal g [--type task] [--date ГГММДД]");
    log("volna-task start <ребёнок>");
    return 0;
  }
  if (command !== "add" && command !== "start") { err(`неизвестная команда: ${command}`); return 3; }

  const volnaDir = deps.volnaDir ?? findVolnaDir(deps.cwd ?? process.cwd());
  if (!volnaDir || (!deps.volnaDir && !existsSync(volnaDir))) { err("каталог .volna не найден: «Волна» здесь не развёрнута"); return 3; }
  const journalPath = (id) => join(volnaDir, "journal", `TASK-${id}.md`);
  const stamp = localStamp(now);
  const iso = stamp.replace(" ", "T");
  const statePath = join(volnaDir, "state.json");
  const rawState = readFile(statePath);
  let state = {};
  if (rawState != null) {
    try {
      state = JSON.parse(rawState.charCodeAt(0) === 0xfeff ? rawState.slice(1) : rawState);
    } catch {
      err("state.json не читается как JSON: поправь его руками"); return 1;
    }
  }
  const active = state.active ? String(state.active) : "";

  if (command === "add") {
    const parent = String(args[0] ?? "").trim();
    const slug = String(flags.slug ?? "").trim();
    const title = String(flags.title ?? "").trim();
    const goal = String(flags.goal ?? "").trim();
    if (!safeTaskId(parent)) { err(`родитель «${parent}» не годится в id задачи`); return 1; }
    if (!SLUG.test(slug)) { err(`slug «${slug}» не годится: латиница и цифры словами через дефис`); return 1; }
    if (!title || flags.title === true) { err("не назван заголовок (--title)"); return 1; }
    if (!goal || flags.goal === true) { err("не названа постановка (--goal)"); return 1; }
    const date = flags.date ? String(flags.date) : idDate(now);
    if (!/^\d{6}$/.test(date)) { err(`дата «${date}» не в виде ГГММДД`); return 1; }

    const parentText = readFile(journalPath(parent));
    if (parentText == null) { err(`у родителя ${parent} нет журнала в .volna/journal`); return 1; }
    const pfm = parseFrontmatter(parentText);
    const { status } = taskStatus(pfm, parent === active);
    if (status === "закрыта" || status === "снята") { err(`родитель ${parent} ${status} - детей ему не заводят`); return 1; }
    const id = `${date}-${slug}`;
    const children = childIds(pfm);
    if (children.includes(id) || readFile(journalPath(id)) != null) { err(`id ${id} занят: выбери другой slug`); return 1; }

    const type = flags.type && flags.type !== true ? String(flags.type) : "task";
    const repos = Array.isArray(pfm.repos) ? pfm.repos : [];
    const withChild = setField(setField(parentText, "children", `[${[...children, id].join(", ")}]`, "parent"), "updated", iso);
    if (withChild == null) { err(`журнал ${parent} без frontmatter`); return 1; }
    writeFile(journalPath(id), childJournal({ id, title, goal, type, parent, repos, now }));
    writeFile(journalPath(parent), withChild);
    log(`заведён ${id} - ребёнок ${children.length + 1} задачи ${parent}`);
    return 0;
  }

  const child = String(args[0] ?? "").trim();
  if (!safeTaskId(child)) { err(`ребёнок «${child}» не годится в id задачи`); return 1; }
  const childText = readFile(journalPath(child));
  if (childText == null) { err(`у задачи ${child} нет журнала в .volna/journal`); return 1; }
  const cfm = parseFrontmatter(childText);
  const parent = String(cfm.parent ?? "").trim();
  const parentText = safeTaskId(parent) ? readFile(journalPath(parent)) : null;
  if (!safeTaskId(parent) || parentText == null) { err(`у задачи ${child} нет родителя с журналом - это не ребёнок`); return 1; }
  const pfm = parseFrontmatter(parentText);
  if (!childIds(pfm).includes(child)) { err(`родитель ${parent} не перечисляет ${child} в children: поправь связь`); return 1; }
  const own = taskStatus(cfm, false).status;
  if (own === "закрыта" || own === "снята") { err(`задача ${child} ${own} - начинать нечего`); return 1; }

  if (active && active !== parent && active !== child) {
    err(`активна другая задача ${active}: сначала закрыть её или решить, что берём поверх`);
    return 1;
  }

  const started = own === "новая" ? setField(childText, "status", "") : childText;
  writeFile(journalPath(child), setField(started, "updated", iso));
  writeFile(journalPath(parent), setField(setField(parentText, "status", "ждёт детей", "children"), "updated", iso));
  writeFile(statePath, `${JSON.stringify({ ...state, active: child, updated: iso }, null, 2)}\n`);
  log(`активна ${child}; родитель ${parent} ждёт детей`);
  return 0;
}

/** Прямой запуск, а не импорт: сравниваем сам файл, иначе CLI стартует при импорте из теста. */
if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2)));
}
