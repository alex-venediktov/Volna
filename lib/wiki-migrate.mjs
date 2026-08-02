/**
 * Перенос накопленных знаний прежней раскладки (`.volna/knowledge/`) в вики выводов.
 *
 * Механически переносится то, что есть в источнике: файл записи, зона, этапы и колонка «предмет»
 * из прежнего указателя. Тип записи из старого формата не выводится - его проставляет человек,
 * и до тех пор линт честно показывает нехватку поля.
 */
import { DEFAULTS, nodeOfRel, slug } from "./wiki.mjs";

/** Якоря, которые файл предоставляет связям: заголовок файла и заголовок каждой записи в нём. */
function headingAnchors(text) {
  return new Set([...String(text).matchAll(/^#{1,2}\s+(.+)$/gm)].map((m) => slug(m[1].trim())));
}

/**
 * Выпрямление раскладки: узлы переезжают из подкаталогов в имя файла
 * (`reference/ui/tabs/gates.md` -> `reference/ui-tabs-gates.md`). Смысл в указателях: ссылка на
 * запись сводится к имени файла вместо цепочки `../`, а имя записи становится уникальным на всю
 * вику - до сих пор два файла с одним именем молча делили ключ связи `[[имя]]`.
 *
 * План возвращается целиком и не выполняется частично. Три условия проверяются заранее, потому
 * что нарушение любого делает дерево неразбираемым: каждый сегмент пути объявлен в `topics`
 * (иначе указатель не соберёт узел обратно), плоское имя разбирается ровно в исходный путь
 * (иначе имя документа съело бы уровень), и целевые имена не сталкиваются между собой.
 */
export function planFlatten({ files, schema = DEFAULTS }) {
  const topics = schema.topics ?? {};
  const moves = [];
  const needTopic = new Set();
  const ambiguous = [];
  const collisions = [];
  const byTarget = new Map();

  for (const { rel, text } of files) {
    const parts = rel.split("/");
    if (parts.length < 3) continue;
    const section = parts[0];
    const dirs = parts.slice(1, -1);
    const base = parts[parts.length - 1].replace(/\.md$/, "");
    for (const d of dirs) if (!topics[d]) needTopic.add(d);
    const to = `${section}/${[...dirs, base].join("-")}.md`;
    if (nodeOfRel(to, schema).join("/") !== dirs.join("/")) ambiguous.push({ from: rel, to });
    if (byTarget.has(to)) collisions.push({ from: rel, other: byTarget.get(to), to });
    byTarget.set(to, rel);
    moves.push({ from: rel, to, base, newBase: [...dirs, base].join("-"), text });
  }

  // Связь ведёт по имени файла, поэтому переезд рвёт её молча. Одного имени мало: до выпрямления
  // имена не были уникальны (пять файлов `measures.md`), и такая связь до сих пор попадала в
  // нужную запись только благодаря якорю. Значит и разрешать её надо по якорю
  const byBase = new Map();
  for (const m of moves) {
    if (!byBase.has(m.base)) byBase.set(m.base, []);
    byBase.get(m.base).push({ newBase: m.newBase, anchors: headingAnchors(m.text) });
  }
  const brokenLinks = [];
  let rewritten = 0;
  const relink = (text, at) => text.replace(/\[\[([^\]]+)\]\]/g, (whole, target) => {
    const [name, anchor] = String(target).split("#");
    const candidates = byBase.get(name);
    if (!candidates) return whole;
    const fit = candidates.length === 1 ? candidates
      : candidates.filter((c) => anchor && c.anchors.has(anchor));
    if (fit.length !== 1) { brokenLinks.push({ at, link: whole }); return whole; }
    rewritten++;
    return `[[${fit[0].newBase}${anchor ? `#${anchor}` : ""}]]`;
  });
  for (const m of moves) m.text = relink(m.text, m.from);
  // Ссылаться на переехавшую запись может и тот, кто сам остаётся на месте: он лежит прямо в
  // корне раздела и переезда не требует, а связь у него рвётся точно так же
  const moved = new Set(moves.map((m) => m.from));
  const touched = [];
  for (const { rel, text } of files) {
    if (moved.has(rel)) continue;
    const out = relink(text, rel);
    if (out !== text) touched.push({ rel, text: out });
  }

  const blocked = needTopic.size > 0 || ambiguous.length > 0 || collisions.length > 0;
  return { moves, touched, needTopic: [...needTopic], ambiguous, collisions, brokenLinks, rewritten, blocked };
}

/**
 * Зоны прежних знаний, которые по смыслу относятся к продукту, а не к процессу.
 *
 * Умолчание - процесс, и оно не случайно: прежние знания копились как приёмы работы, а не как
 * факты о продукте. На живом корпусе из 64 записей зоны порта ни одна не несла якоря на код -
 * это знание о том, КАК переносить, а не о том, ЧТО перенесено. Раздел меняется флагом `--zone`.
 */
export const PRODUCT_ZONES = [];

/**
 * Строки прежнего указателя: заголовок, предмет, зона, файл. Секции указателя - этапы флоу,
 * одна запись может стоять в нескольких.
 */
export function parseLegacyIndex(text) {
  const rows = new Map();
  let stage = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^##\s+(\S+)/.exec(line);
    if (h) { stage = h[1]; continue; }
    // Путь к записи в прежнем указателе встречается тремя видами: markdown-ссылкой,
    // в обратных кавычках и голым текстом - проекты вели указатель по-разному
    const m = /^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*(?:\[[^\]]*\]\(([^)]+)\)|`([^`]+)`|([^|]+?))\s*\|/.exec(line);
    if (!m) continue;
    const [, heading, subject, zone] = m;
    const href = m[4] ?? m[5] ?? m[6] ?? "";
    if (heading === "запись" || heading.toLowerCase() === "запись") continue;
    if (!href.endsWith(".md")) continue;
    const key = href.replace(/^\.\//, "");
    const prev = rows.get(key) ?? { heading, subject, zone, stages: [] };
    if (stage && !prev.stages.includes(stage)) prev.stages.push(stage);
    rows.set(key, prev);
  }
  return rows;
}

/** Раздел назначения для зоны: встроенная таблица плюс переопределения флагами. */
export function sectionForZone(zone, overrides = {}) {
  if (overrides[zone]) return overrides[zone];
  return PRODUCT_ZONES.includes(zone) ? "project" : "process";
}

/**
 * План переноса: что куда ляжет и каким станет текст. Ничего не пишет.
 * Возвращает и перечень того, что доводить руками: без предмета, без типа.
 *
 * Перенос - копия, а не синхронизация: источник остаётся на месте. Поэтому запись, у которой
 * файл назначения уже есть, помечается как перенесённая и повторно НЕ переписывается - иначе
 * второй прогон затёр бы доведённые руками поля свежей копией устаревшего источника.
 */
export function planMigration({ files, legacyIndex, overrides = {}, schema = DEFAULTS, targetExists = () => false }) {
  const known = new Set(Object.keys(schema.sections ?? DEFAULTS.sections));
  const items = [];
  const already = [];
  const needSubject = [];
  const needType = [];

  for (const { rel, text } of files) {
    if (/(^|\/)INDEX\.md$/i.test(rel)) continue;
    const parts = rel.split("/");
    const zone = parts.length > 1 ? parts[0] : "";
    const name = parts[parts.length - 1];
    const section = sectionForZone(zone, overrides);
    if (!known.has(section)) continue;
    const meta = legacyIndex.get(rel) ?? legacyIndex.get(name) ?? {};

    const hasType = /\*\*тип:\*\*/.test(text);
    const hasSubject = /\*\*предмет:\*\*/.test(text);
    let out = text;
    const add = [];
    if (!/\*\*раздел:\*\*/.test(text)) add.push(`**раздел:** ${section}`);
    if (!hasSubject && meta.subject) add.push(`**предмет:** ${meta.subject}`);
    if (add.length) {
      // Дописываем к существующему блоку полей: он идёт сразу за заголовком первого уровня
      const zoneLine = /^\*\*зона:\*\*.*$/m.exec(out);
      if (zoneLine) out = out.replace(zoneLine[0], `${zoneLine[0]}\n${add.join("\n")}`);
      else out = out.replace(/^(#\s+.+\n)/, `$1\n${add.join("\n")}\n`);
    }
    const target = `${section}/${zone ? `${zone}/` : ""}${name}`;
    if (targetExists(target)) { already.push(target); continue; }
    items.push({ from: rel, to: target, zone, section, text: out });
    if (!hasSubject && !meta.subject) needSubject.push(target);
    if (!hasType) needType.push(target);
  }
  return { items, already, needSubject, needType };
}
