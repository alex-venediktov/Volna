/**
 * Проверка дерева задач без файловой системы: журналы и state.json живут в карте в памяти.
 * Главное, что проверяется: обе стороны связи родитель-ребёнок пишутся одним вызовом, порядок
 * детей - очередь, отказ ничего не записывает, передача работы ребёнку не трогает чужую задачу.
 *
 * Запуск: node bin/test-volna-task.mjs
 */
import { join } from "node:path";
import { run, parseArgs, setField, idDate } from "./volna-task.mjs";
import { parseFrontmatter, childIds, readSummary, summaryField } from "../hooks/lib/volna-state.mjs";

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${!cond && detail ? ` -> ${detail}` : ""}`);
  if (!cond) failures++;
}

const VOLNA = join("repo", ".volna");
const J = (id) => join(VOLNA, "journal", `TASK-${id}.md`);
const STATE = join(VOLNA, "state.json");
const NOW = new Date(2026, 8, 29, 2, 15);

const ROOT = `---
task: 260929-root
title: "Корень"
type: task
mode: local
parent:
children: []               # дети по порядку - очередь
status:                    # пусто - по этапу
repos: [web]
stage: spec
stages_done: []
updated: 2026-09-29T01:00
---

# 260929-root - корень

## Состояние · 2026-09-29 01:00

**цель:** корень дерева
**сделано:** ничего
**следующий шаг:** 1. разделить
`;

/** ФС в памяти и сборщик вывода для одного прогона CLI. */
function world(files) {
  const fs = new Map(Object.entries(files));
  const out = [];
  const errs = [];
  const writes = [];
  const deps = {
    volnaDir: VOLNA,
    now: NOW,
    readFile: (p) => (fs.has(p) ? fs.get(p) : null),
    writeFile: (p, t) => { fs.set(p, t); writes.push(p); },
    log: (s) => out.push(s),
    err: (s) => errs.push(s),
  };
  return { fs, out, errs, writes, deps, fm: (id) => parseFrontmatter(fs.get(J(id)) ?? "") };
}

const base = () => ({ [J("260929-root")]: ROOT, [STATE]: `{"active": "260929-root", "updated": "2026-09-29T01:00", "muted": true}` });
const add = (w, slug, extra = []) => run(["add", "260929-root", "--slug", slug, "--title", `Ребёнок ${slug}`, "--goal", `сделать ${slug}`, ...extra], w.deps);

// Разбор аргументов
{
  const a = parseArgs(["add", "p", "--title", "два слова", "--goal=x=y", "--help"]);
  check("флаг со значением через пробел читается целиком", a.flags.title === "два слова", JSON.stringify(a));
  check("флаг через = сохраняет знак = в значении", a.flags.goal === "x=y", a.flags.goal);
  check("флаг без значения - true", a.flags.help === true);
  check("свободные слова после команды - аргументы", a.command === "add" && a.args[0] === "p");
  check("дата id - ГГММДД по часам", idDate(NOW) === "260929", idDate(NOW));
}

// Запись поля frontmatter
{
  const t = setField(ROOT, "children", "[a, b]");
  check("поле с комментарием: значение заменено, комментарий остался",
    /^children: \[a, b\]\s+# дети по порядку - очередь$/m.test(t), t.split("\n")[6]);
  check("после записи поле читается разбором", childIds(parseFrontmatter(t)).join(",") === "a,b");
  const block = "---\ntask: x\nchildren:\n  - a\n  - b\nstage: spec\n---\nтело\n";
  const t2 = setField(block, "children", "[c]");
  check("блочный список заменяется целиком, элементы не остаются", !/^\s+- a/m.test(t2) && childIds(parseFrontmatter(t2)).join(",") === "c", t2);
  check("тело после frontmatter не меняется", t2.endsWith("---\nтело\n"));
  const t3 = setField("---\ntask: x\nparent: p\nstage: spec\n---\n", "children", "[c]", "parent");
  check("нет поля - вставляется после названного", /parent: p\nchildren: \[c\]\nstage/.test(t3), t3);
  const statusLine = (s) => s.split("\n").find((l) => l.startsWith("status:"));
  check("пустое значение: строка поля как в шаблоне, комментарий на месте",
    statusLine(setField(setField(ROOT, "status", "новая"), "status", "")) === statusLine(ROOT),
    statusLine(setField(setField(ROOT, "status", "новая"), "status", "")));
  check("текст без frontmatter - null", setField("просто текст", "a", "b") === null);
  const crlf = setField(ROOT.replace(/\n/g, "\r\n"), "stage", "plan");
  check("переводы строк CRLF сохраняются", /\r\nstage: plan\r\n/.test(crlf) && !/[^\r]\n/.test(crlf));
}

// add: заведение ребёнка
{
  const w = world(base());
  const code = await add(w, "first-step");
  const id = "260929-first-step";
  check("add заводит ребёнка: код 0", code === 0, w.errs.join("; "));
  check("add: журнал ребёнка создан по id ГГММДД-slug", w.fs.has(J(id)));
  const c = w.fm(id);
  check("add: у ребёнка parent - родитель", c.parent === "260929-root", c.parent);
  check("add: ребёнок заведён со статусом «новая»", c.status === "новая", c.status);
  check("add: ребёнок локальный, этап intake, этапов не пройдено", c.mode === "local" && c.stage === "intake" && c.stages_done.length === 0);
  check("add: репозитории наследуются от родителя", c.repos.join(",") === "web", String(c.repos));
  const body = readSummary(w.fs.get(J(id)))?.body ?? "";
  check("add: постановка лежит в «цели»", summaryField(body, "цель") === "сделать first-step", summaryField(body, "цель"));
  check("add: обязательные подпункты состояния есть", Boolean(summaryField(body, "сделано") && summaryField(body, "следующий шаг")));
  check("add: у родителя ребёнок в children", childIds(w.fm("260929-root")).join(",") === id);
  check("add: у родителя обновлена метка updated", w.fm("260929-root").updated === "2026-09-29T02:15");
  check("add: state.json не трогается", !w.writes.includes(STATE));
  check("add: заголовок журнала ребёнка - как в шаблоне", w.fs.get(J(id)).includes(`\n# ${id} — Ребёнок first-step\n`));

  const nl = world(base());
  await run(["add", "260929-root", "--slug", "multi-line", "--title", "две\nстроки \"в кавычках\"", "--goal", "Г"], nl.deps);
  check("add: перевод строки и кавычки в заголовке не ломают frontmatter",
    nl.fm("260929-multi-line").title === "две строки 'в кавычках'" && nl.fm("260929-multi-line").parent === "260929-root",
    nl.fm("260929-multi-line").title);

  await add(w, "second-step");
  await add(w, "third-step");
  check("add: дети идут в children в порядке заведения - это очередь",
    childIds(w.fm("260929-root")).join(",") === "260929-first-step,260929-second-step,260929-third-step",
    childIds(w.fm("260929-root")).join(","));
  check("add: комментарий поля children у родителя сохранён", /^children: \[.*\]\s+# дети по порядку/m.test(w.fs.get(J("260929-root"))));
}

// add: отказы без записи
{
  const refuse = async (name, files, argv) => {
    const w = world(files);
    const code = await run(argv, w.deps);
    check(`${name}: отказ без записи`, code === 1 && w.writes.length === 0, `код ${code}, записей ${w.writes.length}`);
    return w;
  };
  const dup = world(base());
  await add(dup, "same");
  const before = dup.writes.length;
  const code = await add(dup, "same");
  check("add с занятым id: отказ и ничего не записано", code === 1 && dup.writes.length === before, dup.errs.join("; "));
  check("add с занятым id: причина названа", /занят/.test(dup.errs.join(" ")));

  const argv = (over) => ["add", "260929-root", "--slug", "ok-slug", "--title", "Т", "--goal", "Г", ...over];
  await refuse("slug с кириллицей", base(), ["add", "260929-root", "--slug", "шаг", "--title", "Т", "--goal", "Г"]);
  await refuse("slug с подчёркиванием", base(), ["add", "260929-root", "--slug", "a_b", "--title", "Т", "--goal", "Г"]);
  await refuse("slug с разделителем пути", base(), ["add", "260929-root", "--slug", "../x", "--title", "Т", "--goal", "Г"]);
  await refuse("без постановки", base(), ["add", "260929-root", "--slug", "ok-slug", "--title", "Т"]);
  await refuse("без заголовка", base(), ["add", "260929-root", "--slug", "ok-slug", "--goal", "Г"]);
  await refuse("дата не ГГММДД", base(), argv(["--date", "2026-09-29"]));
  await refuse("родитель с переходом вверх, ведущим к настоящему журналу", base(), ["add", "x/../TASK-260929-root", "--slug", "ok-slug", "--title", "Т", "--goal", "Г"]);
  await refuse("родитель с разделителем пути", base(), ["add", "sub/260929-root", "--slug", "ok-slug", "--title", "Т", "--goal", "Г"]);
  await refuse("родитель без журнала", base(), ["add", "260929-nobody", "--slug", "ok-slug", "--title", "Т", "--goal", "Г"]);
  const closed = { ...base(), [J("260929-root")]: setField(ROOT, "status", "закрыта") };
  await refuse("родитель закрыт", closed, argv([]));
  const dropped = { ...base(), [J("260929-root")]: setField(ROOT, "status", '"снята: неактуально"') };
  await refuse("родитель снят", dropped, argv([]));
  const finished = { [J("260929-root")]: setField(ROOT, "stage", "cleanup"), [STATE]: "{}" };
  await refuse("неактивный родитель на cleanup без статуса - закрыт", finished, argv([]));
  const between = world({ [J("260929-root")]: setField(ROOT, "stage", "cleanup"), [STATE]: `{"active": "260929-root"}` });
  check("активный родитель на cleanup между частями - детей заводить можно", (await add(between, "ok-slug")) === 0, between.errs.join("; "));
}

// start: передача работы ребёнку
{
  const w = world(base());
  await add(w, "first-step");
  await add(w, "second-step");
  const code = await run(["start", "260929-first-step"], w.deps);
  check("start: код 0", code === 0, w.errs.join("; "));
  const st = JSON.parse(w.fs.get(STATE));
  check("start: active указывает на ребёнка", st.active === "260929-first-step", st.active);
  check("start: прочие ключи state.json сохранены", st.muted === true, JSON.stringify(st));
  check("start: state.json без новых ключей", Object.keys(st).sort().join(",") === "active,muted,updated", Object.keys(st).join(","));
  check("start: у ребёнка снят статус «новая»", w.fm("260929-first-step").status === "", w.fm("260929-first-step").status);
  check("start: родитель ждёт детей", w.fm("260929-root").status === "ждёт детей", w.fm("260929-root").status);
  check("start: второй ребёнок остаётся новым", w.fm("260929-second-step").status === "новая");

  const again = world(Object.fromEntries(w.fs));
  check("start второго ребёнка при активном первом - отказ без записи",
    (await run(["start", "260929-second-step"], again.deps)) === 1 && again.writes.length === 0, again.errs.join("; "));

  const other = world({ ...Object.fromEntries(w.fs), [STATE]: `{"active": "260101-other"}` });
  check("start при чужой активной задаче - отказ без записи",
    (await run(["start", "260929-second-step"], other.deps)) === 1 && other.writes.length === 0);
  check("start при чужой активной задаче: она названа", /260101-other/.test(other.errs.join(" ")));

  const fresh = world({ ...Object.fromEntries(w.fs), [STATE]: "{}" });
  await run(["start", "260929-second-step"], fresh.deps);
  check("start без активной задачи - ребёнок становится активным", JSON.parse(fresh.fs.get(STATE)).active === "260929-second-step");
}

// start: отказы
{
  const w = world(base());
  await add(w, "first-step");
  const snap = () => Object.fromEntries(w.fs);
  const refuse = async (name, files, id) => {
    const x = world(files);
    const code = await run(["start", id], x.deps);
    check(`start ${name}: отказ без записи`, code === 1 && x.writes.length === 0, `код ${code}; ${x.errs.join("; ")}`);
  };
  await refuse("задачи без журнала", snap(), "260929-nobody");
  await refuse("id с переходом вверх, ведущим к настоящему журналу", snap(), "x/../TASK-260929-first-step");
  const climbing = { ...snap(), [STATE]: "{}", [J("260929-first-step")]: setField(w.fs.get(J("260929-first-step")), "parent", "x/../TASK-260929-root") };
  await refuse("ребёнка, чей parent - путь наверх", climbing, "260929-first-step");
  await refuse("корня - у него нет родителя", snap(), "260929-root");
  const orphan = { ...snap(), [J("260929-root")]: ROOT };
  await refuse("ребёнка, которого родитель не перечисляет", orphan, "260929-first-step");
  const done = { ...snap(), [J("260929-first-step")]: setField(w.fs.get(J("260929-first-step")), "status", "закрыта") };
  await refuse("закрытого ребёнка", done, "260929-first-step");
  const broken = { ...snap(), [STATE]: "{не json" };
  await refuse("при битом state.json", broken, "260929-first-step");
}

// start ребёнка, который сам уже родитель: его статус не сбрасывается
{
  const w = world(base());
  await add(w, "mid");
  const mid = setField(w.fs.get(J("260929-mid")), "status", "ждёт детей");
  w.fs.set(J("260929-mid"), mid);
  await run(["start", "260929-mid"], w.deps);
  check("start ребёнка со статусом «ждёт детей» - статус не снимается", w.fm("260929-mid").status === "ждёт детей", w.fm("260929-mid").status);
}

console.log(failures ? `\nПРОВАЛЕНО: ${failures}` : "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ");
process.exit(failures ? 1 : 0);
