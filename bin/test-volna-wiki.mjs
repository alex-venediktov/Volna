/**
 * Проверка вики выводов без файловой системы и без сети: корпус подаётся заглушками чтения.
 * Главное, что проверяется: правило длины цитаты и порядок проверок в нём, разбор обеих
 * раскладок записи, шардирование указателя по порогу и то, что без --fix ничего не пишется.
 *
 * Запуск: node bin/test-volna-wiki.mjs
 */
import { run, parseArgs, findRoot } from "./volna-wiki.mjs";
import { parseYamlSubset, loadSchema, slug, field, parseAnchors, readRecords, verifyAnchor, decodeSource, isIndexFile, nodeOf, DEFAULTS } from "../lib/wiki.mjs";
import { lint } from "../lib/wiki-lint.mjs";
import { planIndexes, planRoute, planPlacement, axisName } from "../lib/wiki-index.mjs";
import { parseLegacyIndex, planFlatten, planMigration, sectionForZone } from "../lib/wiki-migrate.mjs";

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${!cond && detail ? ` -> ${detail}` : ""}`);
  if (!cond) failures++;
}

const REC = `# Вид слева: масштаб

**раздел:** reference · **тема:** вид слева · **проверено:** 2026-08-02

## Масштаб ограничен так, что компонент не шире пятидесяти точек

**тип:** ограничение · **предмет:** масштаб вида · **этапы:** analyze, implement

**вывод:** после расчёта масштаба он пересчитывается, если компонент вышел шире порога.

**источник:**
- \`Ref/Unit.pas:3\` — \`MLeftView:=KompDicke/50;\`
- \`Ref/Unit.pas:5\` — \`razriv:=8;\`

**связи:** [[scale#высота-условная]]

## Высота условная

**тип:** ограничение · **предмет:** высота вида · **этапы:** implement

**вывод:** высота берётся константой и от реальной высоты изделия не зависит.

**источник:**
- \`Ref/Unit.pas:7\` — \`HLeftView:=220; //высота стекла на разрезе по умолчанию\`
`;

const SOURCE = [
  "unit Unit;",
  "begin",
  "  MLeftView:=KompDicke/50;",
  "  filler",
  "  razriv:=8;",
  "  filler",
  "  HLeftView:=220; //высота стекла на разрезе по умолчанию",
  "end.",
].join("\r\n");

const SCHEMA = `# Соглашения

\`\`\`yaml
sections:
  reference: {code: true}
limits:
  quote_min_chars: 15
  index_file_lines: 300
reference_roots:
  - {prefix: "Ref/", root: "/ref", encoding: auto, drift_window: 40}
\`\`\`
`;

function fakeDeps(extra = {}) {
  const written = {};
  return {
    written,
    cwd: "/w",
    exists: (p) => p.replace(/\\/g, "/").includes("/w/wiki"),
    listFiles: () => ["/w/wiki/reference/left-view/scale.md"],
    readFile: (p) => {
      const n = String(p).replace(/\\/g, "/");
      if (n.endsWith("SCHEMA.md")) return SCHEMA;
      if (n.endsWith("scale.md")) return written[n] ?? REC;
      throw new Error(`нет файла ${n}`);
    },
    readBuf: (p) => {
      const n = String(p).replace(/\\/g, "/");
      if (n.endsWith("Unit.pas")) return Buffer.from(SOURCE, "utf8");
      throw new Error(`нет файла ${n}`);
    },
    write: (p, t) => { written[String(p).replace(/\\/g, "/")] = t; },
    log: () => {},
    err: () => {},
    ...extra,
  };
}

// --- разбор соглашений
const y = parseYamlSubset(`sections:\n  reference: {code: true}\nlimits:\n  quote_min_chars: 15\nreference_roots:\n  - {prefix: "Ref/", root: "/ref"}\n`);
check("yaml: вложенное отображение", y.sections?.reference?.code === true, JSON.stringify(y.sections));
check("yaml: число", y.limits?.quote_min_chars === 15, JSON.stringify(y.limits));
check("yaml: список отображений", Array.isArray(y.reference_roots) && y.reference_roots[0].root === "/ref", JSON.stringify(y.reference_roots));
const schema = loadSchema("/w/wiki", fakeDeps());
check("соглашения: умолчания сохраняются", schema.types.includes("расхождение"));
check("соглашения: проектное перекрывает", schema.limits.quote_min_chars === 15);
check("соглашения: отсутствие файла не ошибка", loadSchema("/nope", { readFile: () => { throw new Error("нет"); } }).limits.record_lines === 20);

// --- поля и якоря
check("поле обрывается на разделителе", field("**тип:** ограничение · **предмет:** масштаб", "тип") === "ограничение",
  field("**тип:** ограничение · **предмет:** масштаб", "тип"));
check("якорь: путь, строка, цитата", parseAnchors("- `Ref/Unit.pas:3` — `MLeftView:=KompDicke/50;`")[0].line === 3);
check("слаг без пунктуации", slug("Масштаб ограничен: компонент не шире 50 точек") === "масштаб-ограничен-компонент-не-шире-50-точек", slug("Масштаб ограничен: компонент не шире 50 точек"));

// --- разбор записей: секции внутри файла
const { records, files } = readRecords("/w/wiki", fakeDeps());
check("запись на секцию, а не на файл", records.length === 2, String(records.length));
check("тип секции разобран", records[0].type === "ограничение", records[0].type);
check("этапы разобраны", records[0].stages.join(",") === "analyze,implement", records[0].stages.join(","));
check("файл учтён один", files.length === 1);

// --- сверка якорей: правило длины и порядок проверок
const v1 = verifyAnchor({ path: "Ref/Unit.pas", line: 3, quote: "MLeftView:=KompDicke/50;" }, schema, fakeDeps());
check("строка целиком - точно", v1.verdict === "точно", v1.verdict);
const v2 = verifyAnchor({ path: "Ref/Unit.pas", line: 5, quote: "razriv:=8;" }, schema, fakeDeps());
check("короткая строка целиком доказательна", v2.verdict === "точно", `${v2.verdict} - порядок проверок нарушен, короткий оператор забракован`);
const v3 = verifyAnchor({ path: "Ref/Unit.pas", line: 7, quote: "высота стекла на разрезе" }, schema, fakeDeps());
check("длинный фрагмент строки принят", v3.verdict === "точно, фрагмент", v3.verdict);
const v4 = verifyAnchor({ path: "Ref/Unit.pas", line: 7, quote: "220" }, schema, fakeDeps());
check("короткий фрагмент отвергнут", v4.verdict === "короткий фрагмент", v4.verdict);
const v5 = verifyAnchor({ path: "Ref/Unit.pas", line: 1, quote: "MLeftView:=KompDicke/50;" }, schema, fakeDeps());
check("сдвиг найден в окне", v5.verdict === "сдвинулось" && v5.line === 3, `${v5.verdict}:${v5.line}`);
const v6 = verifyAnchor({ path: "Ref/Unit.pas", line: 3, quote: "такого текста нет вовсе" }, schema, fakeDeps());
check("выдуманная цитата не найдена", v6.verdict === "не найдено", v6.verdict);
const v7 = verifyAnchor({ path: "Other/X.pas", line: 3, quote: "что угодно длинное" }, schema, fakeDeps());
check("необъявленный корень назван", v7.verdict === "корень не объявлен", v7.verdict);
check("cp1251 читается", decodeSource(Buffer.from([0xcf, 0xf0, 0xee, 0xe2])) === "Пров", decodeSource(Buffer.from([0xcf, 0xf0, 0xee, 0xe2])));
check("BOM снимается", decodeSource(Buffer.from([0xef, 0xbb, 0xbf, 0x41])) === "A");

// --- указатели
const plan = planIndexes(records, schema);
check("корневой указатель собран", plan.files.some((f) => f.rel === "INDEX.md"));
check("указатель раздела собран", plan.files.some((f) => f.rel === "reference/INDEX.md"));
check("адреса записей попали в указатель", plan.indexed.size === 2, String(plan.indexed.size));
const shardPlan = planIndexes(records, { ...schema, limits: { ...schema.limits, index_file_lines: 5 } });
check("порог превышен - шардирование по этапам", shardPlan.sharded.includes("reference") && shardPlan.files.some((f) => f.rel === "reference/INDEX--implement.md"),
  shardPlan.files.map((f) => f.rel).join(","));
const bytePlan = planIndexes(records, { ...schema, limits: { ...schema.limits, index_file_bytes: 200 } });
check("порог в байтах режет указатель, уместившийся по строкам", bytePlan.sharded.includes("reference"),
  bytePlan.files.map((f) => f.rel).join(","));

// Ось дробления решает инструмент, значит он же обязан её назвать: до правки строка вывода была
// жёсткой («по этапам») и лгала при shard_by: [topic]
check("план отдаёт наружу ось, по которой построен", shardPlan.axis === "по этапам", shardPlan.axis);
const topicAxis = planIndexes(records, {
  ...schema, index: { shard_by: ["topic"] }, limits: { ...schema.limits, index_file_lines: 5 },
});
check("ось topic называется темами, а не этапами", topicAxis.axis === "по темам", topicAxis.axis);
check("две оси называются обе", axisName(["topic", "stage"]) === "по темам и по этапам", axisName(["topic", "stage"]));
check("незнакомая ось печатается как есть, а не молчит", axisName(["zone"]) === "zone", axisName(["zone"]));

// Записи одного этапа из разных подкаталогов: до 15 строк секция остаётся одной таблицей
const topicRecord = (topic, n) => ({
  rel: `volna/${topic}/${n}.md`, section: "volna", heading: `Вывод ${topic} ${n}`,
  anchor: `вывод-${topic}-${n}`, subject: topic, type: "порядок", stages: ["plan"],
});
const shortIdx = planIndexes([topicRecord("flow", 1), topicRecord("journal", 2)], schema)
  .files.find((f) => f.rel === "volna/INDEX.md").text;
check("лист - одна таблица", (shortIdx.match(/^\| Куда \|/gm) ?? []).length === 1,
  String((shortIdx.match(/^\| Куда \|/gm) ?? []).length));
check("лист без заголовков тем", !/^### /m.test(shortIdx));
const longRows = Array.from({ length: 16 }, (_, i) => topicRecord(i % 2 ? "flow" : "journal", i));
const longIdx = planIndexes(longRows, schema).files.find((f) => f.rel === "volna/INDEX.md").text;
check("длинный лист остаётся одной таблицей: этап колонкой, а не секцией",
  (longIdx.match(/^\| Куда \|/gm) ?? []).length === 1 && !/^## /m.test(longIdx),
  longIdx.split("\n").filter((l) => l.startsWith("#")).join(","));
check("запись в листе встречается один раз, а не по разу на этап",
  (longIdx.match(/Вывод flow 1\]/g) ?? []).length === 1,
  String((longIdx.match(/Вывод flow 1\]/g) ?? []).length));

// Дерево узлов: ось topic режет по подкаталогам рекурсивно, пока узел не уместится в порог
const deepRecord = (path, n, stage = "implement") => ({
  rel: `reference/${path}/${n}.md`, section: "reference", heading: `Вывод ${path} ${n}`,
  anchor: `вывод-${path.replace(/\//g, "-")}-${n}`, subject: path.split("/").pop(), type: "порядок", stages: [stage],
});
const deepRows = [
  ...Array.from({ length: 8 }, (_, i) => deepRecord("export/kompas/leftview", i)),
  ...Array.from({ length: 8 }, (_, i) => deepRecord("export/kompas/downview", i)),
  ...Array.from({ length: 8 }, (_, i) => deepRecord("screen/leftview", i)),
];
const topicSchema = { ...schema, index: { shard_by: ["topic", "stage"] }, limits: { ...schema.limits, index_file_lines: 14 } };
const treePlan = planIndexes(deepRows, topicSchema);
const treeRels = treePlan.files.map((f) => f.rel);
check("узел раздела делится по первому сегменту", treeRels.includes("reference/INDEX.md") && /\| \[export\]/.test(treePlan.files.find((f) => f.rel === "reference/INDEX.md").text),
  treeRels.join(","));
check("одиночная цепочка сжата: export/kompas одним узлом", treeRels.includes("reference/INDEX-export-kompas.md"), treeRels.join(","));
check("лист лежит на своей глубине", treeRels.includes("reference/INDEX-export-kompas-leftview.md"), treeRels.join(","));
check("все указатели раздела лежат в его корне", treeRels.filter((r) => r !== "INDEX.md").every((r) => /^reference\/INDEX(-|\.)/.test(r)),
  treeRels.join(","));
check("оглавление узла несёт колонки описания, предмета и типа",
  /\| Куда \| Вид \| Предмет \| Тип \| Этапы \| Описание \|/.test(treePlan.files.find((f) => f.rel === "reference/INDEX-export-kompas.md").text));
// Порог теста мал, поэтому лист сверх него дробится ещё и по этапу - вторым суффиксом имени
const leafText = treePlan.files.find((f) => f.rel === "reference/INDEX-export-kompas-leftview--implement--1.md").text;
check("ссылка на запись идёт от корня раздела, без цепочки вверх",
  leafText.includes("(export/kompas/leftview/") && !leafText.includes("../"),
  leafText.split("\n").find((l) => l.startsWith("| [Вывод")));
check("карта размещения ведёт к листу", treePlan.placed.get("reference/export/kompas/leftview/0.md#вывод-export-kompas-leftview-0") === "reference/INDEX-export-kompas-leftview--implement--1.md",
  String(treePlan.placed.get("reference/export/kompas/leftview/0.md#вывод-export-kompas-leftview-0")));

const route = planRoute(deepRows, "экспорт kompas leftview", topicSchema);
check("маршрут ведёт в нужный лист", route.routes[0]?.rel === "reference/INDEX-export-kompas-leftview--implement--1.md",
  route.routes.map((r) => r.rel).join(","));
check("запрос из одного слова маршрут выдаёт: половины слов требовать не от чего",
  planRoute(deepRows, "downview", topicSchema).routes.length > 0);

// --- отбор маршрута по словоформе: запись обязана находиться не только теми словами, которыми
// её писали. Корпус кириллический: приведение основ существует ради русской морфологии
const ruRecord = (slug, subject, heading) => ({
  rel: `volna/${slug}.md`, section: "volna", heading, anchor: slug,
  subject, type: "порядок", stages: ["analyze"],
});
const ruRows = [
  ruRecord("flow-profile", "профиль проекта", "Профиль решает, какие шаги в проекте существуют"),
  ruRecord("wiki-index-budget", "порог указателя", "Бюджет считается в байтах, а не в строках"),
  ruRecord("wiki-index-built", "указатели вики", "Указатели собираются инструментом, а не пишутся"),
  ruRecord("notify-channel", "канал ntfy", "Канал отдаёт 403 без токена"),
  ruRecord("wiki-types", "конфликт типов", "Конфликт требует исхода, расхождение - области"),
  ruRecord("deliver-path", "разрешённый путь", "Путь доставки объявлен в профиле"),
];

// Множественное число предмета: до приведения основ запрос находил ноль, и пустой ответ читался
// как «записей по теме нет»
const plural = planRoute(ruRows, "профили проекта", schema);
check("словоформа предмета находит запись: «профили проекта» ведёт к «профиль проекта»",
  plural.hits.length === 1 && plural.hits[0].at.startsWith("volna/flow-profile.md"),
  plural.hits.map((h) => h.at).join(","));
check("словоформа работает и на одном слове: «порогов» ведёт к «порог указателя»",
  planRoute(ruRows, "порогов", schema).hits.some((h) => h.at.startsWith("volna/wiki-index-budget.md")),
  planRoute(ruRows, "порогов", schema).hits.map((h) => h.at).join(","));

// Порог общей основы - пять знаков: на четырёх однокоренными становятся слова, которые ими не
// являются, и указатель начинает отвечать на что угодно
check("общее начало из четырёх знаков основой не считается: «порода» не ведёт к «порогу»",
  planRoute(ruRows, "порода", schema).hits.length === 0,
  planRoute(ruRows, "порода", schema).hits.map((h) => h.at).join(","));
check("короткое имя собственное ищется точным вхождением, а не основой",
  planRoute(ruRows, "ntfy", schema).hits.length === 1
  && planRoute(ruRows, "конфета", schema).hits.length === 0,
  `${planRoute(ruRows, "ntfy", schema).hits.length} / ${planRoute(ruRows, "конфета", schema).hits.length}`);
check("«ё» и «е» в запросе не различаются",
  planRoute(ruRows, "разрешенный путь", schema).hits.some((h) => h.at.startsWith("volna/deliver-path.md")),
  planRoute(ruRows, "разрешенный путь", schema).hits.map((h) => h.at).join(","));

// Отсев хвоста относителен: слабое совпадение по одному частому слову годится, когда сильного нет,
// и становится шумом, когда есть. Без этого «указатели вики» отдавал каждую запись со словом «вики»
const strong = planRoute(ruRows, "указатели вики", schema);
check("сильное совпадение по предмету подавляет слабое по частому слову",
  strong.hits.length === 1 && strong.hits[0].at.startsWith("volna/wiki-index-built.md"),
  strong.hits.map((h) => `${h.at}=${h.score}`).join(","));
const weakOnly = planRoute(ruRows.filter((r) => r.rel !== "volna/wiki-index-built.md"), "указатели вики", schema);
check("то же слабое совпадение выдаётся, когда сильного в корпусе нет",
  weakOnly.hits.some((h) => h.at.startsWith("volna/wiki-index-budget.md")),
  weakOnly.hits.map((h) => h.at).join(","));
check("чужая тема маршрута не получает",
  planRoute(ruRows, "термическая обработка стекла", schema).hits.length === 0,
  planRoute(ruRows, "термическая обработка стекла", schema).hits.map((h) => h.at).join(","));

// --- размещение новой записи в существующей иерархии
const placeHit = planPlacement(deepRows, "Размеры на виде leftview в kompas при экспорте идут другим шагом", topicSchema);
check("место найдено в существующем узле", placeHit.confident && placeHit.dir === "reference/export/kompas/leftview",
  `${placeHit.dir} conf=${placeHit.confident}`);
const placeMiss = planPlacement(deepRows, "Термическая обработка стекла и печь закалки", topicSchema);
check("чужая тема места не находит", !placeMiss.confident, `${placeMiss.dir} conf=${placeMiss.confident}`);
check("для чужой темы предложен новый узел", Boolean(placeMiss.suggestion?.dir), JSON.stringify(placeMiss.suggestion));

// --- линт
const findings = lint({ records, files, schema, indexed: plan.indexed, verify: (a) => verifyAnchor(a, schema, fakeDeps()) });
const codes = new Set(findings.map((f) => f.code));
check("линт молчит про целые записи", !codes.has("K005") && !codes.has("K009"), [...codes].join(","));
check("сирота по умолчанию не ищется", !findings.some((f) => f.code === "K004"), [...codes].join(","));
const withOrphans = lint({ records, files, schema: { ...schema, checks: { orphans: true } }, indexed: plan.indexed });
check("сирота находится при включённой проверке", withOrphans.some((f) => f.code === "K004" && f.at.includes("масштаб-ограничен")),
  withOrphans.map((f) => f.code).join(","));
const broken = lint({
  records: [{ ...records[0], links: ["нет-такой-записи"], has: records[0].has }],
  files, schema, indexed: plan.indexed,
});
check("битая связь найдена", broken.some((f) => f.code === "K003"));
const noType = { ...records[1], type: "выдуманный", has: records[1].has };
check("тип вне списка найден", lint({ records: [noType], files, schema }).some((f) => f.code === "K007"));

// --- CLI: без --fix ничего не пишется
const d1 = fakeDeps();
check("index без --fix не пишет", await run(["index", "--root", "/w/wiki"], d1) === 0 && Object.keys(d1.written).length === 0,
  Object.keys(d1.written).join(","));
const d2 = fakeDeps();
await run(["index", "--root", "/w/wiki", "--fix"], d2);
check("index --fix записывает указатели", Object.keys(d2.written).some((p) => p.endsWith("INDEX.md")), Object.keys(d2.written).join(","));
const d3 = fakeDeps();
const codeVerify = await run(["verify", "--root", "/w/wiki"], d3);
check("verify на целом корпусе даёт ноль", codeVerify === 0, String(codeVerify));
check("verify ничего не пишет", Object.keys(d3.written).length === 0);
const d4 = fakeDeps();
const codeLint = await run(["lint", "--root", "/w/wiki"], d4);
check("lint на чистом корпусе возвращает ноль", codeLint === 0, String(codeLint));
check("неизвестная команда - код 3", await run(["чепуха", "--root", "/w/wiki"], fakeDeps()) === 3);

// --- CLI: выключенная сверка называется вслух. «с якорями: 0» и чистый линт при пустых корнях
// читаются как «всё в порядке», хотя K016 не выполнялся вовсе и локаторы живут непроверенными
const SCHEMA_NO_ROOTS = SCHEMA.replace(/reference_roots:\n  - \{[^}]*\}\n/, "");
const collect = (extra = {}) => {
  const out = [];
  return { deps: fakeDeps({ log: (s) => out.push(String(s)), ...extra }), out };
};
const noRootsRead = (p) => (String(p).replace(/\\/g, "/").endsWith("SCHEMA.md")
  ? SCHEMA_NO_ROOTS : fakeDeps().readFile(p));

const statsOff = collect({ readFile: noRootsRead });
await run(["stats", "--root", "/w/wiki"], statsOff.deps);
check("stats без reference_roots говорит, что сверка выключена",
  statsOff.out.some((l) => l.includes("якоря не сверяются")), statsOff.out.join(" | "));
const statsOn = collect();
await run(["stats", "--root", "/w/wiki"], statsOn.deps);
check("stats с объявленным корнем о сверке молчит",
  !statsOn.out.some((l) => l.includes("якоря не сверяются")), statsOn.out.join(" | "));

const lintOff = collect({ readFile: noRootsRead });
await run(["lint", "--root", "/w/wiki"], lintOff.deps);
check("lint без reference_roots признаётся, что K016 не выполнялся",
  lintOff.out.some((l) => l.includes("якоря не проверялись")), lintOff.out.join(" | "));
const lintOn = collect();
await run(["lint", "--root", "/w/wiki"], lintOn.deps);
check("lint с объявленным корнем о сверке молчит",
  !lintOn.out.some((l) => l.includes("якоря не проверялись")), lintOn.out.join(" | "));

// Вика, развёрнутая со выключенной сверкой, копит непроверяемые локаторы с первой же записи
const dInit = fakeDeps({ exists: () => false });
await run(["init", "--root", "/w/new"], dInit);
const initSchema = Object.entries(dInit.written).find(([p]) => p.endsWith("SCHEMA.md"))?.[1] ?? "";
check("init разворачивает вику со включённой сверкой", /reference_roots:/.test(initSchema) && /root: "\."/.test(initSchema),
  initSchema.slice(0, 120));
check("разбор флагов со значением", parseArgs(["lint", "--root", "/x", "--json"]).flags.root === "/x");
// Абсолютный вид пути платформозависим (на Windows добавляется буква диска), проверяем хвост
const norm = (p) => p.replace(/\\/g, "/");
check("поиск корня по флагу", norm(findRoot({ root: "wiki" }, "/w", () => false)).endsWith("/w/wiki"),
  norm(findRoot({ root: "wiki" }, "/w", () => false)));
check("поиск корня по месту", norm(findRoot({}, "/w", (p) => norm(p).endsWith("docs/wiki"))).endsWith("docs/wiki"),
  norm(findRoot({}, "/w", (p) => norm(p).endsWith("docs/wiki"))));
check("корень по умолчанию", norm(findRoot({}, "/w", () => false)).endsWith(".volna/wiki"),
  norm(findRoot({}, "/w", () => false)));

// --- перенос прежних знаний
const LEGACY_INDEX = [
  "# Указатель знаний",
  "",
  "## analyze",
  "",
  "| Запись | Предмет | Зона | Файл |",
  "|---|---|---|---|",
  "| Заглушкой не закрывается | правило и заглушка | delphi-port | [a.md](delphi-port/a.md) |",
  "",
  "## implement",
  "",
  "| Запись | Предмет | Зона | Файл |",
  "|---|---|---|---|",
  "| Заглушкой не закрывается | правило и заглушка | delphi-port | [a.md](delphi-port/a.md) |",
  "| Ветка списка | список веток | git | [b.md](git/b.md) |",
].join("\n");

const idx = parseLegacyIndex(LEGACY_INDEX);
check("прежний указатель: предмет перенесён", idx.get("delphi-port/a.md")?.subject === "правило и заглушка",
  JSON.stringify(idx.get("delphi-port/a.md")));
check("прежний указатель: этапы собраны по секциям", idx.get("delphi-port/a.md")?.stages.join(",") === "analyze,implement",
  idx.get("delphi-port/a.md")?.stages.join(","));
check("прежний указатель: шапка таблицы не запись", !idx.has("Запись"));
check("зона по умолчанию уходит в процесс", sectionForZone("delphi-port") === "process", sectionForZone("delphi-port"));
check("переопределение зоны работает", sectionForZone("delphi-port", { "delphi-port": "project" }) === "project");

const legacyRecord = ["# Заглушкой не закрывается", "", "**зона:** delphi-port", "**этапы:** analyze", "", "**суть:** текст.", ""].join("\n");
const mig = planMigration({
  files: [{ rel: "delphi-port/a.md", text: legacyRecord }, { rel: "INDEX.md", text: LEGACY_INDEX }],
  legacyIndex: idx,
});
check("указатель не переносится", mig.items.length === 1, String(mig.items.length));
check("путь назначения по разделу и зоне", mig.items[0].to === "process/delphi-port/a.md", mig.items[0].to);
check("раздел дописан в запись", /\*\*раздел:\*\* process/.test(mig.items[0].text), mig.items[0].text);
check("предмет перенесён из указателя", /\*\*предмет:\*\* правило и заглушка/.test(mig.items[0].text));
check("нехватка типа названа", mig.needType.length === 1, String(mig.needType.length));
check("уже размеченная запись не трогается дважды",
  planMigration({ files: [{ rel: "git/b.md", text: "# Ветка\n\n**раздел:** process\n**предмет:** список веток\n" }], legacyIndex: idx })
    .items[0].text.match(/\*\*раздел:\*\*/g).length === 1);
const again = planMigration({
  files: [{ rel: "delphi-port/a.md", text: legacyRecord }],
  legacyIndex: idx,
  targetExists: (t) => t === "process/delphi-port/a.md",
});
check("повторный перенос не переписывает перенесённое", again.items.length === 0 && again.already.length === 1,
  `${again.items.length}/${again.already.length}`);

// Порог объёма соблюдается на всех листах: то, что не делится ни темой, ни этапом, режется на части
const tightSchema = { ...schema, index: { shard_by: ["topic", "stage"] }, limits: { ...schema.limits, index_file_lines: 12, index_file_bytes: 900 } };
const tight = planIndexes(deepRows, tightSchema);
// Порог проверяется на листах: оглавление узла не режется - оно и есть точка выбора ветки
const tightLeaves = tight.files.filter((f) => f.text.includes("| вывод |"));
check("порог объёма соблюдён на каждом листе",
  tightLeaves.length > 0 && tightLeaves.every((f) => Buffer.byteLength(f.text, "utf8") <= 900 && f.text.split("\n").length <= 12),
  tightLeaves.filter((f) => Buffer.byteLength(f.text, "utf8") > 900).map((f) => `${f.rel}:${Buffer.byteLength(f.text, "utf8")}`).join(","));
check("части нумерованы вторым суффиксом", tight.files.some((f) => /--implement--2\.md$/.test(f.rel)),
  tight.files.map((f) => f.rel).join(","));
check("запись лежит ровно в одной части",
  new Set(deepRows.map((r) => tight.placed.get(`${r.rel}#${r.anchor}`))).size > 1
  && deepRows.every((r) => tight.placed.has(`${r.rel}#${r.anchor}`)));

// --- плоская раскладка: путь узла живёт в имени файла
const TOPICS = { ui: "экран", kompas: "экспорт", tabs: "вкладки", "down-view": "вид сверху" };
check("узел разобран из имени файла", nodeOf("reference/ui-tabs-gates.md", TOPICS).join("/") === "ui/tabs",
  nodeOf("reference/ui-tabs-gates.md", TOPICS).join("/"));
check("тема с дефисом не распадается на два уровня", nodeOf("reference/ui-down-view-logo.md", TOPICS).join("/") === "ui/down-view",
  nodeOf("reference/ui-down-view-logo.md", TOPICS).join("/"));
check("незнакомое слово узлом не становится", nodeOf("reference/scale-of-view.md", TOPICS).length === 0,
  nodeOf("reference/scale-of-view.md", TOPICS).join("/"));
check("имя документа, совпавшее с темой, уровнем не считается", nodeOf("reference/ui-tabs.md", TOPICS).join("/") === "ui",
  nodeOf("reference/ui-tabs.md", TOPICS).join("/"));
check("каталоги прежней раскладки по-прежнему дают узел", nodeOf("reference/ui/tabs/gates.md", TOPICS).join("/") === "ui/tabs",
  nodeOf("reference/ui/tabs/gates.md", TOPICS).join("/"));
check("указатель записью не считается", isIndexFile("INDEX.md") && isIndexFile("INDEX-ui-tabs.md") && !isIndexFile("index-tree.md"));

const flatSchema = { ...schema, topics: TOPICS, index: { shard_by: ["topic", "stage"] } };
const flatRows = [
  { rel: "reference/ui-tabs-gates.md", section: "reference", node: nodeOf("reference/ui-tabs-gates.md", TOPICS),
    heading: "Вкладка блокируется числом", anchor: "вкладка-блокируется-числом", subject: "вкладки", type: "гейт", stages: ["implement"] },
];
const flatPlan = planIndexes(flatRows, flatSchema);
check("в плоской раскладке ссылка - одно имя файла",
  flatPlan.files.find((f) => f.rel === "reference/INDEX.md").text.includes("](ui-tabs-gates.md#вкладка-блокируется-числом)"),
  flatPlan.files.find((f) => f.rel === "reference/INDEX.md").text);

// --- выпрямление раскладки
const flatten = planFlatten({
  files: [
    { rel: "reference/ui/tabs/gates.md", text: "# Гейт\n\n**связи:** [[composition]] и [[composition#шапка]]\n" },
    { rel: "reference/ui/tabs/composition.md", text: "# Состав\n" },
  ],
  schema: { topics: TOPICS },
});
check("узлы переехали в имя файла", flatten.moves.map((m) => m.to).join(",") === "reference/ui-tabs-gates.md,reference/ui-tabs-composition.md",
  flatten.moves.map((m) => m.to).join(","));
check("связи переписаны на новое имя", /\[\[ui-tabs-composition\]\].*\[\[ui-tabs-composition#шапка\]\]/s.test(flatten.moves[0].text),
  flatten.moves[0].text);
check("счётчик переписанных связей верен", flatten.rewritten === 2, String(flatten.rewritten));
check("чистый план не заблокирован", !flatten.blocked, JSON.stringify({ t: flatten.needTopic, a: flatten.ambiguous }));
const flattenBad = planFlatten({ files: [{ rel: "reference/mystery/a.md", text: "# А\n" }], schema: { topics: TOPICS } });
check("узел без описания в topics блокирует выпрямление", flattenBad.blocked && flattenBad.needTopic.includes("mystery"),
  JSON.stringify(flattenBad.needTopic));
const flattenAmb = planFlatten({ files: [{ rel: "reference/ui/tabs-of-mine.md", text: "# Б\n" }], schema: { topics: TOPICS } });
check("имя, съедающее уровень, блокирует выпрямление", flattenAmb.blocked && flattenAmb.ambiguous.length === 1,
  JSON.stringify(flattenAmb.ambiguous));

console.log(`\n${failures ? `ПРОВАЛОВ: ${failures}` : "все проверки пройдены"}`);
process.exit(failures ? 1 : 0);
