/**
 * Проверка линта документации без файловой системы: корпус подаётся объектами, существование
 * целей - заглушкой. Главное, что проверяется: ссылка внутри кода находкой не становится,
 * номер строки при этом не уезжает, и бюджет объёма умеет быть красным.
 *
 * Запуск: node bin/test-volna-doc.mjs
 */
import { run } from "./volna-doc.mjs";
import { lintDocs, stripCode, collectLinks, headingAnchors, normalize } from "../lib/doc-lint.mjs";

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${!cond && detail ? ` -> ${detail}` : ""}`);
  if (!cond) failures++;
}

// --- вырезание кода
const WITH_CODE = `# Заголовок

Живая ссылка: [этап](stages/intake.md).

Образец в спане: \`[reference/ui.md](../../reference/ui.md#якорь)\` - так писать нельзя.

\`\`\`md
[пример](никуда/не/ведёт.md)
\`\`\`

Хвост: [второй](docs/COST.md).
`;
check("спан вырезается, длина строк сохраняется",
  stripCode(WITH_CODE).split("\n").length === WITH_CODE.split("\n").length);
const links = collectLinks(WITH_CODE);
check("ссылки внутри кода в разбор не попадают", links.length === 2,
  links.map((l) => l.target).join(","));
check("номер строки не уезжает из-за вырезания", links[1].line === 11, String(links[1].line));

// --- якоря заголовков
const ANCH = `# Первый заголовок

## Второй, с пунктуацией!

<a id="ручной-якорь"></a>
`;
const anchors = headingAnchors(ANCH);
check("якорь собирается из заголовка", anchors.has("первый-заголовок"), [...anchors].join(","));
check("пунктуация в якоре отброшена", anchors.has("второй-с-пунктуацией"), [...anchors].join(","));
check("ручной html-якорь опознаётся", anchors.has("ручной-якорь"), [...anchors].join(","));

// --- ссылки корпуса
const files = [
  { rel: "docs/A.md", text: "[живая](B.md), [мёртвая](NOPE.md), [якорь](B.md#есть-такой), [битый](B.md#нет-такого)" },
  { rel: "docs/B.md", text: "# Есть такой\n\nтело\n" },
];
const deps = {
  resolve: (fromRel, target) => normalize(fromRel, target),
  exists: (p) => files.some((f) => f.rel === p),
  readText: (p) => files.find((f) => f.rel === p)?.text ?? null,
};
const found = lintDocs({ files, ...deps });
check("битая ссылка найдена", found.some((f) => f.code === "D001" && f.what.includes("NOPE.md")),
  found.map((f) => f.code).join(","));
check("живая ссылка находкой не становится", found.filter((f) => f.code === "D001").length === 1,
  found.filter((f) => f.code === "D001").map((f) => f.what).join(","));
check("мёртвый якорь найден", found.some((f) => f.code === "D002" && f.what.includes("нет-такого")),
  found.map((f) => `${f.code}:${f.what}`).join(","));
check("живой якорь молчит", !found.some((f) => f.code === "D002" && f.what.includes("есть-такой")));

// Негативный контроль: на корпусе, где ссылок в коде нет вовсе, находок нет - иначе проверка
// красная всегда и её выключают
const clean = lintDocs({ files: [{ rel: "docs/C.md", text: "текст без ссылок" }], ...deps });
check("чистый корпус даёт ноль находок", clean.length === 0, clean.map((f) => f.code).join(","));

// --- бюджеты
const big = { rel: "skills/long.md", text: "я".repeat(300) };
const overs = lintDocs({ files: [big], ...deps, budgets: { "skills/long.md": 100 } });
check("превышение бюджета - ошибка", overs.some((f) => f.code === "D003" && f.level === "ошибка"),
  overs.map((f) => `${f.code}/${f.level}`).join(","));
// 300 знаков кириллицы это 600 байт: потолок 620 оставляет меньше 5% запаса
const tight = lintDocs({ files: [big], ...deps, budgets: { "skills/long.md": 620 } });
check("запас меньше 5% - предупреждение", tight.some((f) => f.code === "D003" && f.level === "предупр."),
  tight.map((f) => `${f.code}/${f.level}/${f.what}`).join(","));
const roomy = lintDocs({ files: [big], ...deps, budgets: { "skills/long.md": 2000 } });
check("бюджет с запасом молчит", roomy.length === 0, roomy.map((f) => f.what).join(","));
const stale = lintDocs({ files: [big], ...deps, budgets: { "skills/ушёл.md": 100 } });
check("бюджет на исчезнувший файл назван", stale.some((f) => f.code === "D004"),
  stale.map((f) => f.code).join(","));

// --- CLI: коды возврата и то, что инструмент ничего не пишет
const cliFiles = {
  "docs/A.md": "[мёртвая](NOPE.md)",
  "docs/B.md": "# Есть такой\n",
};
const cliDeps = (overrides = {}) => ({
  cwd: "/repo",
  listFiles: () => Object.keys(cliFiles),
  readText: (p) => {
    const rel = p.split("\\").join("/").replace("/repo/", "");
    return cliFiles[rel] ?? null;
  },
  exists: (p) => {
    const rel = p.split("\\").join("/").replace("/repo/", "");
    return Object.keys(cliFiles).includes(rel);
  },
  log: () => {},
  err: () => {},
  ...overrides,
});
check("ошибка в корпусе даёт код 1", await run(["lint"], cliDeps()) === 1);
const okFiles = { "docs/B.md": "# Есть такой\n" };
check("чистый корпус даёт код 0", await run(["lint"], cliDeps({
  listFiles: () => Object.keys(okFiles),
  readText: (p) => okFiles[p.split("\\").join("/").replace("/repo/", "")] ?? null,
  exists: (p) => Object.keys(okFiles).includes(p.split("\\").join("/").replace("/repo/", "")),
})) === 0);
check("неизвестная команда - код 3", await run(["chto-to"], cliDeps()) === 3);

console.log(failures ? `\nПРОВАЛОВ: ${failures}` : "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ");
process.exit(failures ? 1 : 0);
