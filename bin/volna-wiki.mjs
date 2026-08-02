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
 *   volna-wiki route «слова задачи»      какой узел указателя открыть под эту задачу
 *   volna-wiki lint [--json] [--all]     структурные проверки; --all снимает лимит на объём
 *   volna-wiki verify [--fix]            сверка якорей с источниками; --fix правит номера строк
 *   volna-wiki stats                     счётчики, пороги, доля проверенных
 *   volna-wiki pairs                     записи с общим предметом: вход смысловой сверки
 *   volna-wiki flatten [--fix]           выпрямить раскладку: узлы из каталогов в имена файлов
 *   volna-wiki migrate [--fix]           перенос .volna/knowledge в вики (--zone зона=раздел)
 *
 * Корень вики берётся из --root, иначе из SCHEMA.md найденной вики, иначе .volna/wiki.
 * Коды возврата: 0 чисто, 1 ошибки, 2 только предупреждения, 3 сбой инструмента.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, isIndexFile, loadSchema, readRecords, verifyAnchor, walkFiles } from "../lib/wiki.mjs";
import { lint, formatFindings, ERROR } from "../lib/wiki-lint.mjs";
import { planIndexes, planRoute, planPlacement } from "../lib/wiki-index.mjs";
import { parseLegacyIndex, planFlatten, planMigration } from "../lib/wiki-migrate.mjs";

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

  const { command, args, flags } = parseArgs(argv);
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
    ({ records, files } = readRecords(root, deps, schema));
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
    // Шард, оставшийся от переименованного или опустевшего узла, живым не выглядит - агент
    // откроет его и получит устаревший перечень. Убираем всё, чего нет в плане; дерево узлов
    // растёт вглубь, поэтому обход рекурсивный
    const planned = new Set(plan.files.map((f) => f.rel));
    const listDir = deps.listDir ?? ((p) => (existsSync(p) ? readdirSync(p) : []));
    const isDir = deps.isDir ?? ((p) => existsSync(p) && statSync(p).isDirectory());
    const remove = deps.remove ?? ((p) => rmSync(p, { recursive: true }));
    const dead = [];
    // Подметаем только указатели: они собираются инструментом, а всё прочее в разделе - записи.
    // Прежняя раскладка держала их в каталоге `indexes`, нынешняя - в корне раздела с суффиксом
    // имени, поэтому обход берёт оба места
    const sweep = (relDir) => {
      for (const name of listDir(join(root, relDir))) {
        const rel = `${relDir}/${name}`;
        // Каталог прежней раскладки принадлежит инструменту целиком: записей там не бывает
        if (isDir(join(root, rel))) {
          if (name === "indexes") { remove(join(root, rel)); dead.push(`${rel}/`); }
          continue;
        }
        if (name.endsWith(".md") && isIndexFile(name) && !planned.has(rel)) {
          remove(join(root, rel));
          dead.push(rel);
        }
      }
    };
    for (const section of new Set(records.map((r) => r.section))) sweep(section);
    log(`указателей записано: ${plan.files.length}${plan.sharded.length ? `, шардированы: ${plan.sharded.join(", ")}` : ""}`);
    if (dead.length) log(`мёртвых шардов удалено: ${dead.length} (${dead.join(", ")})`);
    return 0;
  }

  if (command === "route") {
    const query = (args ?? []).join(" ").trim();
    if (!query) { err("нужны слова задачи: volna-wiki route «экспорт вида слева размеры»"); return 3; }
    const { words, routes, hits } = planRoute(records, query, schema);
    if (!routes.length) {
      log(`по словам «${words.join(", ")}» совпадений нет: открыть корневой указатель INDEX.md`);
      return 0;
    }
    log(`слова: ${words.join(", ")}`);
    log("\nмаршруты, начиная с ближайшего:");
    for (const r of routes) log(`  ${String(r.count).padStart(3)} зап.  ${r.rel}\n           ${r.subjects.join(", ")}`);
    log("\nближайшие записи:");
    for (const h of hits.slice(0, 8)) log(`  ${h.at}`);
    return 0;
  }

  if (command === "place") {
    const text = (args ?? []).join(" ").trim();
    if (!text) { err("нужен текст записи: volna-wiki place «Шаг ряда размеров в КОМПАС равен десяти»"); return 3; }
    const p = planPlacement(records, text, schema);
    log(`слова: ${p.words.join(", ")}`);
    if (p.confident) {
      log(`\nместо в существующей иерархии: ${p.dir}`);
      log(`  совпало сегментов: ${p.segmentHits}, вес ${p.score}`);
      if (p.alternatives.length) log(`  рядом: ${p.alternatives.map((a) => a.dir).join(", ")}`);
      return 0;
    }
    log(`\nподходящего узла нет${p.dir ? ` (ближайший ${p.dir}, вес ${p.score})` : ""}`);
    log(`завести: ${p.suggestion.dir}`);
    if (p.suggestion.unmatched.length) log(`  слова задачи без узла: ${p.suggestion.unmatched.join(", ")}`);
    log("  имя узла - одно слово; описание темы дописать в SCHEMA.md, ключ topics");
    return 0;
  }

  if (command === "flatten") {
    const readFile = deps.readFile ?? ((p) => readFileSync(p, "utf8"));
    const flat = planFlatten({ files: files.map((f) => ({ rel: f.rel, text: readFile(f.path) })), schema });
    if (!flat.moves.length) { log("раскладка уже плоская: переносить нечего"); return 0; }
    if (flat.touched.length) log(`связи поправятся и в файлах, которые остаются на месте: ${flat.touched.length}`);
    log(`${flags.fix ? "выпрямлено" : "план выпрямления (без --fix ничего не записано)"}: ${flat.moves.length}`);
    if (!flags.fix) for (const m of flat.moves.slice(0, 10)) log(`  ${m.from}  ->  ${m.to}`);
    if (flat.needTopic.length) err(`сегменты пути без описания в SCHEMA.md, ключ topics: ${flat.needTopic.join(", ")}`);
    if (flat.ambiguous.length) err(`имя не разбирается обратно в путь: ${flat.ambiguous.map((a) => a.to).join(", ")}`);
    if (flat.collisions.length) err(`целевые имена сталкиваются: ${flat.collisions.map((c) => c.to).join(", ")}`);
    if (flat.blocked) { err("выпрямление не выполнено: сначала устранить перечисленное"); return 1; }
    if (flat.brokenLinks.length) log(`связей по неоднозначному имени оставлено как есть: ${flat.brokenLinks.length} (${flat.brokenLinks.map((b) => b.link).join(", ")})`);
    if (!flags.fix) return 0;
    const listDir = deps.listDir ?? ((p) => (existsSync(p) ? readdirSync(p) : []));
    const remove = deps.remove ?? ((p) => rmSync(p, { recursive: true }));
    for (const f of flat.touched) write(join(root, f.rel), f.text);
    const dirs = new Set();
    for (const m of flat.moves) {
      write(join(root, m.to), m.text);
      remove(join(root, m.from));
      const parts = m.from.split("/");
      for (let i = parts.length - 1; i > 1; i--) dirs.add(parts.slice(0, i).join("/"));
    }
    // Опустевший каталог узла выглядит как живая ветка: обход идёт от длинных путей к коротким,
    // иначе родитель проверяется раньше, чем из него исчезнет ребёнок
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
      if (!listDir(join(root, d)).length) remove(join(root, d));
    }
    log(`связей переписано: ${flat.rewritten}`);
    log("указатели пересобрать: volna-wiki index --fix");
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
    "  route «слова задачи»      какой указатель открыть под эту задачу",
    "  place «текст записи»      куда положить новый вывод: узел иерархии или новый",
    "  lint [--json] [--all]     структурные проверки записей и файлов",
    "  verify [--fix]            сверка якорей с источниками",
    "  stats                     счётчики, типы, пороги",
    "  pairs                     кандидаты на смысловую сверку: общий предмет у разных записей",
    "  flatten [--fix]           выпрямить раскладку: узлы из каталогов переезжают в имена файлов",
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
