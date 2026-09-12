/**
 * Проверки документации репозитория: разрешимость ссылок и бюджеты объёма. Детерминированные,
 * без модели и без сети - их можно гонять на каждом выпуске.
 *
 * Предмет проверки - markdown вне вики: тексты этапов, команды, docs. У вики свой линт
 * (`lib/wiki-lint.mjs`), у него другая единица - запись, а не файл.
 *
 * Разбор идёт по тексту БЕЗ кода: документация плагина показывает синтаксис ссылок и локаторов,
 * и первая же версия без вырезания кода находит собственные примеры (`plugin-link-check-skips-code-spans`).
 */
import { slug } from "./wiki.mjs";

const ERROR = "ошибка";
const WARN = "предупр.";

/** Одна находка: код, уровень, адрес, что не так и что сделать. */
function finding(code, level, at, what, fix) {
  return { code, level, at, what, fix };
}

/**
 * Текст без кода: блоки в тройных кавычках и спаны в одиночных заменяются пробелами.
 * Длина и разбиение на строки сохраняются, иначе номер строки в находке уедет.
 */
export function stripCode(text) {
  const blank = (s) => s.replace(/[^\n]/g, " ");
  return String(text)
    .replace(/```[\s\S]*?(?:```|$)/g, blank)
    .replace(/`[^`\n]*`/g, blank);
}

/** Относительные ссылки текста: `[имя](путь)` и `[имя]: путь`. Внешние и почтовые пропускаются. */
export function collectLinks(text) {
  const out = [];
  const clean = stripCode(text);
  const lines = clean.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const re = /\[[^\]]*\]\(([^)\s]+)\)|^\[[^\]]+\]:\s*(\S+)/g;
    let m;
    while ((m = re.exec(lines[i])) !== null) {
      const target = m[1] ?? m[2];
      if (/^(https?:|mailto:|#|<)/.test(target)) continue;
      const [path, fragment] = target.split("#");
      out.push({ target, path, fragment: fragment || null, line: i + 1 });
    }
  }
  return out;
}

/** Якоря заголовков документа: по ним проверяется часть ссылки после решётки. */
export function headingAnchors(text) {
  const out = new Set();
  for (const line of stripCode(text).split("\n")) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) out.add(slug(m[1]));
    // Явный якорь в html - им пользуются генераторы оглавлений
    const a = /<a\s+id="([^"]+)"/.exec(line);
    if (a) out.add(a[1].toLowerCase());
  }
  return out;
}

/**
 * Проверки корпуса документации.
 *
 * files - список `{ rel, text }`; resolve(relОтFile, target) отдаёт путь для проверки
 * существования; exists и readText работают с этим путём. budgets - карта
 * `относительный путь -> потолок в байтах`.
 */
export function lintDocs({ files, resolve, exists, readText, budgets = {} }) {
  const out = [];
  const byRel = new Map(files.map((f) => [f.rel.replace(/\\/g, "/"), f]));

  for (const f of files) {
    const rel = f.rel.replace(/\\/g, "/");
    for (const link of collectLinks(f.text)) {
      const at = `${rel}:${link.line}`;
      // Ссылка внутри документа (`#якорь`) отсеяна при сборе: здесь только та, у которой есть путь
      const full = resolve(rel, link.path);
      if (!exists(full)) {
        out.push(finding("D001", ERROR, at, `цель ссылки не существует: ${link.target}`, "поправить путь или завести файл"));
        continue;
      }
      if (link.fragment && link.path.endsWith(".md")) {
        const targetRel = normalize(rel, link.path);
        const text = byRel.get(targetRel)?.text ?? readText(full);
        if (text == null) continue;
        if (!headingAnchors(text).has(decodeURIComponent(link.fragment).toLowerCase())) {
          out.push(finding("D002", WARN, at, `якорь не найден в целевом файле: #${link.fragment}`, "поправить якорь или заголовок"));
        }
      }
    }
  }

  for (const [rel, limit] of Object.entries(budgets)) {
    const f = byRel.get(rel.replace(/\\/g, "/"));
    if (!f) {
      out.push(finding("D004", WARN, rel, "бюджет назначен файлу, которого нет", "убрать строку из манифеста или вернуть файл"));
      continue;
    }
    const size = Buffer.byteLength(f.text, "utf8");
    if (size > limit) {
      out.push(finding("D003", ERROR, rel, `${size} Б при потолке ${limit} Б`,
        "сначала перенести чужое в его дом, затем сжать своё, и только потом поднимать потолок"));
    } else if (size > limit * 0.95) {
      out.push(finding("D003", WARN, rel, `${size} Б при потолке ${limit} Б: запас меньше 5%`,
        "перенести или сжать, пока гейт не красный"));
    }
  }

  return out;
}

/** Путь ссылки относительно корня корпуса - тем же видом, каким лежат ключи в карте файлов. */
function normalize(fromRel, target) {
  const base = fromRel.split("/").slice(0, -1);
  const parts = `${target}`.replace(/\\/g, "/").split("/");
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") base.pop();
    else base.push(p);
  }
  return base.join("/");
}

export { ERROR, WARN, normalize };
