/**
 * Сборка указателей вики. Указатель - маршрутизатор, а не контейнер: строка на каждый вывод,
 * колонка «предмет» существует затем, чтобы этап отбирал строку, не открывая файл.
 *
 * Шардирование обязательно, а не опционально: при тысячах записей плоский указатель нежизнеспособен.
 * Ось дробления - этап флоу, потому что этап читает только свою секцию.
 */
import { DEFAULTS } from "./wiki.mjs";

const HINT = [
  "Строка на каждый вывод. Колонка «предмет» существует затем, чтобы этап отбирал строку,",
  "не открывая файл. Файл собирается инструментом, ручные правки будут затёрты.",
];

function table(rows, prefix, groupByTopic) {
  const out = [];
  const byTopic = {};
  for (const r of rows) (byTopic[r.rel.split("/").slice(0, -1).join("/") || "."] ??= []).push(r);
  const many = groupByTopic && rows.length > 15 && Object.keys(byTopic).length > 1;
  for (const [topic, trs] of Object.entries(byTopic)) {
    if (many) out.push(`### ${topic}`, "");
    out.push("| Запись | Предмет | Тип | Файл |", "|---|---|---|---|");
    for (const r of [...trs].sort((a, b) => a.heading.localeCompare(b.heading, "ru"))) {
      out.push(`| ${r.heading} | ${r.subject} | ${r.type} | [${r.rel}](${prefix}${r.rel}#${r.anchor}) |`);
    }
    out.push("");
  }
  return out;
}

/**
 * Планирует содержимое указателей, ничего не записывая: возвращает список файлов и множество
 * адресов записей, попавших в указатель (его ждёт проверка K001).
 */
export function planIndexes(records, schema = DEFAULTS) {
  const limits = { ...DEFAULTS.limits, ...(schema.limits ?? {}) };
  const order = schema.stages ?? DEFAULTS.stages;
  const bySection = {};
  for (const r of records) (bySection[r.section] ??= []).push(r);

  const files = [];
  const indexed = new Set();
  const sharded = [];

  for (const [section, rs] of Object.entries(bySection)) {
    const stages = [...new Set(rs.flatMap((r) => r.stages))]
      .sort((a, b) => (order.indexOf(a) + 99) % 100 - (order.indexOf(b) + 99) % 100);
    const flat = [`# Указатель раздела ${section}`, "", ...HINT, ""];
    for (const st of stages) {
      const rows = rs.filter((r) => r.stages.includes(st));
      if (rows.length) flat.push(`## ${st}`, "", ...table(rows, "", true));
    }
    for (const r of rs) if (r.stages.length) indexed.add(`${r.rel}#${r.anchor}`);

    if (flat.length <= limits.index_file_lines) {
      files.push({ rel: `${section}/INDEX.md`, text: flat.join("\n") });
      continue;
    }
    sharded.push(section);
    const toc = [`# Указатель раздела ${section}`, "",
      "Указатель разбит по этапам: превышен порог строк на файл. Этап открывает только свой файл.", "",
      "| Этап | Записей | Файл |", "|---|---|---|"];
    for (const st of stages) {
      const rows = rs.filter((r) => r.stages.includes(st));
      if (!rows.length) continue;
      const body = [`# Указатель раздела ${section}: этап ${st}`, "", ...HINT, "", ...table(rows, "../", true)];
      files.push({ rel: `${section}/indexes/${st}.md`, text: body.join("\n") });
      toc.push(`| ${st} | ${rows.length} | [indexes/${st}.md](indexes/${st}.md) |`);
    }
    files.push({ rel: `${section}/INDEX.md`, text: toc.join("\n") });
  }

  const root = ["# Указатель", "", "Оглавление разделов. Содержание - в указателе раздела.", "",
    "| Раздел | Записей | Указатель |", "|---|---|---|"];
  for (const [section, rs] of Object.entries(bySection).sort()) {
    root.push(`| ${section} | ${rs.length} | [${section}/INDEX.md](${section}/INDEX.md) |`);
  }
  files.push({ rel: "INDEX.md", text: root.join("\n") });

  return { files, indexed, sharded };
}
