/**
 * Проверка вики выводов без файловой системы и без сети: корпус подаётся заглушками чтения.
 * Главное, что проверяется: правило длины цитаты и порядок проверок в нём, разбор обеих
 * раскладок записи, шардирование указателя по порогу и то, что без --fix ничего не пишется.
 *
 * Запуск: node bin/test-volna-wiki.mjs
 */
import { run, parseArgs, findRoot } from "./volna-wiki.mjs";
import { parseYamlSubset, loadSchema, slug, field, parseAnchors, readRecords, verifyAnchor, decodeSource, DEFAULTS } from "../lib/wiki.mjs";
import { lint } from "../lib/wiki-lint.mjs";
import { planIndexes } from "../lib/wiki-index.mjs";
import { parseLegacyIndex, planMigration, sectionForZone } from "../lib/wiki-migrate.mjs";

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
check("порог превышен - шардирование по этапам", shardPlan.sharded.includes("reference") && shardPlan.files.some((f) => f.rel === "reference/indexes/implement.md"),
  shardPlan.files.map((f) => f.rel).join(","));

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

console.log(`\n${failures ? `ПРОВАЛОВ: ${failures}` : "все проверки пройдены"}`);
process.exit(failures ? 1 : 0);
