#!/usr/bin/env node
/**
 * CLI над вики выводов «Волны». Работает с обычными markdown-файлами, ничего не скачивает и
 * без флага --fix ничего не пишет.
 *
 * Единица хранения - вывод, а не страница про сущность: заголовок записи это утверждение,
 * а каждое утверждение о поведении держится на локаторе с номером строки и дословной цитатой.
 *
 * Использование:
 *   volna-wiki init [--root путь]        создать структуру вики и соглашения
 *   volna-wiki index [--fix]             пересобрать указатели (без --fix - показать план)
 *   volna-wiki lint [--json] [--all]     структурные проверки; --all снимает лимит на объём
 *   volna-wiki verify [--fix]            сверка якорей с источниками; --fix правит номера строк
 *   volna-wiki stats                     счётчики, пороги, доля проверенных
 *   volna-wiki pairs                     записи с общим предметом: вход смысловой сверки
 *   volna-wiki migrate [--fix]           перенос .volna/knowledge в вики (--zone зона=раздел)
 *
 * Корень вики берётся из --root, иначе из SCHEMA.md найденной вики, иначе .volna/wiki.
 * Коды возврата: 0 чисто, 1 ошибки, 2 только предупреждения, 3 сбой инструмента.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, loadSchema, readRecords, verifyAnchor, walkFiles } from "../lib/wiki.mjs";
import { lint, formatFindings, ERROR } from "../lib/wiki-lint.mjs";
import { planIndexes } from "../lib/wiki-index.mjs";
import { parseLegacyIndex, planMigration } from "../lib/wiki-migrate.mjs";

const SCHEMA_TEMPLATE = `# Соглашения вики выводов

Машиночитаемая часть - блок ниже. Отсутствие файла означает значения по умолчанию.

\`\`\`yaml
root: .volna/wiki
sections:
  reference: {code: true}
  project: {code: false}
  process: {code: false}
  volna: {code: false}
limits:
  record_lines: 20
  record_lines_hard: 40
  record_min_lines: 4
  file_lines: 200
  file_lines_hard: 400
  index_file_lines: 300
  quote_min_chars: 15
  stale_days: 365
checks:
  exec_enabled: false
\`\`\`

## Единица хранения

Одна запись - один вывод. Заголовок записи это утверждение, а не тема. В разделах с кодовым
признаком обязателен блок источников, и каждый локатор несёт номер строки и дословную цитату.

## Раскладка

В разделах малой плотности запись лежит отдельным файлом. В плотных - секцией \`##\` внутри файла
подтемы: соседние выводы взаимно контекстны, и порознь они вводят в заблуждение.
`;

/** Разбор argv в команду, позиционные аргументы и флаги. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const name = a.slice(2);
    if (name === "zone") { (flags.zone ??= []).push(argv[++i] ?? ""); continue; }
    if (["root", "limit", "from"].includes(name)) flags[name] = argv[++i] ?? "";
    else flags[name] = true;
  }
  return { command: positional[0], args: positional.slice(1), flags };
}

/** Поиск корня вики: явный флаг, затем привычные места рядом с рабочим каталогом. */
export function findRoot(flags, cwd, exists) {
  if (flags.root) return resolve(cwd, flags.root);
  for (const p of [".volna/wiki", "wiki", "docs/wiki"]) {
    if (exists(join(cwd, p))) return join(cwd, p);
  }
  return join(cwd, DEFAULTS.root);
}

/**
 * Точка входа, пригодная для тестов: файловые операции инжектируются.
 * Возвращает код выхода, ничего не бросает наружу.
 */
export async function run(argv, deps = {}) {
  const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  const exists = deps.exists ?? existsSync;
  const write = deps.write ?? ((p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t, "utf8"); });
  const cwd = deps.cwd ?? process.cwd();

  const { command, flags } = parseArgs(argv);
  if (!command || command === "help" || flags.help) { log(usage()); return 0; }

  const root = findRoot(flags, cwd, exists);

  if (command === "init") {
    if (exists(join(root, "SCHEMA.md"))) { err(`вики уже развёрнута: ${root}`); return 3; }
    write(join(root, "SCHEMA.md"), SCHEMA_TEMPLATE);
    for (const section of Object.keys(DEFAULTS.sections)) {
      write(join(root, section, ".gitkeep"), "");
    }
    log(`вики развёрнута: ${root}`);
    log(`разделы: ${Object.keys(DEFAULTS.sections).join(", ")}`);
    return 0;
  }

  if (!exists(root)) { err(`каталог вики не найден: ${root}\nразвернуть: volna-wiki init`); return 3; }

  let schema;
  let records;
  let files;
  try {
    schema = loadSchema(root, deps);
    ({ records, files } = readRecords(root, deps));
  } catch (e) {
    err(`не удалось прочитать вики: ${e.message}`);
    return 3;
  }
  // Перенос как раз и наполняет пустую вику: только что развёрнутая записей не содержит
  if (!records.length && command !== "migrate") { err(`в ${root} нет записей`); return 3; }

  const plan = planIndexes(records, schema);

  if (command === "index") {
    if (!flags.fix) {
      log(`план указателей (без --fix ничего не записано):`);
      for (const f of plan.files) log(`  ${f.text.split("\n").length} строк  ${f.rel}`);
      if (plan.sharded.length) log(`шардированы по этапам: ${plan.sharded.join(", ")}`);
      return 0;
    }
    for (const f of plan.files) write(join(root, f.rel), f.text);
    // Шард, оставшийся от переименованного или опустевшего этапа, живым не выглядит - агент
    // откроет его и получит устаревший перечень. Убираем всё, чего нет в плане
    const planned = new Set(plan.files.map((f) => f.rel));
    const listDir = deps.listDir ?? ((p) => (existsSync(p) ? readdirSync(p) : []));
    const remove = deps.remove ?? ((p) => rmSync(p));
    const dead = [];
    for (const section of plan.sharded) {
      for (const name of listDir(join(root, section, "indexes"))) {
        const rel = `${section}/indexes/${name}`;
        if (name.endsWith(".md") && !planned.has(rel)) { remove(join(root, rel)); dead.push(rel); }
      }
    }
    log(`указателей записано: ${plan.files.length}${plan.sharded.length ? `, шардированы: ${plan.sharded.join(", ")}` : ""}`);
    if (dead.length) log(`мёртвых шардов удалено: ${dead.length} (${dead.join(", ")})`);
    return 0;
  }

  if (command === "verify") {
    const counts = { "точно": 0, "точно, фрагмент": 0, "сдвинулось": 0, "не найдено": 0, "файла нет": 0, "короткий фрагмент": 0, "корень не объявлен": 0 };
    const problems = [];
    const moves = [];
    let total = 0;
    for (const r of records) {
      for (const a of r.anchors) {
        if (a.line == null) continue;
        total++;
        const v = verifyAnchor(a, schema, deps);
        counts[v.verdict] = (counts[v.verdict] ?? 0) + 1;
        const at = `${r.rel}#${r.anchor}`;
        if (v.verdict === "сдвинулось") { moves.push({ r, a, to: v.line }); problems.push(`СДВИГ ${v.line - a.line > 0 ? "+" : ""}${v.line - a.line}  ${at}  ${a.path}:${a.line} -> :${v.line}`); }
        else if (v.verdict === "не найдено") problems.push(`НЕ НАЙДЕНО  ${at}  ${a.path}:${a.line}\n    ожидалось: ${a.quote}\n    на строке: ${v.actual}`);
        else if (v.verdict === "файла нет") problems.push(`НЕТ ФАЙЛА  ${at}  ${a.path}`);
        else if (v.verdict === "короткий фрагмент") problems.push(`КОРОТКИЙ ФРАГМЕНТ  ${at}  ${a.path}:${a.line} (${v.length} симв., строка целиком не совпала)`);
        else if (v.verdict === "корень не объявлен") problems.push(`КОРЕНЬ НЕ ОБЪЯВЛЕН  ${at}  ${a.path} - дописать reference_roots в SCHEMA.md`);
      }
    }
    log(`записей: ${records.length}, якорей кода: ${total}`);
    for (const [k, v] of Object.entries(counts)) if (v) log(`  ${k}: ${v}`);
    if (problems.length) { log(""); for (const p of problems) log(p); }
    if (flags.fix && moves.length) {
      const readFile = deps.readFile ?? ((p) => readFileSync(p, "utf8"));
      const byFile = new Map();
      for (const m of moves) {
        if (!byFile.has(m.r.path)) byFile.set(m.r.path, []);
        byFile.get(m.r.path).push(m);
      }
      for (const [path, ms] of byFile) {
        let text = readFile(path);
        for (const m of ms) text = text.replace(`\`${m.a.path}:${m.a.line}\``, `\`${m.a.path}:${m.to}\``);
        write(path, text);
      }
      log(`\nномера строк поправлены: ${moves.length}`);
      return 0;
    }
    const bad = counts["не найдено"] + counts["файла нет"] + counts["корень не объявлен"];
    return bad ? 1 : (counts["сдвинулось"] + counts["короткий фрагмент"] ? 2 : 0);
  }

  if (command === "lint") {
    const verify = (schema.reference_roots ?? []).length
      ? (a) => verifyAnchor(a, schema, deps) : null;
    const findings = lint({ records, files, schema, indexed: plan.indexed, verify });
    if (flags.json) log(JSON.stringify(findings, null, 2));
    else log(formatFindings(findings, flags.all ? Infinity : Number(flags.limit ?? 40)));
    const errors = findings.filter((f) => f.level === ERROR).length;
    return errors ? 1 : (findings.length ? 2 : 0);
  }

  if (command === "pairs") {
    // Кандидаты на смысловую сверку: записи, говорящие об одном предмете из разных мест.
    // Машина отбирает пары, судит модель - иначе ей пришлось бы читать раздел целиком.
    const byKey = new Map();
    for (const r of records) {
      if (!r.subject) continue;
      const key = r.subject.toLowerCase().replace(/[ёе]/g, "е");
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }
    const pairs = [...byKey.entries()].filter(([, rs]) => rs.length > 1);
    if (!pairs.length) { log("пар с общим предметом нет"); return 0; }
    log(`предметов с несколькими записями: ${pairs.length}`);
    for (const [subject, rs] of pairs.sort((a, b) => b[1].length - a[1].length)) {
      log(`\n${subject} (${rs.length})`);
      for (const r of rs) log(`  ${r.type.padEnd(16)} ${r.rel}#${r.anchor}`);
    }
    return 0;
  }

  if (command === "migrate") {
    const from = flags.from ? resolve(cwd, flags.from) : join(cwd, ".volna", "knowledge");
    if (!exists(from)) { err(`каталог прежних знаний не найден: ${from}`); return 3; }
    const readFile = deps.readFile ?? ((p) => readFileSync(p, "utf8"));
    const listLegacy = deps.listLegacy ?? (() => walkFiles(from));
    const legacyFiles = listLegacy().map((p) => ({
      rel: relative(from, p).split(sep).join("/"), path: p, text: readFile(p),
    }));
    let legacyIndex = new Map();
    try { legacyIndex = parseLegacyIndex(readFile(join(from, "INDEX.md"))); } catch { /* указателя может не быть */ }
    const overrides = {};
    for (const pair of [].concat(flags.zone ?? [])) {
      const at = String(pair).indexOf("=");
      if (at > 0) overrides[pair.slice(0, at)] = pair.slice(at + 1);
    }
    const { items, already, needSubject, needType } = planMigration({
      files: legacyFiles, legacyIndex, overrides, schema,
      targetExists: (rel) => exists(join(root, rel)),
    });
    if (!items.length) {
      log(already.length ? `переносить нечего: все ${already.length} записей уже в вики` : "переносить нечего");
      return already.length ? 0 : 3;
    }
    const bySection = {};
    for (const it of items) bySection[it.section] = (bySection[it.section] ?? 0) + 1;
    log(`${flags.fix ? "перенесено" : "план переноса (без --fix ничего не записано)"}: ${items.length}`);
    for (const [s, n] of Object.entries(bySection)) log(`  ${String(n).padStart(4)}  -> ${s}`);
    if (!flags.fix) for (const it of items.slice(0, 10)) log(`  ${it.from}  ->  ${it.to}`);
    if (already.length) log(`уже в вики, повторно не переписываются: ${already.length}`);
    if (needSubject.length) log(`без предмета (дописать руками): ${needSubject.length}`);
    if (needType.length) log(`без типа (проставить руками): ${needType.length}`);
    if (!flags.fix) return 0;
    for (const it of items) write(join(root, it.to), it.text);
    log(`указатели пересобрать: volna-wiki index --fix`);
    return 0;
  }

  if (command === "stats") {
    const bySection = {};
    const byType = {};
    let anchored = 0;
    let verified = 0;
    for (const r of records) {
      bySection[r.section] = (bySection[r.section] ?? 0) + 1;
      if (r.type) byType[r.type] = (byType[r.type] ?? 0) + 1;
      if (r.anchors.length) anchored++;
      if (r.verified) verified++;
    }
    log(`корень: ${root}`);
    log(`записей: ${records.length}, файлов: ${files.length}`);
    log("разделы:");
    for (const [k, v] of Object.entries(bySection).sort((a, b) => b[1] - a[1])) log(`  ${String(v).padStart(4)}  ${k}`);
    log("типы:");
    for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) log(`  ${String(v).padStart(4)}  ${k}`);
    log(`с якорями: ${anchored}, со сверкой: ${verified}`);
    const limits = { ...DEFAULTS.limits, ...(schema.limits ?? {}) };
    const big = files.filter((f) => f.lines > limits.file_lines);
    if (big.length) { log(`файлы сверх порога ${limits.file_lines} строк:`); for (const f of big) log(`  ${f.lines}  ${f.rel}`); }
    if (plan.sharded.length) log(`указатели шардированы: ${plan.sharded.join(", ")}`);
    return 0;
  }

  err(`неизвестная команда: ${command}`);
  log(usage());
  return 3;
}

function usage() {
  return [
    "volna-wiki - вики выводов: хранилище, указатели, проверки",
    "",
    "  init [--root путь]        развернуть структуру и соглашения",
    "  index [--fix]             пересобрать указатели (без --fix - только план)",
    "  lint [--json] [--all]     структурные проверки записей и файлов",
    "  verify [--fix]            сверка якорей с источниками",
    "  stats                     счётчики, типы, пороги",
    "  pairs                     кандидаты на смысловую сверку: общий предмет у разных записей",
    "  migrate [--from путь] [--zone зона=раздел] [--fix]   перенос прежних знаний в вики",
    "",
    "Без --fix ни одна команда не пишет в файлы.",
    "Коды возврата: 0 чисто, 1 ошибки, 2 только предупреждения, 3 сбой инструмента.",
  ].join("\n");
}

/** Прямой запуск, а не импорт: сравниваем сам файл, иначе CLI стартует при импорте из теста. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2)));
}
