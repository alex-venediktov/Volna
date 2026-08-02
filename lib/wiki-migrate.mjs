/**
 * Перенос накопленных знаний прежней раскладки (`.volna/knowledge/`) в вики выводов.
 *
 * Механически переносится то, что есть в источнике: файл записи, зона, этапы и колонка «предмет»
 * из прежнего указателя. Тип записи из старого формата не выводится - его проставляет человек,
 * и до тех пор линт честно показывает нехватку поля.
 */
import { DEFAULTS } from "./wiki.mjs";

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
    const m = /^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*\[[^\]]*\]\(([^)]+)\)\s*\|/.exec(line);
    if (!m) continue;
    const [, heading, subject, zone, href] = m;
    if (heading === "Запись") continue;
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
