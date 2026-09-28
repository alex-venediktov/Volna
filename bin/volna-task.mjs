#!/usr/bin/env node
/**
 * CLI дерева задач «Волны»: заводит детей и передаёт им работу. Журналы и ссылки пишет код, а не
 * модель по шаблону - обе стороны связи появляются одним вызовом.
 *
 * Использование:
 *   volna-task add <родитель> --slug слова-через-дефис --title "заголовок" --goal "постановка"
 *              [--type task] [--date ГГММДД]   завести ребёнка в конец очереди родителя
 *   volna-task add <родитель> --tracker <id> [--url ссылка] --title ... --goal ...
 *                                             ребёнок - уже заведённый элемент трекера, id журнала - его id
 *   volna-task start <ребёнок>                ребёнок становится активной задачей, родитель ждёт детей
 *   volna-task done <задача>                  задача закрыта: у ребёнка активен снова родитель (ждёт детей
 *                                             или приёмка), у корня дерева активная задача снимается
 *   volna-task next [родитель]                первый открытый ребёнок по порядку; открытых нет - приёмка
 *   volna-task list                           незакрытые задачи по журналам
 *   volna-task migrate <задача>               части журнала -> дети: незакрытые - детьми <id>-p<N>,
 *                                             закрытые и снятые - строкой в «сделано»
 *
 * Каталог `.volna` ищется вверх от рабочего до корня репозитория.
 * Коды возврата: 0 сделано, 1 отказ (ничего не записано), 3 сбой инструмента.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { childIds, findVolnaDir, isOpenStatus, localStamp, openTasks, parseFrontmatter, partsProgress, readNode, readSummary, safeTaskId, statusLabel, taskStatus }
  from "../hooks/lib/volna-state.mjs";

/** Slug ребёнка: латиница и цифры словами через дефис (`stages/intake.md`, шаг 4). */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+){0,5}$/;

/** Id задачи трекера: номер из 4-6 цифр либо ключ `ABC-1234` (`commands/task.md`). */
const TRACKER_ID = /^(?:\d{4,6}|[A-Za-z][A-Za-z0-9_]*-\d+)$/;

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
export function childJournal({ id, title, goal, type, parent, repos, now, url = null }) {
  const stamp = localStamp(now);
  const iso = stamp.replace(" ", "T");
  const tracked = url !== null;
  return [
    "---",
    `task: ${id}`,
    `title: ${quoted(title)}`,
    `type: ${type}`,
    `mode: ${tracked ? "tracker" : "local"}`,
    `tracker: ${quoted(url ?? "")}`,
    tracked ? "source:" : "source: текст в журнале",
    `parent: ${parent}`,
    "children: []",
    "status: новая",
    "fix_task:",
    "branch:",
    `repos: [${repos.join(", ")}]`,
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
    tracked
      ? "1. приём (`intake`): элемент трекера - командой из `trackers/<трекер>/intake.md`, «цель» - к постановке, дальше `analyze`."
      : "1. приём (`intake`): постановка из «цели» - в `вход:` лога дословно, дальше `analyze`.",
    "",
  ].join("\n");
}

/** Этапы, на которых у задачи с частями текущая часть не начата либо уже убрана: граница частей. */
const PART_BOUNDARY = new Set(["cleanup", "intake"]);

/**
 * Перевод «Состояния» с частей на детей: `**части:**` уходит, закрытые части ложатся строкой
 * в «сделано», «следующий шаг» ведёт к первому ребёнку. Null - секции «Состояние» нет.
 */
export function migratedSummary(text, { stamp, doneLines, firstChild }) {
  const head = /^##[ \t]+Состояние[ \t]*·[ \t]*.*$/m.exec(text);
  if (!head) return null;
  const start = head.index + head[0].length;
  const next = text.slice(start).search(/^##[ \t]/m);
  const bodyEnd = next < 0 ? text.length : start + next;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.slice(start, bodyEnd).split(/\r?\n/);
  const find = (name) => lines.findIndex((l) => l.startsWith(`**${name}:**`) || l.startsWith(`**${name} `));
  // Конец подпункта: следующий подпункт, иначе конец секции без хвостовых пустых строк.
  const blockEnd = (i) => {
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith("**")) j++;
    while (j > i + 1 && !lines[j - 1].trim()) j--;
    return j;
  };
  const parts = find("части");
  if (parts >= 0) lines.splice(parts, blockEnd(parts) - parts);
  if (doneLines.length) {
    const history = `до перевода на детей: ${doneLines.join("; ")}.`;
    const done = find("сделано");
    if (done >= 0) lines.splice(blockEnd(done), 0, history);
    else {
      const goal = find("цель");
      lines.splice(goal >= 0 ? blockEnd(goal) : Math.min(1, lines.length), 0, `**сделано:** ${history}`);
    }
  }
  const step = ["**следующий шаг:**", `1. \`/volna:task\` без аргумента - возьмёт первого ребёнка, ${firstChild}.`];
  const ns = find("следующий шаг");
  if (ns >= 0) lines.splice(ns, blockEnd(ns) - ns, ...step);
  else {
    let end = lines.length;
    while (end > 0 && !lines[end - 1].trim()) end--;
    lines.splice(end, 0, ...step);
  }
  return `${text.slice(0, head.index)}## Состояние · ${stamp}${lines.join(eol)}${text.slice(bodyEnd)}`;
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
    log("volna-task add <родитель> --tracker id [--url ссылка] --title t --goal g [--type task]");
    log("volna-task start <ребёнок>");
    log("volna-task done <задача>");
    log("volna-task next [родитель]");
    log("volna-task list");
    log("volna-task migrate <задача>");
    return 0;
  }
  if (!["add", "start", "done", "next", "list", "migrate"].includes(command)) { err(`неизвестная команда: ${command}`); return 3; }

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
    const tracker = flags.tracker === undefined ? "" : String(flags.tracker).trim();
    const title = String(flags.title ?? "").trim();
    const goal = String(flags.goal ?? "").trim();
    if (!safeTaskId(parent)) { err(`родитель «${parent}» не годится в id задачи`); return 1; }
    if (flags.slug !== undefined && flags.tracker !== undefined) { err("--slug и --tracker вместе: ребёнок либо локальный, либо элемент трекера"); return 1; }
    if (flags.tracker !== undefined && !TRACKER_ID.test(tracker)) { err(`id трекера «${tracker}» не годится: номер 4-6 цифр либо ключ ABC-1234`); return 1; }
    if (flags.tracker === undefined && !SLUG.test(slug)) { err(`slug «${slug}» не годится: латиница и цифры словами через дефис`); return 1; }
    if (flags.url !== undefined && flags.tracker === undefined) { err("--url только вместе с --tracker: у локального ребёнка ссылки нет"); return 1; }
    if (flags.url === true) { err("--url без ссылки"); return 1; }
    if (!title || flags.title === true) { err("не назван заголовок (--title)"); return 1; }
    if (!goal || flags.goal === true) { err("не названа постановка (--goal)"); return 1; }
    const date = flags.date ? String(flags.date) : idDate(now);
    if (!tracker && !/^\d{6}$/.test(date)) { err(`дата «${date}» не в виде ГГММДД`); return 1; }

    const parentText = readFile(journalPath(parent));
    if (parentText == null) { err(`у родителя ${parent} нет журнала в .volna/journal`); return 1; }
    const pfm = parseFrontmatter(parentText);
    const { status } = taskStatus(pfm, parent === active);
    if (status === "закрыта" || status === "снята") { err(`родитель ${parent} ${status} - детей ему не заводят`); return 1; }
    const id = tracker || `${date}-${slug}`;
    const children = childIds(pfm);
    if (children.includes(id) || readFile(journalPath(id)) != null) { err(`id ${id} занят: ${tracker ? "журнал элемента уже заведён" : "выбери другой slug"}`); return 1; }

    const type = flags.type && flags.type !== true ? String(flags.type) : "task";
    const repos = Array.isArray(pfm.repos) ? pfm.repos : [];
    const withChild = setField(setField(parentText, "children", `[${[...children, id].join(", ")}]`, "parent"), "updated", iso);
    if (withChild == null) { err(`журнал ${parent} без frontmatter`); return 1; }
    const url = tracker ? String(flags.url ?? "") : null;
    writeFile(journalPath(id), childJournal({ id, title, goal, type, parent, repos, now, url }));
    writeFile(journalPath(parent), withChild);
    log(`заведён ${id} - ребёнок ${children.length + 1} задачи ${parent}${tracker ? ", элемент трекера" : ""}`);
    return 0;
  }

  const readTask = (id) => {
    const text = safeTaskId(id) ? readFile(journalPath(id)) : null;
    return text == null ? null : { id, text, fm: parseFrontmatter(text) };
  };
  const nodeOf = (id) => readNode(volnaDir, id, active, readFile);
  const openChildren = (fm, except = "") => childIds(fm)
    .filter((id) => id !== except)
    .map(nodeOf)
    .filter((node) => !node.external && isOpenStatus(node.status));
  const writeState = (id) => writeFile(statePath, `${JSON.stringify({ ...state, active: id, updated: iso }, null, 2)}\n`);
  const foreign = (...own) => (active && !own.includes(active) ? active : "");
  /** Ребёнок становится активным: снимается только `новая`, родитель ждёт детей. */
  const activate = (c, p) => {
    const started = taskStatus(c.fm, false).status === "новая" ? setField(c.text, "status", "") : c.text;
    writeFile(journalPath(c.id), setField(started, "updated", iso));
    writeFile(journalPath(p.id), setField(setField(p.text, "status", "ждёт детей", "children"), "updated", iso));
    writeState(c.id);
  };

  if (command === "migrate") {
    const id = String(args[0] ?? "").trim();
    const task = readTask(id);
    if (!task) { err(`у задачи «${id}» нет журнала в .volna/journal`); return 1; }
    const { status } = taskStatus(task.fm, id === active);
    if (status === "закрыта" || status === "снята") { err(`задача ${id} ${status} - переводить нечего`); return 1; }
    const body = readSummary(task.text)?.body ?? "";
    const progress = partsProgress(body);
    if (!progress) { err(`у задачи ${id} нет списка **части:** в «Состоянии» - переводить нечего`); return 1; }
    const unnamed = progress.items.find((it) => it.state === "не названо");
    if (unnamed) { err(`часть ${unnamed.n} без состояния из списка (не начата, в работе, сделано, снята): поправь строку`); return 1; }
    const open = progress.items.filter((it) => it.state === "не начата" || it.state === "в работе");
    if (!open.length) { err(`у задачи ${id} нет незакрытых частей: она закрывается обычным close`); return 1; }
    const stage = String(task.fm.stage ?? "").trim();
    const passed = Array.isArray(task.fm.stages_done) ? task.fm.stages_done : [];
    if (progress.current && !PART_BOUNDARY.has(stage) && passed.length) {
      err(`задача ${id} на этапе ${stage}: часть ${progress.current.n} в работе - довести её до deliver и отметить сделанной, затем перевести`); return 1;
    }
    const kids = open.map((it) => ({ ...it, id: `${id}-p${it.n}` }));
    const children = childIds(task.fm);
    const busy = kids.find((k) => children.includes(k.id) || readFile(journalPath(k.id)) != null);
    if (busy) { err(`id ${busy.id} занят: журнал уже есть`); return 1; }

    // Закрытые части - строкой как в списке, с датой и часами.
    const rawLines = body.split(/\r?\n/).map((l) => l.trim());
    const doneLines = progress.items.filter((it) => !open.includes(it))
      .map((it) => rawLines.find((l) => l.startsWith(`${it.n}.`) || l.startsWith(`${it.n})`)) ?? `${it.n}. ${it.title} - ${it.state}`);
    const summary = migratedSummary(task.text, { stamp, doneLines, firstChild: kids[0].id });
    if (summary == null) { err(`у задачи ${id} нет секции «Состояние»`); return 1; }
    let parentText = setField(summary, "children", `[${[...children, ...kids.map((k) => k.id)].join(", ")}]`, "parent");
    if (parentText == null) { err(`журнал ${id} без frontmatter`); return 1; }
    for (const key of ["part", "parts"]) if (key in task.fm) parentText = setField(parentText, key, "");
    // Остаток ушёл в детей: своей работы у задачи нет, `/volna:task` без аргумента возьмёт ребёнка.
    parentText = setField(setField(parentText, "status", "ждёт детей", "children"), "updated", iso);

    const type = task.fm.type ? String(task.fm.type) : "task";
    const repos = Array.isArray(task.fm.repos) ? task.fm.repos : [];
    for (const k of kids) {
      const goal = `${k.title} - часть ${k.n} задачи ${id} до перевода на детей; постановка и критерии части - лог ${id}, секции spec.`;
      writeFile(journalPath(k.id), childJournal({ id: k.id, title: k.title, goal, type, parent: id, repos, now }));
    }
    writeFile(journalPath(id), parentText);
    log(`задача ${id} переведена на детей: ${kids.map((k) => k.id).join(", ")}` +
      `${doneLines.length ? `; закрытых частей в «сделано»: ${doneLines.length}` : ""}`);
    return 0;
  }

  if (command === "list") {
    const tasks = openTasks(volnaDir, active, new Set(), { listDir: deps.listDir ?? ((d) => readdirSync(d)), read: readFile });
    if (!tasks.length) { log("незакрытых задач нет"); return 0; }
    for (const node of tasks) {
      log(`${node.id}${node.title ? ` ${node.title}` : ""} - ${statusLabel(node)}` +
        `${node.stage ? ` · этап ${node.stage}` : ""}${node.updated ? ` · ${node.updated}` : ""}` +
        `${node.id === active ? "  <- активна" : ""}`);
    }
    return 0;
  }

  if (command === "next") {
    const id = String(args[0] ?? active).trim();
    const parent = readTask(id);
    if (!parent) { err(`у задачи «${id}» нет журнала в .volna/journal`); return 1; }
    if (foreign(parent.id)) { err(`активна другая задача ${active}: следующего ребёнка берут у активной`); return 1; }
    if (!childIds(parent.fm).length) { err(`у задачи ${parent.id} нет детей`); return 1; }
    for (const node of childIds(parent.fm).map(nodeOf)) {
      if (node.external) log(`ребёнок ${node.id} без журнала - пропущен`);
    }
    const next = openChildren(parent.fm)[0];
    if (!next) {
      writeFile(journalPath(parent.id), setField(setField(parent.text, "status", "приёмка", "children"), "updated", iso));
      if (!active) writeState(parent.id);
      log(`детей не осталось: ${parent.id} - приёмка`);
      return 0;
    }
    const child = readTask(next.id);
    activate(child, parent);
    log(`активна ${child.id}; родитель ${parent.id} ждёт детей`);
    return 0;
  }

  const child = readTask(String(args[0] ?? "").trim());
  if (!child) { err(`у задачи «${String(args[0] ?? "").trim()}» нет журнала в .volna/journal`); return 1; }
  const parentId = String(child.fm.parent ?? "").trim();
  const parent = readTask(parentId);
  const unlinked = () => err(`родитель ${parent.id} не перечисляет ${child.id} в children: поправь связь`);

  if (command === "done") {
    if (foreign(child.id)) { err(`активна другая задача ${active}: закрывают активную`); return 1; }
    if (parent && !childIds(parent.fm).includes(child.id)) { unlinked(); return 1; }
    const mine = openChildren(child.fm);
    if (mine.length) { err(`у ${child.id} открыты дети (${mine.map((n) => n.id).join(", ")}): сначала они, потом приёмка`); return 1; }
    const own = taskStatus(child.fm, true).status;
    const closed = own === "снята" ? child.text : setField(child.text, "status", "закрыта", "children");
    if (!parent) {
      // Корень дерева: родителя нет или он внешний - активная задача снимается (`stages/cleanup.md`, шаг 2)
      writeFile(journalPath(child.id), setField(closed, "updated", iso));
      writeFile(statePath, `${JSON.stringify({ ...state, active: undefined, updated: iso }, null, 2)}\n`);
      log(`${child.id} ${own === "снята" ? "снята" : "закрыта"}; активной задачи нет` +
        `${parentId ? `; родитель ${parentId} без журнала - внешний` : ""}`);
      return 0;
    }
    const left = openChildren(parent.fm, child.id);
    const status = left.length ? "ждёт детей" : "приёмка";
    writeFile(journalPath(child.id), setField(closed, "updated", iso));
    writeFile(journalPath(parent.id), setField(setField(parent.text, "status", status, "children"), "updated", iso));
    writeState(parent.id);
    log(`${child.id} ${own === "снята" ? "снята" : "закрыта"}; активна ${parent.id} - ${status}` +
      `${left.length ? `, следующий ${left[0].id}` : ""}`);
    return 0;
  }

  if (!parent) { err(`у задачи ${child.id} нет родителя с журналом - это не ребёнок`); return 1; }
  if (!childIds(parent.fm).includes(child.id)) { unlinked(); return 1; }
  const own = taskStatus(child.fm, false).status;
  if (!isOpenStatus(own)) { err(`задача ${child.id} ${own} - начинать нечего`); return 1; }
  if (foreign(parent.id, child.id)) {
    err(`активна другая задача ${active}: сначала закрыть её или решить, что берём поверх`);
    return 1;
  }
  activate(child, parent);
  log(`активна ${child.id}; родитель ${parent.id} ждёт детей`);
  return 0;
}

/** Прямой запуск, а не импорт: сравниваем сам файл, иначе CLI стартует при импорте из теста. */
if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2)));
}
