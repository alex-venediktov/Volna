/**
 * Общее для hooks «Волны»: чтение состояния задачи из .volna/**, минимальный парсер
 * frontmatter, вывод контекста. Без зависимостей и без сети.
 *
 * Правило для всех hooks: любая внутренняя ошибка - тихий выход 0. Hook не имеет права
 * ломать обычную работу; исключение одно - намеренный гейт (hooks/gate.mjs).
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

/** Прочитать JSON события с stdin. Пустой или битый вход - пустой объект. */
export async function readHookInput() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Найти каталог .volna вверх по дереву от cwd. Не нашли - null. */
export function findVolnaDir(startDir) {
  let dir = resolve(startDir || process.cwd());
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, ".volna");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** state.json: указатель на активную задачу и признак глушения. */
export function readState(volnaDir) {
  try {
    const raw = readFileSync(join(volnaDir, "state.json"), "utf8");
    const s = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return { active: s.active ? String(s.active) : null, muted: s.muted === true };
  } catch {
    return { active: null, muted: false };
  }
}

/**
 * Минимальный парсер YAML-frontmatter: скалярры, inline-списки [a, b] и блочные списки.
 * Полного YAML тут не нужно - формат журнала фиксирован шаблоном.
 */
export function parseFrontmatter(text) {
  const out = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  let listKey = null;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      out[listKey].push(stripQuotes(stripComment(item[1])));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const value = stripComment(kv[2]).trim();
    if (value === "") {
      out[key] = [];        // возможно блочный список; если ничего не придёт - останется []
      listKey = key;
      continue;
    }
    listKey = null;
    if (value.startsWith("[")) {
      out[key] = value.replace(/^\[|\]$/g, "").split(",")
        .map((v) => stripQuotes(v.trim())).filter(Boolean);
    } else {
      out[key] = stripQuotes(value);
    }
  }
  return out;
}

function stripComment(s) {
  // комментарий после значения; внутри кавычек # не трогаем
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") quoted = !quoted;
    if (c === "#" && !quoted) return s.slice(0, i);
  }
  return s;
}

function stripQuotes(s) {
  const t = String(s).trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
    ? t.slice(1, -1)
    : t;
}

/** Где искать лог итераций: свой каталог, затем прежние раскладки. Порядок = приоритет. */
function logCandidates(volnaDir, taskId) {
  return [
    join(volnaDir, "journal", "logs", `TASK-${taskId}.log.md`),
    join(volnaDir, "journal", `TASK-${taskId}.log.md`),
  ];
}

/**
 * Журнал активной задачи: состояние (frontmatter + «Состояние») из journal/TASK-<id>.md,
 * лог итераций из journal/logs/TASK-<id>.log.md. Прежние раскладки читаются как есть: лог рядом
 * с состоянием (0.1.26) и однофайловый журнал, где секции лежат в самом файле состояния.
 */
export function readJournal(volnaDir, taskId) {
  const path = join(volnaDir, "journal", `TASK-${taskId}.md`);
  if (!existsSync(path)) return null;
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const fm = parseFrontmatter(text);
  let logText = "";
  let logPath = null;
  for (const candidate of logCandidates(volnaDir, taskId)) {
    if (!existsSync(candidate)) continue;
    try {
      logText = readFileSync(candidate, "utf8");
      logPath = logText ? candidate : null;
      break;
    } catch { /* лог не читается - работаем по состоянию */ }
  }
  const sections = [...(logText || text).matchAll(/^##\s+([^\s·]+)/gm)].map((m) => m[1]);
  // Возраст журнала - по самой свежей из двух записей: запись этапа идёт в лог, резюме в состояние.
  let mtimeMs = 0;
  for (const p of [path, logPath]) {
    if (!p) continue;
    try {
      mtimeMs = Math.max(mtimeMs, statSync(p).mtimeMs);
    } catch { /* не критично */ }
  }
  return { path, logPath, fm, sections, mtimeMs, text, logText };
}

/**
 * Секция «## Состояние · <дата>» - переписываемое резюме журнала. Возвращает {stamp, body}
 * или null. Это то, с чего восстанавливается контекст; лог секций для hooks не нужен.
 */
export function readSummary(text) {
  // Разделитель «·» обязателен: иначе под резюме попадают заголовки вида
  // «## Состояние задачи на <дата>» из журналов, которые велись до этого формата.
  const m = /^##[ \t]+Состояние[ \t]*·[ \t]*(.*)$/m.exec(String(text || ""));
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^##[ \t]/m);
  return { stamp: m[1].trim(), body: (next < 0 ? rest : rest.slice(0, next)).trim() };
}

/** Метка времени последней секции лога «## <этап> · итерация N · <дата>». */
export function lastLogStamp(text) {
  const all = [...String(text || "").matchAll(/^##[ \t]+(?!Состояние)\S.*·[ \t]*([\d-]+[ \t]+[\d:]+)/gm)];
  return all.length ? all[all.length - 1][1].trim() : null;
}

/**
 * Резюме отстало от лога: секции нет вовсе или её метка старше последней записи.
 * Лог передаётся отдельным текстом; пустой означает журнал до разделения на два файла,
 * где секции лежат в том же файле, что и резюме.
 */
export function summaryLag(text, logText = "") {
  const summary = readSummary(text);
  if (!summary) return "missing";
  const last = lastLogStamp(logText || text);
  if (!last) return null;
  // Метка не читается как дата - свежесть недоказуема, поэтому просим перезаписать.
  if (!/^\d{4}-\d{2}-\d{2}[ T\t]+\d{1,2}:\d{2}/.test(summary.stamp)) return last;
  return normStamp(summary.stamp) < normStamp(last) ? last : null;   // формат сортируем как строку
}

function normStamp(s) {
  return String(s).replace(/[T\t ]+/g, " ").trim();
}

/**
 * Значение подпункта «**имя:** ...» из тела секции; многострочное склеивается в строку.
 * Без флага «m»: с ним «$» означал бы конец строки, и подпункт со значением на следующей
 * строке (нумерованный список) давал бы пустой захват.
 */
export function summaryField(body, name) {
  const re = new RegExp(`(?:^|\\n)\\*\\*${name}:\\*\\*[ \\t]*([\\s\\S]*?)(?=\\n\\*\\*|\\n##|$)`);
  const m = re.exec(String(body || ""));
  const value = m ? m[1].replace(/\s+/g, " ").trim() : "";
  return value || null;
}

/** Полное состояние: null, если задачи нет, каталога нет или сопровождение заглушено. */
export function loadActive(cwd, { respectMute = true } = {}) {
  const volnaDir = findVolnaDir(cwd);
  if (!volnaDir) return null;
  const state = readState(volnaDir);
  if (!state.active) return null;
  if (respectMute && state.muted) return null;
  const journal = readJournal(volnaDir, state.active);
  if (!journal) return null;
  return { volnaDir, task: state.active, muted: state.muted, ...journal };
}

/** Порядок этапов флоу - для позиции k/N в шапке. Коммит входит в deliver, своего этапа нет. */
export const STAGES = [
  "intake", "analyze", "spec", "plan", "implement", "advocate", "fixtures",
  "unit-tests", "visual", "deliver", "close", "cleanup", "capture",
];

/** Позиция этапа в флоу, 1-based; 0 - этап неизвестен. */
export function stagePosition(stage) {
  const i = STAGES.indexOf(String(stage || "").trim());
  return i < 0 ? 0 : i + 1;
}

/** Сколько минут назад файл менялся. */
export function minutesSince(mtimeMs, now = Date.now()) {
  if (!mtimeMs) return null;
  return Math.max(0, Math.round((now - mtimeMs) / 60000));
}

/**
 * Текущее время машины как «YYYY-MM-DD HH:MM» - формат метки журнала.
 * Локальное, не UTC: `toISOString` дал бы сдвиг на зону, и метки журнала
 * разошлись бы с mtime файла, по которому считается «журнал не дописан N мин».
 * Модель текущего времени не знает - в её промпте только дата, - поэтому метку
 * ей отдают hooks: иначе время в журнале приходится угадывать.
 */
export function localStamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
         `${p(now.getHours())}:${p(now.getMinutes())}`;
}

/** Список открытых пунктов, обрезанный до limit и до разумной длины строки. */
export function openItems(fm, limit = 3) {
  const open = Array.isArray(fm.open) ? fm.open : [];
  return open.filter(Boolean).slice(0, limit).map((s) => truncate(String(s), 90));
}

export function truncate(s, max) {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Отдать текст как дополнительный контекст события. */
export function emitContext(hookEventName, lines) {
  const text = (Array.isArray(lines) ? lines.filter(Boolean).join("\n") : String(lines)).trim();
  if (!text) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext: text },
  }));
}

/** Обёртка: любая ошибка внутри hook'а - тихий выход 0. */
export async function runQuietly(main) {
  try {
    await main();
  } catch {
    // намеренно молча: hook не должен мешать работе
  }
  process.exit(0);
}
