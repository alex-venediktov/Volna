#!/usr/bin/env node
/**
 * Замер расхода токенов задачи «Волны» по секциям её лога: ходы модели берутся из логов сессий
 * Claude Code этого репозитория, метка секции закрывает её интервал (секция пишется, когда этап
 * сделан). Ход между метками относится к первой секции, чья метка не раньше хода.
 *
 * Использование:
 *   volna-cost <задача> [--until now|"ГГГГ-ММ-ДД ЧЧ:ММ"] [--session <id>] [--dir <каталог>] [--json]
 *
 * Окно - от `started` журнала до последней метки лога; `--until` продлевает его, и ходы после
 * последней метки идут строкой «после записи». Каталог логов по умолчанию -
 * ~/.claude/projects/<путь репозитория, всё кроме букв и цифр -> '-'> (`CLAUDE_CONFIG_DIR`
 * заменяет ~/.claude). Учитываются все сессии окна, их список печатается: параллельная сессия
 * в том же репозитории попадёт в замер, `--session` его ограничивает.
 *
 * Коды возврата: 0 сделано, 1 отказ (нет журнала, нет меток), 3 сбой (нет каталога логов).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { findVolnaDir, parseFrontmatter, safeTaskId } from "../hooks/lib/volna-state.mjs";
import { parseArgs } from "./volna-task.mjs";

const MINUTE = 60_000;

/** Имя каталога логов проекта: путь репозитория, где всё кроме букв и цифр заменено на '-'. */
export function projectDirName(repoRoot) {
  return String(repoRoot).replace(/[^A-Za-z0-9]/g, "-");
}

/** Метка журнала «ГГГГ-ММ-ДД ЧЧ:ММ» (или через T) в миллисекунды по местному времени; иначе null. */
export function parseStamp(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T\t]+(\d{1,2}):(\d{2})/.exec(String(s ?? "").trim());
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
}

/** Секции лога «## <этап> · итерация N · <метка>» по порядку файла, с меткой в миллисекундах. */
export function logSections(logText) {
  const re = /^##[ \t]+(?!Состояние)([^\s·]+)(.*)·[ \t]*(\d{4}-\d{2}-\d{2}[ \t]+\d{1,2}:\d{2})[ \t]*$/gm;
  const out = [];
  for (const m of String(logText ?? "").matchAll(re)) {
    const iter = /итерация[ \t]+(\d+)/.exec(m[2]);
    out.push({ label: iter ? `${m[1]}·${iter[1]}` : m[1], at: parseStamp(m[3]) });
  }
  return out;
}

/** Ходы модели из текста jsonl: запись assistant с usage; повтор одного сообщения - одна запись. */
export function parseTurns(text, { session, sub = false } = {}) {
  const turns = [];
  let skipped = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== "assistant") continue;
    const u = e.message?.usage;
    const at = Date.parse(e.timestamp ?? "");
    if (!u || Number.isNaN(at)) { skipped++; continue; }
    turns.push({
      id: e.message?.id ?? e.requestId ?? e.uuid,
      at, session, sub,
      input: u.input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
    });
  }
  return { turns, skipped };
}

/** Пустая строка таблицы. */
function row(label) {
  return { label, turns: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, context: 0, subTurns: 0, subTokens: 0 };
}

/**
 * Раскладка ходов по секциям. Метка точна до минуты, поэтому секция закрывается концом своей
 * минуты; ход позже последней секции, но до `until` - в строку «после записи».
 */
export function attribute(sections, turns, from, until) {
  // Секции одной метки (автопроход пишет их одной минутой) неразличимы по времени - одна строка.
  const ordered = [];
  for (const s of sections.filter((x) => x.at != null).sort((a, b) => a.at - b.at)) {
    const prev = ordered[ordered.length - 1];
    if (prev && prev.at === s.at) prev.label += ` + ${s.label}`;
    else ordered.push({ ...s });
  }
  const rows = ordered.map((s) => row(s.label));
  const after = row("после записи");
  const seen = new Set();
  const sessions = new Map();
  for (const t of [...turns].sort((a, b) => a.at - b.at)) {
    if (t.at < from || t.at >= until) continue;
    if (t.id && seen.has(t.id)) continue;
    if (t.id) seen.add(t.id);
    const i = ordered.findIndex((s) => t.at < s.at + MINUTE);
    const r = i < 0 ? after : rows[i];
    if (t.sub) {
      r.subTurns++;
      r.subTokens += t.input + t.cacheWrite + t.cacheRead + t.output;
    } else {
      r.turns++;
      r.input += t.input;
      r.cacheWrite += t.cacheWrite;
      r.cacheRead += t.cacheRead;
      r.output += t.output;
      r.context = Math.max(r.context, t.input + t.cacheWrite + t.cacheRead);
    }
    const s = sessions.get(t.session) ?? { turns: 0, subTurns: 0 };
    if (t.sub) s.subTurns++; else s.turns++;
    sessions.set(t.session, s);
  }
  if (after.turns || after.subTurns) rows.push(after);
  const total = row("итого");
  for (const r of rows) {
    for (const k of ["turns", "input", "cacheWrite", "cacheRead", "output", "subTurns", "subTokens"]) total[k] += r[k];
    total.context = Math.max(total.context, r.context);
  }
  return { rows, total, sessions };
}

/** Число токенов коротко: 950, 18.9k, 2.18M. */
export function fmt(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Таблица замера текстом: выравнивание пробелами, первая колонка влево, остальные вправо. */
function table(rows, total) {
  const head = ["секция", "ходов", "ввод", "запись кэша", "чтение кэша", "вывод", "контекст макс", "подагенты"];
  const line = (r) => [r.label, String(r.turns), fmt(r.input), fmt(r.cacheWrite), fmt(r.cacheRead), fmt(r.output),
    fmt(r.context), r.subTurns ? `${r.subTurns} / ${fmt(r.subTokens)}` : "-"];
  const cells = [head, ...rows.map(line), line(total)];
  const width = head.map((_, i) => Math.max(...cells.map((c) => c[i].length)));
  return cells.map((c) => c.map((v, i) => (i ? v.padStart(width[i]) : v.padEnd(width[i]))).join("  ").trimEnd());
}

export async function run(argv, deps = {}) {
  const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  const readFile = deps.readFile ?? ((p) => { try { return readFileSync(p, "utf8"); } catch { return null; } });
  const listDir = deps.listDir ?? ((p) => { try { return readdirSync(p); } catch { return null; } });
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();

  const { args, flags, command } = parseArgs(argv);
  // --json без значения: слово после него - id задачи, а не значение флага.
  if (typeof flags.json === "string") { args.unshift(flags.json); flags.json = true; }
  const taskId = command ?? args.shift();
  if (!taskId || taskId === "help" || flags.help) {
    log('volna-cost <задача> [--until now|"ГГГГ-ММ-ДД ЧЧ:ММ"] [--session <id>] [--dir <каталог>] [--json]');
    return 0;
  }
  if (args.length || !safeTaskId(taskId)) { err(`не id задачи: ${[taskId, ...args].join(" ")}`); return 1; }

  const volnaDir = deps.volnaDir ?? findVolnaDir(deps.cwd ?? process.cwd());
  if (!volnaDir || (!deps.volnaDir && !existsSync(volnaDir))) { err("каталог .volna не найден: «Волна» здесь не развёрнута"); return 3; }
  const stateText = readFile(join(volnaDir, "journal", `TASK-${taskId}.md`));
  if (stateText == null) { err(`журнала TASK-${taskId}.md нет`); return 1; }
  const logText = readFile(join(volnaDir, "journal", "logs", `TASK-${taskId}.log.md`))
    ?? readFile(join(volnaDir, "journal", `TASK-${taskId}.log.md`)) ?? stateText;
  const sections = logSections(logText).filter((s) => s.at != null);
  if (!sections.length) { err(`в логе ${taskId} нет секций с меткой времени`); return 1; }

  const fm = parseFrontmatter(stateText);
  const first = Math.min(...sections.map((s) => s.at));
  const from = Math.min(parseStamp(fm.started) ?? first, first);
  const last = Math.max(...sections.map((s) => s.at)) + MINUTE;
  let until = last;
  if (flags.until === "now") until = now.getTime();
  else if (typeof flags.until === "string") {
    const u = parseStamp(flags.until);
    if (u == null) { err(`--until: не метка ГГГГ-ММ-ДД ЧЧ:ММ: ${flags.until}`); return 1; }
    until = u + MINUTE;
  }

  const home = deps.home ?? homedir();
  const configDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const repoRoot = dirname(volnaDir);
  const dir = typeof flags.dir === "string" ? flags.dir : join(configDir, "projects", projectDirName(repoRoot));
  const names = listDir(dir);
  if (!names) { err(`каталога логов сессий нет: ${dir}`); return 3; }

  const only = typeof flags.session === "string" ? flags.session : null;
  const turns = [];
  let skipped = 0;
  const take = (path, session, sub) => {
    const parsed = parseTurns(readFile(path), { session, sub });
    turns.push(...parsed.turns);
    skipped += parsed.skipped;
  };
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const session = name.slice(0, -".jsonl".length);
    if (only && !session.startsWith(only)) continue;
    take(join(dir, name), session, false);
    for (const subName of listDir(join(dir, session, "subagents")) ?? []) {
      if (subName.endsWith(".jsonl")) take(join(dir, session, "subagents", subName), session, true);
    }
  }

  const { rows, total, sessions } = attribute(sections, turns, from, until);
  if (flags.json) {
    log(JSON.stringify({ task: taskId, from, until, dir, sessions: Object.fromEntries(sessions), rows, total, skipped }, null, 2));
    return 0;
  }
  const stamp = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  log(`расход ${taskId}: ${stamp(from)} - ${stamp(until - MINUTE)}, логи ${basename(dir)}`);
  const list = [...sessions].map(([id, s]) => `${id.slice(0, 8)} (${s.turns}${s.subTurns ? ` + ${s.subTurns} подаг.` : ""})`);
  log(`сессии в окне: ${sessions.size}${list.length ? ` - ${list.join(", ")}` : ""}`);
  if (!total.turns && !total.subTurns) { log("ходов модели в окне задачи нет"); return 0; }
  for (const l of table(rows, total)) log(l);
  log("контекст макс - самый большой ввод одного хода (ввод + запись + чтение кэша); подагенты - ходов / токенов всех видов");
  if (skipped) log(`записей assistant без usage или времени пропущено: ${skipped}`);
  return 0;
}

/** Прямой запуск, а не импорт: сравниваем сам файл, иначе CLI стартует при импорте из теста. */
if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2)));
}
