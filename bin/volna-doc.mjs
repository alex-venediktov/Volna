#!/usr/bin/env node
/**
 * CLI проверок документации репозитория: ссылки и бюджеты объёма. Ничего не скачивает и ничего
 * не пишет - только читает markdown и печатает находки.
 *
 * Вика проверяется своим инструментом (`volna-wiki lint`): там единица проверки запись, а не файл.
 * Здесь предмет другой - тексты этапов, команды и docs, то есть то, что модель читает в работе.
 *
 * Использование:
 *   volna-doc lint [--root путь] [--json] [--all]   ссылки и бюджеты
 *
 * Бюджеты берутся из `.volna/doc-budgets.json` (карта «путь -> потолок в байтах»); файла нет -
 * проверяются только ссылки.
 * Коды возврата: 0 чисто, 1 ошибки, 2 только предупреждения, 3 сбой инструмента.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { lintDocs, ERROR } from "../lib/doc-lint.mjs";
import { formatFindings } from "../lib/wiki-lint.mjs";

/** Каталоги, которые не относятся к документации проекта и только шумят в находках. */
const SKIP_DIRS = new Set([".git", "node_modules", ".volna", "dist", "build"]);

/** Разбор аргументов: команда, свободные слова и флаги вида --имя[=значение]. */
function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      flags[k] = v ?? true;
    } else args.push(a);
  }
  return { command: args.shift(), args, flags };
}

/** Все markdown корпуса, относительными путями через прямой слеш. */
function walk(root, dir = root, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") && e.name !== ".claude-plugin") continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(root, p, acc);
    else if (e.name.endsWith(".md")) acc.push(p.slice(root.length + 1).split("\\").join("/"));
  }
  return acc;
}

/**
 * Точка входа, пригодная для тестов: чтение и обход инжектируются.
 * Возвращает код выхода, ничего не бросает наружу.
 */
export async function run(argv, deps = {}) {
  const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  const cwd = deps.cwd ?? process.cwd();
  const exists = deps.exists ?? existsSync;
  const readText = deps.readText ?? ((p) => { try { return readFileSync(p, "utf8"); } catch { return null; } });

  const { command, flags } = parseArgs(argv);
  if (!command || command === "help" || flags.help) {
    log("volna-doc lint [--root путь] [--json] [--all]   ссылки и бюджеты документации");
    return 0;
  }
  if (command !== "lint") { err(`неизвестная команда: ${command}`); return 3; }

  const root = flags.root ? resolvePath(String(flags.root)) : cwd;
  let rels;
  try {
    rels = deps.listFiles ? deps.listFiles(root) : walk(root);
  } catch (e) {
    err(`не удалось прочитать документацию: ${e.message}`);
    return 3;
  }
  if (!rels.length) { err(`в ${root} нет markdown`); return 3; }

  const files = [];
  for (const rel of rels) {
    const text = readText(join(root, rel));
    if (text != null) files.push({ rel, text });
  }

  let budgets = {};
  const manifest = join(root, ".volna", "doc-budgets.json");
  if (exists(manifest)) {
    try {
      budgets = JSON.parse(readText(manifest) ?? "{}");
    } catch (e) {
      err(`манифест бюджетов не разобран: ${e.message}`);
      return 3;
    }
  }

  const findings = lintDocs({
    files,
    budgets,
    exists,
    readText,
    resolve: (fromRel, target) => join(root, ...fromRel.split("/").slice(0, -1), ...String(target).split("/")),
  });

  if (flags.json) log(JSON.stringify(findings, null, 2));
  else log(formatFindings(findings, flags.all ? Infinity : 40));

  if (findings.some((f) => f.level === ERROR)) return 1;
  return findings.length ? 2 : 0;
}

/** Прямой запуск, а не импорт: сравниваем сам файл, иначе CLI стартует при импорте из теста. */
if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2)));
}
