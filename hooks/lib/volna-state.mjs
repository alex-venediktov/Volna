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

/** Журнал активной задачи: путь, frontmatter, заголовки секций, mtime. */
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
  const sections = [...text.matchAll(/^##\s+([^\s·]+)/gm)].map((m) => m[1]);
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch { /* не критично */ }
  return { path, fm, sections, mtimeMs, text };
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

/** Порядок этапов флоу - для позиции k/13 в шапке. */
export const STAGES = [
  "intake", "analyze", "spec", "plan", "implement", "advocate", "fixtures",
  "unit-tests", "visual", "commit", "push-pr", "close", "capture",
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
