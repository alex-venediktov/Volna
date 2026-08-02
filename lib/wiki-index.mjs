/**
 * Сборка указателей вики. Указатель - маршрутизатор, а не контейнер: строка на каждый вывод,
 * колонка «предмет» существует затем, чтобы этап отбирал строку, не открывая файл.
 *
 * Шардирование обязательно, а не опционально: при тысячах записей плоский указатель нежизнеспособен.
 * Ось дробления задаёт проект в `SCHEMA.md` ключом `index.shard_by`, потому что осей две и выбор
 * между ними - свойство корпуса, а не инструмента. `stage` (по умолчанию) режет по этапу флоу:
 * этап открывает свою секцию. `topic` режет по подкаталогам раздела и делает это рекурсивно, пока
 * узел не уместится в порог: получается дерево, по которому задача спускается к одному листу,
 * читая по дороге только оглавления. Оглавление несёт предметы и этапы каждого узла - маршрут
 * выбирается по ним, без открытия ветки.
 */
import { DEFAULTS } from "./wiki.mjs";

const HINT = [
  "Строка на каждый вывод. Колонка «предмет» существует затем, чтобы этап отбирал строку,",
  "не открывая файл. Файл собирается инструментом, ручные правки будут затёрты.",
];

const ROUTE_HINT = [
  "Маршрут выбирается по колонкам «предметы» и «этапы»: открывать нужно один узел, а не раздел.",
  "Подходит несколько - открывать по одному, начиная с того, где предметы ближе к задаче.",
];

export const INDEX_DEFAULTS = { shard_by: ["stage"], topic_depth: 1 };

/** Путь от каталога файла указателя к корню вики: адреса записей хранятся от корня. */
function upPrefix(rel) {
  return "../".repeat(rel.split("/").length - 1);
}

function table(rows, prefix, groupByTopic) {
  const out = [];
  const byTopic = {};
  for (const r of rows) (byTopic[r.rel.split("/").slice(0, -1).join("/") || "."] ??= []).push(r);
  const many = groupByTopic && rows.length > 15 && Object.keys(byTopic).length > 1;
  // Деление по темам оправдано только на длинной секции: иначе три записи из разных подкаталогов
  // дают три таблицы подряд без заголовков, и секция читается как обрывки
  const groups = many ? Object.entries(byTopic) : [[null, rows]];
  for (const [topic, trs] of groups) {
    if (topic) out.push(`### ${topic}`, "");
    out.push("| Запись | Предмет | Тип | Файл |", "|---|---|---|---|");
    for (const r of [...trs].sort((a, b) => a.heading.localeCompare(b.heading, "ru"))) {
      out.push(`| ${r.heading} | ${r.subject} | ${r.type} | [${r.rel}](${prefix}${r.rel}#${r.anchor}) |`);
    }
    out.push("");
  }
  return out;
}

/** Этапы записей в порядке флоу; неизвестные уходят в конец. */
function stagesOf(rows, order) {
  return [...new Set(rows.flatMap((r) => r.stages))]
    .sort((a, b) => (order.indexOf(a) + 99) % 100 - (order.indexOf(b) + 99) % 100);
}

/** Предметы узла, частые первыми: по ним выбирают ветку, не открывая её. */
function subjectsOf(rows, take = 5) {
  const n = {};
  for (const r of rows) if (r.subject) n[r.subject] = (n[r.subject] ?? 0) + 1;
  return Object.entries(n).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))
    .slice(0, take).map(([s]) => s);
}

/**
 * Что внутри узла: описание сегмента из `SCHEMA.md` (ключ `topics`), а где его не задали -
 * частые предметы записей. Описание существует затем, чтобы ветку выбирали, не открывая.
 */
function describe(seg, rows, topics) {
  const own = topics?.[seg];
  const subjects = subjectsOf(rows, own ? 2 : 4).join(", ");
  return own ? `${own}${subjects ? ` (${subjects})` : ""}` : subjects;
}

/** Тело листа: секция на этап, внутри таблица записей этого этапа. */
function leafBody(title, rows, order, rel) {
  const body = [`# ${title}`, "", ...HINT, ""];
  for (const st of stagesOf(rows, order)) {
    const stRows = rows.filter((r) => r.stages.includes(st));
    if (stRows.length) body.push(`## ${st}`, "", ...table(stRows, upPrefix(rel), true));
  }
  return body;
}

/**
 * Планирует содержимое указателей, ничего не записывая: возвращает список файлов, множество
 * адресов записей, попавших в указатель (его ждёт проверка K001), и карту «запись -> лист
 * указателя», по которой команда `route` называет маршрут.
 */
export function planIndexes(records, schema = DEFAULTS) {
  const limits = { ...DEFAULTS.limits, ...(schema.limits ?? {}) };
  const order = schema.stages ?? DEFAULTS.stages;
  const idx = { ...INDEX_DEFAULTS, ...(schema.index ?? {}) };
  const shardBy = idx.shard_by ?? INDEX_DEFAULTS.shard_by;
  const topics = schema.topics ?? {};
  const topicFirst = shardBy[0] === "topic";
  const byStageToo = !topicFirst || shardBy.includes("stage");
  const bySection = {};
  for (const r of records) (bySection[r.section] ??= []).push(r);

  const files = [];
  const indexed = new Set();
  const sharded = [];
  const placed = new Map();

  const at = (r) => `${r.rel}#${r.anchor}`;
  const nodeRel = (section, segs) => (segs.length ? `${section}/indexes/${segs.join("/")}/INDEX.md` : `${section}/INDEX.md`);
  const stageRel = (section, segs, st) => (segs.length ? `${section}/indexes/${segs.join("/")}/${st}.md` : `${section}/indexes/${st}.md`);
  const linkFromNode = (segs, tail) => (segs.length ? tail : `indexes/${tail}`);

  /** Сегмент пути записи на глубине узла: имя подкаталога либо null, если запись лежит здесь. */
  const segmentAt = (r, depth) => {
    const parts = r.rel.split("/");
    return depth + 1 < parts.length - 1 ? parts[depth + 1] : null;
  };

  /** Лист: таблицы записей. Крупный лист режется по этапу, и тогда узел становится оглавлением. */
  function emitLeaf(section, segs, rows, title) {
    const rel = nodeRel(section, segs);
    const body = leafBody(title, rows, order, rel);
    if (!byStageToo || body.length <= limits.index_file_lines) {
      files.push({ rel, text: body.join("\n") });
      for (const r of rows) placed.set(at(r), rel);
      return;
    }
    const toc = [`# ${title}`, "", "Узел разбит по этапам: превышен порог строк на файл.", "", ...ROUTE_HINT, "",
      "| Этап | Записей | Предметы | Файл |", "|---|---|---|---|"];
    for (const st of stagesOf(rows, order)) {
      const stRows = rows.filter((r) => r.stages.includes(st));
      if (!stRows.length) continue;
      const stRel = stageRel(section, segs, st);
      files.push({ rel: stRel, text: [`# ${title}: этап ${st}`, "", ...HINT, "", ...table(stRows, upPrefix(stRel), true)].join("\n") });
      for (const r of stRows) if (!placed.has(at(r))) placed.set(at(r), stRel);
      const link = linkFromNode(segs, `${st}.md`);
      toc.push(`| ${st} | ${stRows.length} | ${subjectsOf(stRows, 4).join(", ")} | [${link}](${link}) |`);
    }
    files.push({ rel, text: toc.join("\n") });
  }

  /** Узел дерева: помещается - лист, не помещается - оглавление по подкаталогам и рекурсия. */
  function emitNode(section, segs, rows) {
    const title = segs.length ? `Указатель ${section}: ${segs.join("/")}` : `Указатель раздела ${section}`;
    const rel = nodeRel(section, segs);
    if (leafBody(title, rows, order, rel).length <= limits.index_file_lines) {
      emitLeaf(section, segs, rows, title);
      return;
    }
    // Цепочка из одного подкаталога промежуточного оглавления не заслуживает: спускаемся молча
    let path = segs;
    let groups = groupBySegment(rows, path.length);
    while (groups.size === 1 && !groups.has(null)) {
      path = [...path, [...groups.keys()][0]];
      groups = groupBySegment(rows, path.length);
    }
    if (groups.size === 0 || (groups.size === 1 && groups.has(null))) {
      emitLeaf(section, path, rows, title);
      return;
    }
    const nodeRelHere = nodeRel(section, path);
    const toc = [`# ${title}`, "", "Узел разбит по темам: превышен порог строк на файл.", "", ...ROUTE_HINT, "",
      "| Узел | Записей | Этапы | Что внутри | Файл |", "|---|---|---|---|---|"];
    for (const [seg, rs2] of [...groups.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), "ru"))) {
      if (seg === null) {
        // Записи, лежащие файлами прямо в этом каталоге, уходят в лист «_»
        const leafSegs = [...path, "_"];
        emitLeaf(section, leafSegs, rs2, `${title}: записи каталога`);
        const link = linkFromNode(path, "_/INDEX.md");
        toc.push(`| (файлы каталога) | ${rs2.length} | ${stagesOf(rs2, order).join(", ")} | ${subjectsOf(rs2, 4).join(", ")} | [${link}](${link}) |`);
        continue;
      }
      emitNode(section, [...path, seg], rs2);
      const link = linkFromNode(path, `${seg}/INDEX.md`);
      toc.push(`| ${seg} | ${rs2.length} | ${stagesOf(rs2, order).join(", ")} | ${describe(seg, rs2, topics)} | [${link}](${link}) |`);
    }
    files.push({ rel: nodeRelHere, text: toc.join("\n") });
    // Оглавление сжатой цепочки: путь к нему должен быть виден из корня раздела
    if (nodeRelHere !== rel) {
      const link = linkFromNode(segs, `${path.slice(segs.length).join("/")}/INDEX.md`);
      files.push({
        rel,
        text: [`# ${title}`, "", "Узел содержит единственную ветку.", "",
          "| Узел | Записей | Файл |", "|---|---|---|",
          `| ${path.slice(segs.length).join("/")} | ${rows.length} | [${link}](${link}) |`].join("\n"),
      });
    }
  }

  function groupBySegment(rows, depth) {
    const g = new Map();
    for (const r of rows) {
      const seg = segmentAt(r, depth);
      if (!g.has(seg)) g.set(seg, []);
      g.get(seg).push(r);
    }
    return g;
  }

  for (const [section, rs] of Object.entries(bySection)) {
    for (const r of rs) if (r.stages.length) indexed.add(at(r));
    const flatRel = `${section}/INDEX.md`;
    const flat = leafBody(`Указатель раздела ${section}`, rs, order, flatRel);
    if (flat.length <= limits.index_file_lines) {
      files.push({ rel: flatRel, text: flat.join("\n") });
      for (const r of rs) placed.set(at(r), flatRel);
      continue;
    }
    sharded.push(section);
    if (topicFirst) { emitNode(section, [], rs); continue; }
    const toc = [`# Указатель раздела ${section}`, "",
      "Указатель разбит по этапам: превышен порог строк на файл. Этап открывает только свой файл.", "",
      "| Этап | Записей | Файл |", "|---|---|---|"];
    for (const st of stagesOf(rs, order)) {
      const rows = rs.filter((r) => r.stages.includes(st));
      if (!rows.length) continue;
      const rel = `${section}/indexes/${st}.md`;
      files.push({ rel, text: [`# Указатель раздела ${section}: этап ${st}`, "", ...HINT, "", ...table(rows, upPrefix(rel), true)].join("\n") });
      for (const r of rows) if (!placed.has(at(r))) placed.set(at(r), rel);
      toc.push(`| ${st} | ${rows.length} | [indexes/${st}.md](indexes/${st}.md) |`);
    }
    files.push({ rel: flatRel, text: toc.join("\n") });
  }

  const root = ["# Указатель", "", "Оглавление разделов. Содержание - в указателе раздела.", "",
    "| Раздел | Записей | Указатель |", "|---|---|---|"];
  for (const [section, rs] of Object.entries(bySection).sort()) {
    root.push(`| ${section} | ${rs.length} | [${section}/INDEX.md](${section}/INDEX.md) |`);
  }
  files.push({ rel: "INDEX.md", text: root.join("\n") });

  return { files, indexed, sharded, placed };
}

/** Слова текста, годные для сопоставления: три буквы и длиннее, регистр снят. */
export function keywords(text) {
  return [...new Set(String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
}

/**
 * Сопоставление текста с деревом каталогов вики: одно ядро на два входа - «куда положить новую
 * запись» и «какой указатель открыть под задачу». Вес считается по сегментам пути (они и есть
 * тема), по описанию темы из `SCHEMA.md`, по предметам и заголовкам записей узла.
 */
export function matchDirs(records, text, schema = DEFAULTS) {
  const topics = schema.topics ?? {};
  const words = keywords(text);
  const byDir = new Map();
  for (const r of records) {
    const dir = r.rel.split("/").slice(0, -1).join("/");
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(r);
  }
  const scored = [];
  for (const [dir, rows] of byDir) {
    const segs = dir.split("/");
    const segText = segs.join(" ").toLowerCase();
    const topicText = segs.map((s) => topics[s] ?? "").join(" ").toLowerCase();
    const subjText = rows.map((r) => r.subject ?? "").join(" ").toLowerCase();
    const headText = rows.map((r) => r.heading ?? "").join(" ").toLowerCase();
    let score = 0;
    const covered = [];
    for (const w of words) {
      // Сегмент пути весит больше предмета: он и есть заявленная тема узла, а предмет - частность
      const s = (segText.includes(w) ? 4 : 0) + (topicText.includes(w) ? 3 : 0)
        + (subjText.includes(w) ? 2 : 0) + (headText.includes(w) ? 1 : 0);
      if (s) { score += s; covered.push(w); }
    }
    // Доля покрытых слов запроса на живой фразе всегда мала: в ней полно слов не про тему.
    // Узнан узел или нет, показывают его собственные сегменты - сколько из них назвала задача
    const own = segs.slice(1);
    const hitSegs = own.filter((s) => words.some((w) => s.toLowerCase().includes(w) || String(topics[s] ?? "").toLowerCase().includes(w)));
    if (score) {
      scored.push({
        dir, rows, score, covered,
        coverage: covered.length / (words.length || 1),
        segments: own.length,
        segmentHits: hitSegs.length,
        segmentCoverage: own.length ? hitSegs.length / own.length : 0,
      });
    }
  }
  scored.sort((a, b) => b.segmentHits - a.segmentHits || b.score - a.score || a.dir.localeCompare(b.dir, "ru"));
  return { words, dirs: scored };
}

/**
 * Куда положить новую запись. Возвращает подходящий каталог существующей иерархии, а когда такого
 * нет - предложение завести узел: родителем берётся ближайший частично совпавший каталог, именем
 * слово задачи, которого в дереве ещё нет. Новая ветка заводится только на «не нашлось».
 */
export function planPlacement(records, text, schema = DEFAULTS, opts = {}) {
  const minSegments = opts.minSegments ?? 2;
  const minScore = opts.minScore ?? 6;
  const { words, dirs } = matchDirs(records, text, schema);
  const best = dirs[0];
  // Узел считается найденным, когда задача назвала его темы, а не отдельные слова записей
  const confident = Boolean(best) && best.score >= minScore
    && best.segmentHits >= Math.min(minSegments, best.segments);
  const result = {
    words,
    dir: best?.dir ?? null,
    score: best?.score ?? 0,
    coverage: best ? Number(best.coverage.toFixed(2)) : 0,
    segmentHits: best?.segmentHits ?? 0,
    confident,
    alternatives: dirs.slice(1, 4).map((d) => ({ dir: d.dir, score: d.score })),
    suggestion: null,
  };
  if (confident) return result;
  // Родителем нового узла годится только тот, чью тему задача действительно назвала: иначе
  // ветка прирастает к случайному соседу и дерево перестаёт что-либо значить
  const near = best && best.segmentHits >= 1 ? best.dir : null;
  const parent = near ?? best?.dir.split("/")[0] ?? [...new Set(records.map((r) => r.section))].sort()[0] ?? "reference";
  const known = new Set(records.flatMap((r) => r.rel.split("/")).map((s) => s.replace(/\.md$/, "").toLowerCase()));
  const fresh = words.filter((w) => !known.has(w));
  // Имя узла не выдумывается за человека: латинское слово предложить можно, кириллицу - нет,
  // потому что узлы именуются латиницей и одним словом
  const name = fresh.find((w) => /^[a-z0-9-]+$/.test(w)) ?? null;
  result.suggestion = { dir: name ? `${parent}/${name}` : `${parent}/<новый узел>`, parent, name, unmatched: fresh.slice(0, 6) };
  return result;
}

/**
 * Маршрут к записям по словам задачи. Считает вес совпадения по предмету, заголовку, пути и типу,
 * складывает его по листам указателя и возвращает ветки, которые стоит открыть, - вместе с самими
 * записями, попавшими в счёт.
 */
export function planRoute(records, query, schema = DEFAULTS, take = 5) {
  const { placed } = planIndexes(records, schema);
  const words = String(query).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  if (!words.length) return { words, routes: [], hits: [] };
  const norm = (s) => String(s ?? "").toLowerCase();
  const hits = [];
  for (const r of records) {
    let score = 0;
    const matched = [];
    for (const w of words) {
      const inSubject = norm(r.subject).includes(w);
      const inHeading = norm(r.heading).includes(w);
      const inPath = norm(r.rel).includes(w);
      const inType = norm(r.type).includes(w);
      const s = (inSubject ? 3 : 0) + (inHeading ? 2 : 0) + (inPath ? 2 : 0) + (inType ? 1 : 0);
      if (s) { score += s; matched.push(w); }
    }
    // Совпадение по одному слову из многих - обычно шум; требуем половину слов на длинном запросе
    if (score && matched.length >= Math.min(2, words.length)) {
      hits.push({ r, score, at: `${r.rel}#${r.anchor}`, index: placed.get(`${r.rel}#${r.anchor}`) });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.at.localeCompare(b.at, "ru"));
  const byIndex = new Map();
  for (const h of hits) {
    const key = h.index ?? "(вне указателя)";
    if (!byIndex.has(key)) byIndex.set(key, { rel: key, score: 0, rows: [] });
    const e = byIndex.get(key);
    e.score += h.score;
    e.rows.push(h.r);
  }
  const routes = [...byIndex.values()].sort((a, b) => b.score - a.score).slice(0, take)
    .map((e) => ({ rel: e.rel, score: e.score, count: e.rows.length, subjects: subjectsOf(e.rows, 4) }));
  return { words, routes, hits: hits.slice(0, take * 3) };
}
