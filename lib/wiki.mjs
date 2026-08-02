/**
 * Ядро вики выводов: чтение соглашений, разбор записей, сборка указателей, структурные проверки
 * и сверка якорей с источниками. Без обращений к сети и без внешних зависимостей.
 *
 * Единица хранения - вывод, а не страница про сущность. В разделах с малой плотностью запись
 * лежит отдельным файлом, в плотных (эталонных) - секцией `##` внутри файла подтемы. Оба вида
 * разбираются одинаково: см. readRecords.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Значения по умолчанию, если в корне вики нет SCHEMA.md. */
export const DEFAULTS = {
  root: ".volna/wiki",
  sections: { reference: { code: true }, project: { code: false }, process: { code: false }, volna: { code: false } },
  types: ["гейт", "magic-число", "направление", "особый случай", "порядок", "побочный эффект",
    "ограничение", "термин", "договорённость", "конфликт", "расхождение"],
  // Набор должен совпадать со skills/volna-flow/stages, иначе линт бракует записи с законными
  // этапами: на живом корпусе так отвалились `plan`, `advocate` и `close` - 121 ложная ошибка
  stages: ["intake", "analyze", "spec", "plan", "advocate", "implement", "unit-tests", "visual",
    "fixtures", "deliver", "close", "cleanup", "capture"],
  limits: { record_lines: 20, record_lines_hard: 40, record_min_lines: 4, file_lines: 200,
    file_lines_hard: 400, index_file_lines: 300, quote_min_chars: 15, stale_days: 365 },
  reference_roots: [],
  checks: { exec_enabled: false },
};

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const cp1251 = new TextDecoder("windows-1251");

/**
 * Декодирование исходника с определением кодировки ПОФАЙЛОВО. Единой кодировки у эталона может
 * не быть: в одном корпусе встречаются utf-8 с BOM и cp1251, причём в главном файле - первая.
 * Кодировка как константа конфигурации даёт мохнатый текст на самом важном файле.
 */
export function decodeSource(buf) {
  try {
    const s = utf8Strict.decode(buf);
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  } catch {
    return cp1251.decode(buf);
  }
}

/**
 * Разбор ограниченного подмножества YAML: вложенные отображения по отступам, списки через дефис,
 * встроенные `{a: b}` и `[a, b]`, скаляры. Полного YAML тут не нужно, а зависимостей нет.
 */
export function parseYamlSubset(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l));
  let i = 0;
  const scalar = (raw) => {
    const v = raw.trim().replace(/\s+#.*$/, "");
    if (v === "") return "";
    if (v === "true") return true;
    if (v === "false") return false;
    if (v === "null") return null;
    if (/^-?\d+$/.test(v)) return Number(v);
    if (/^-?\d*\.\d+$/.test(v)) return Number(v);
    if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(",").map((s) => scalar(s)).filter((s) => s !== "");
    if (/^\{.*\}$/.test(v)) {
      const out = {};
      for (const pair of v.slice(1, -1).split(",")) {
        const at = pair.indexOf(":");
        if (at > 0) out[pair.slice(0, at).trim()] = scalar(pair.slice(at + 1));
      }
      return out;
    }
    return v.replace(/^["']|["']$/g, "");
  };
  const indentOf = (l) => l.match(/^\s*/)[0].length;
  const parseBlock = (indent) => {
    const isList = i < lines.length && indentOf(lines[i]) === indent && /^\s*-\s/.test(lines[i]);
    const out = isList ? [] : {};
    while (i < lines.length) {
      const line = lines[i];
      const ind = indentOf(line);
      if (ind < indent) break;
      if (ind > indent) { i++; continue; }
      if (/^\s*-\s/.test(line)) {
        const rest = line.replace(/^\s*-\s*/, "");
        if (rest.includes(":") && !/^[[{]/.test(rest)) {
          const at = rest.indexOf(":");
          const item = { [rest.slice(0, at).trim()]: scalar(rest.slice(at + 1)) };
          i++;
          out.push(item);
        } else { i++; out.push(scalar(rest)); }
        continue;
      }
      const at = line.indexOf(":");
      if (at < 0) { i++; continue; }
      const key = line.slice(0, at).trim();
      const rest = line.slice(at + 1).trim();
      i++;
      if (rest === "") out[key] = parseBlock(indentOf(lines[i] ?? "") > indent ? indentOf(lines[i]) : indent + 2);
      else out[key] = scalar(rest);
    }
    return out;
  };
  return parseBlock(indentOf(lines[0] ?? ""));
}

/** Слияние соглашений проекта с умолчаниями: отсутствие SCHEMA.md - не ошибка. */
export function loadSchema(root, deps = {}) {
  const read = deps.readFile ?? ((p) => readFileSync(p, "utf8"));
  let raw = "";
  try { raw = read(join(root, "SCHEMA.md")); } catch { return structuredClone(DEFAULTS); }
  const block = /```ya?ml\s*\n([\s\S]*?)```/.exec(raw);
  if (!block) return structuredClone(DEFAULTS);
  const parsed = parseYamlSubset(block[1]);
  const merged = structuredClone(DEFAULTS);
  for (const [k, v] of Object.entries(parsed)) {
    merged[k] = v && typeof v === "object" && !Array.isArray(v) && merged[k] && !Array.isArray(merged[k])
      ? { ...merged[k], ...v } : v;
  }
  return merged;
}

/**
 * Якорь секции: строчные буквы, пробелы в дефисы, пунктуация отброшена. Совпадает с тем, как
 * ссылку разрешает просмотрщик markdown, поэтому связи вида `[[подтема#заголовок]]` рабочие.
 */
export function slug(heading) {
  return heading.toLowerCase()
    .replace(/[«»"'`(),.:;!?]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Значение поля записи. Поля идут одной строкой через разделитель, поэтому значение обрывается
 * на нём: иначе в «предмет» попадает весь хвост строки вместе с типом и этапами.
 */
export function field(text, name) {
  const m = new RegExp(`\\*\\*${name}:\\*\\*\\s*([^\\n·]*)`).exec(text);
  return m ? m[1].trim() : undefined;
}

/**
 * Значение поля целиком, включая продолжение на следующих строках. Нужно там, где значение
 * длинное: обоснование разрешения, адрес эскалации, сам вывод. Однострочное чтение обрывало их
 * на первой строке и, например, не видело адреса документа, стоявшего в конце абзаца.
 */
export function fieldLong(text, name) {
  const start = new RegExp(`\\*\\*${name}:\\*\\*[ \\t]*`, "m").exec(text);
  if (!start) return undefined;
  const rest = text.slice(start.index + start[0].length);
  const stop = /\n\s*\n\s*\*\*[^*]+:\*\*|\n\s*\n\s*##\s|\n\s*\n\s*- `/.exec(rest);
  return (stop ? rest.slice(0, stop.index) : rest).trim();
}

/** Локаторы блока источников: `путь:строка` и дословная цитата через тире. */
export function parseAnchors(text) {
  const out = [];
  for (const m of text.matchAll(/^- `([^`]+?)(?::(\d+))?` — `(.+)`\s*$/gm)) {
    out.push({ path: m[1], line: m[2] ? Number(m[2]) : null, quote: m[3] });
  }
  for (const m of text.matchAll(/^- `([^`]+)`\s+—\s+«([^»]+)»\s*$/gm)) {
    out.push({ path: m[1], line: null, quote: m[2] });
  }
  return out;
}

function walkFiles(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "indexes") walkFiles(p, acc); }
    else if (e.name.endsWith(".md") && e.name !== "INDEX.md" && e.name !== "SCHEMA.md") acc.push(p);
  }
  return acc;
}

/**
 * Все записи корпуса. Файл с секциями `##`, несущими поле типа, даёт запись на секцию; иначе
 * запись - сам файл. Так один разбор обслуживает обе раскладки, а раздел про них не знает.
 */
export function readRecords(root, deps = {}) {
  const read = deps.readFile ?? ((p) => readFileSync(p, "utf8"));
  const list = deps.listFiles ?? (() => walkFiles(root));
  const records = [];
  const files = [];
  for (const path of list()) {
    const rel = relative(root, path).split(sep).join("/");
    const section = rel.split("/")[0];
    const text = read(path);
    const all = text.split(/\r?\n/);
    files.push({ rel, path, lines: all.length });
    const parts = text.split(/^## /m);
    const sectioned = parts.slice(1).filter((b) => /\*\*тип:\*\*/.test(b));
    // Шапка файла подтемы несёт общие для всех секций поля: раздел, тема, отметка о сверке
    const header = sectioned.length ? parts[0] : "";
    const bodies = sectioned.length
      ? sectioned.map((b) => ({ heading: b.split("\n")[0].trim(), body: b.slice(b.indexOf("\n") + 1) }))
      : [{ heading: (/^#\s+(.+)$/m.exec(text) ?? [, rel])[1].trim(), body: text }];
    for (const { heading, body } of bodies) {
      records.push({
        rel, path, section, heading, anchor: slug(heading), body,
        sectioned: sectioned.length > 0,
        subject: field(body, "предмет") ?? "",
        type: field(body, "тип") ?? "",
        stages: (field(body, "этапы") ?? "").split(/\s*,\s*/).filter(Boolean),
        verified: field(body, "проверено") ?? field(header, "проверено") ?? "",
        lines: body.split(/\r?\n/).filter((l) => l.trim()).length,
        anchors: parseAnchors(body),
        links: [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]),
        has: (name) => new RegExp(`\\*\\*${name}:\\*\\*`).test(body),
      });
    }
  }
  return { records, files };
}

/** Разрешение локатора кода в корень эталона по объявленным префиксам. */
export function resolveReferencePath(schema, path) {
  for (const r of schema.reference_roots ?? []) {
    const prefix = r.prefix ?? "";
    if (!prefix || path.startsWith(prefix)) return { root: r.root, rel: prefix ? path.slice(prefix.length) : path, drift: r.drift_window ?? 40 };
  }
  return null;
}

/**
 * Сверка одного якоря с источником. Порядок проверок важен: сначала совпадение строки целиком -
 * оно доказательно при любой длине (`razriv:=8;` законная цитата из десяти символов), и только
 * потом ограничение длины, которое нужно фрагменту. Обратный порядок бракует короткие операторы,
 * а именно они и несут magic-числа.
 */
export function verifyAnchor(anchor, schema, deps = {}) {
  const readBuf = deps.readBuf ?? ((p) => readFileSync(p));
  const min = schema.limits?.quote_min_chars ?? DEFAULTS.limits.quote_min_chars;
  if (anchor.line == null) return { verdict: "не код" };
  const resolved = resolveReferencePath(schema, anchor.path);
  if (!resolved) return { verdict: "корень не объявлен" };
  let lines;
  try { lines = decodeSource(readBuf(join(resolved.root, resolved.rel))).split(/\r?\n/); }
  catch { return { verdict: "файла нет" }; }
  const at = anchor.line - 1;
  const actual = lines[at] ?? null;
  const q = anchor.quote.trim();
  if (actual != null && actual.trim() === q) return { verdict: "точно" };
  if (q.length < min) return { verdict: "короткий фрагмент", length: q.length };
  if (actual != null && actual.includes(q)) return { verdict: "точно, фрагмент" };
  for (let d = 1; d <= resolved.drift; d++) {
    if (lines[at - d]?.includes(q)) return { verdict: "сдвинулось", line: at - d + 1 };
    if (lines[at + d]?.includes(q)) return { verdict: "сдвинулось", line: at + d + 1 };
  }
  return { verdict: "не найдено", actual: actual?.trim() ?? "" };
}

export { walkFiles };
