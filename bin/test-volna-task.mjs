/**
 * Проверка дерева задач без файловой системы: журналы и state.json живут в карте в памяти.
 * Главное, что проверяется: обе стороны связи родитель-ребёнок пишутся одним вызовом, порядок
 * детей - очередь, отказ ничего не записывает, передача работы ребёнку не трогает чужую задачу.
 *
 * Запуск: node bin/test-volna-task.mjs
 */
import { basename, dirname, join } from "node:path";
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
    listDir: (d) => [...fs.keys()].filter((p) => dirname(p) === d).map((p) => basename(p)),
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

// add --tracker: ребёнок - элемент трекера
{
  const w = world(base());
  const tr = (id, extra = []) => run(["add", "260929-root", "--tracker", id, "--title", `Элемент ${id}`, "--goal", `сделать ${id}`, ...extra], w.deps);
  check("add --tracker с номером: код 0", (await tr("12345", ["--url", "https://tfs/_workitems/edit/12345"])) === 0, w.errs.join("; "));
  check("add --tracker: журнал по id трекера как есть", w.fs.has(J("12345")));
  const c = w.fm("12345");
  check("add --tracker: ребёнок в режиме tracker со ссылкой из --url",
    c.mode === "tracker" && c.tracker === "https://tfs/_workitems/edit/12345" && c.parent === "260929-root" && c.status === "новая", JSON.stringify(c));
  const next = summaryField(readSummary(w.fs.get(J("12345")))?.body ?? "", "следующий шаг");
  check("add --tracker: следующий шаг ведёт к чтению элемента трекера", next.includes("trackers/<трекер>/intake.md"), next);
  check("add --tracker с ключом: регистр ключа не меняется", (await tr("ABC-12")) === 0 && w.fs.has(J("ABC-12")) && w.fm("ABC-12").tracker === "", w.errs.join("; "));
  check("add --tracker: дети трекера встают в очередь родителя", childIds(w.fm("260929-root")).join(",") === "12345,ABC-12", childIds(w.fm("260929-root")).join(","));
  check("add --tracker: вывод называет элемент трекера", w.out.some((l) => l.includes("12345") && l.includes("элемент трекера")), w.out.join("; "));
  check("add локального ребёнка по-прежнему в режиме local", (await add(w, "local-one")) === 0 && w.fm("260929-local-one").mode === "local" && w.fm("260929-local-one").source === "текст в журнале");

  check("next берёт первого ребёнка трекера", (await run(["next"], w.deps)) === 0 && JSON.parse(w.fs.get(STATE)).active === "12345", w.fs.get(STATE));
  check("done ребёнка трекера возвращает работу родителю",
    (await run(["done", "12345"], w.deps)) === 0 && JSON.parse(w.fs.get(STATE)).active === "260929-root" && w.fm("12345").status === "закрыта", w.errs.join("; "));
  check("next после ребёнка трекера берёт следующего по очереди", (await run(["next"], w.deps)) === 0 && JSON.parse(w.fs.get(STATE)).active === "ABC-12", w.fs.get(STATE));
}

// add --tracker: отказы без записи
{
  const refuse = async (name, argv) => {
    const w = world(base());
    const code = await run(["add", "260929-root", ...argv, "--title", "Т", "--goal", "Г"], w.deps);
    check(name, code === 1 && w.writes.length === 0, `${code}; ${w.errs.join("; ")}`);
  };
  await refuse("add --tracker вместе со --slug - отказ без записи", ["--tracker", "12345", "--slug", "x"]);
  await refuse("add без --slug и без --tracker - отказ без записи", []);
  await refuse("add --tracker с негодным id - отказ без записи", ["--tracker", "12"]);
  await refuse("add --tracker с путём вместо id - отказ без записи", ["--tracker", "../12345"]);
  await refuse("add --tracker без значения - отказ без записи", ["--tracker"]);
  await refuse("add --url без ссылки - отказ без записи", ["--tracker", "12345", "--url"]);
  await refuse("add --url у локального ребёнка - отказ без записи", ["--slug", "x", "--url", "https://t/1"]);
  const w = world({ ...base(), [J("12345")]: ROOT.replace("260929-root", "12345") });
  const code = await run(["add", "260929-root", "--tracker", "12345", "--title", "Т", "--goal", "Г"], w.deps);
  check("add --tracker с занятым id - отказ без записи, slug не предлагается",
    code === 1 && w.writes.length === 0 && w.errs.join(" ").includes("уже заведён") && !w.errs.join(" ").includes("slug"), w.errs.join("; "));
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

// done и next: очередь детей
{
  const setup = async () => {
    const w = world(base());
    for (const s of ["one", "two", "three"]) await add(w, s);
    await run(["start", "260929-one"], w.deps);
    return w;
  };
  const st = (w) => JSON.parse(w.fs.get(STATE));

  const w = await setup();
  const code = await run(["done", "260929-one"], w.deps);
  check("done: код 0", code === 0, w.errs.join("; "));
  check("done: ребёнку пишется «закрыта»", w.fm("260929-one").status === "закрыта", w.fm("260929-one").status);
  check("done: active возвращается к родителю", st(w).active === "260929-root", st(w).active);
  check("done: прочие ключи state.json сохранены", st(w).muted === true);
  check("done: остались открытые дети - родитель ждёт детей", w.fm("260929-root").status === "ждёт детей");
  check("done: вывод называет следующего ребёнка", /следующий 260929-two/.test(w.out.at(-1)), w.out.at(-1));

  const n = await run(["next"], w.deps);
  check("next без аргумента берёт активного родителя и его первого открытого ребёнка",
    n === 0 && st(w).active === "260929-two", `${n} ${st(w).active} ${w.errs.join("; ")}`);
  check("next: у взятого ребёнка снят статус «новая»", w.fm("260929-two").status === "");

  w.fs.set(J("260929-two"), setField(w.fs.get(J("260929-two")), "status", '"снята: не нужна"'));
  await run(["done", "260929-two"], w.deps);
  check("done снятого ребёнка: статус «снята» не переписывается", w.fm("260929-two").status === "снята: не нужна", w.fm("260929-two").status);
  await run(["next"], w.deps);
  check("next пропускает закрытых и снятых", st(w).active === "260929-three", st(w).active);
  await run(["done", "260929-three"], w.deps);
  check("done последнего открытого ребёнка - родитель в приёмке", w.fm("260929-root").status === "приёмка", w.fm("260929-root").status);
  check("done последнего: active у родителя", st(w).active === "260929-root");

  const again = await run(["next"], w.deps);
  check("next без открытых детей - приёмка, код 0", again === 0 && w.fm("260929-root").status === "приёмка" && /приёмка/.test(w.out.at(-1)), w.out.at(-1));
}

// done и next: отказы без записи
{
  const refuse = async (name, files, argv) => {
    const x = world(files);
    const code = await run(argv, x.deps);
    check(`${name}: отказ без записи`, code === 1 && x.writes.length === 0, `код ${code}; ${x.errs.join("; ")}`);
    return x;
  };
  const w = world(base());
  await add(w, "one");
  await add(w, "two");
  await run(["start", "260929-one"], w.deps);
  const snap = () => Object.fromEntries(w.fs);

  const other = await refuse("done при чужой активной задаче", snap(), ["done", "260929-two"]);
  check("done при чужой активной: она названа", /260929-one/.test(other.errs.join(" ")));
  await refuse("done корня при активном ребёнке", snap(), ["done", "260929-root"]);

  const nested = world(snap());
  await run(["add", "260929-one", "--slug", "leaf", "--title", "Лист", "--goal", "Г"], nested.deps);
  const x = world(Object.fromEntries(nested.fs));
  const code = await run(["done", "260929-one"], x.deps);
  check("done ребёнка с открытыми своими детьми - отказ без записи", code === 1 && x.writes.length === 0, `код ${code}`);
  check("done ребёнка с открытыми детьми: дети названы", /260929-leaf/.test(x.errs.join(" ")), x.errs.join("; "));

  await refuse("next у задачи, которая не активна", snap(), ["next", "260929-root"]);
  await refuse("next у задачи без детей", { ...snap(), [STATE]: `{"active": "260929-two"}` }, ["next"]);
  await refuse("next у задачи без журнала", { ...snap(), [STATE]: "{}" }, ["next", "260929-nobody"]);

  const broken = world({ ...snap(), [STATE]: `{"active": "260929-root"}`,
    [J("260929-root")]: setField(w.fs.get(J("260929-root")), "children", "[260929-ghost, 260929-two]") });
  await run(["next"], broken.deps);
  check("next: ребёнок без журнала пропускается и называется", JSON.parse(broken.fs.get(STATE)).active === "260929-two" &&
    broken.out.some((l) => /260929-ghost без журнала/.test(l)), broken.out.join("; "));
}

// done корня: приёмка родителя и её провал
{
  const st = (w) => JSON.parse(w.fs.get(STATE));
  const w = world(base());
  await add(w, "one");
  await add(w, "two");
  await run(["start", "260929-one"], w.deps);
  await run(["done", "260929-one"], w.deps);

  const early = world(Object.fromEntries(w.fs));
  const code = await run(["done", "260929-root"], early.deps);
  check("done корня с открытым ребёнком - отказ без записи", code === 1 && early.writes.length === 0, `код ${code}`);
  check("done корня с открытым ребёнком: ребёнок назван", /260929-two/.test(early.errs.join(" ")), early.errs.join("; "));

  await run(["next"], w.deps);
  await run(["done", "260929-two"], w.deps);
  const fail = world(Object.fromEntries(w.fs));
  await run(["add", "260929-root", "--slug", "gap", "--title", "Пробел", "--goal", "закрыть пробел приёмки"], fail.deps);
  await run(["next"], fail.deps);
  check("провал приёмки: новый ребёнок родителя в приёмке становится активным", st(fail).active === "260929-gap", st(fail).active);
  check("провал приёмки: родитель снова ждёт детей", fail.fm("260929-root").status === "ждёт детей", fail.fm("260929-root").status);

  const done = await run(["done", "260929-root"], w.deps);
  check("done корня после детей: код 0", done === 0, w.errs.join("; "));
  check("done корня: статус «закрыта»", w.fm("260929-root").status === "закрыта", w.fm("260929-root").status);
  check("done корня: активная задача снята", !("active" in st(w)), JSON.stringify(st(w)));
  check("done корня: прочие ключи state.json сохранены", st(w).muted === true);
  check("done корня: вывод говорит, что активной задачи нет", /активной задачи нет/.test(w.out.at(-1)), w.out.at(-1));

  const ext = world({ [J("260929-root")]: setField(ROOT, "parent", "12345"), [STATE]: `{"active": "260929-root"}` });
  const e = await run(["done", "260929-root"], ext.deps);
  check("done задачи с внешним родителем без журнала закрывает её как корень",
    e === 0 && ext.fm("260929-root").status === "закрыта" && !("active" in st(ext)), `${e} ${ext.errs.join("; ")}`);
  check("done с внешним родителем: вывод называет его", /родитель 12345 без журнала/.test(ext.out.at(-1)), ext.out.at(-1));
  check("done корня без родителя: о внешнем родителе молчит", !/без журнала/.test(w.out.at(-1)), w.out.at(-1));
  const s = await run(["start", "260929-root"], world({ [J("260929-root")]: setField(ROOT, "parent", "12345"), [STATE]: "{}" }).deps);
  check("start задачи с внешним родителем - отказ: это не ребёнок", s === 1);
}

// list: незакрытые задачи
{
  const w = world(base());
  await add(w, "one");
  await add(w, "two");
  w.fs.set(J("260929-two"), setField(w.fs.get(J("260929-two")), "status", "закрыта"));
  w.fs.set(join(VOLNA, "journal", "logs", "TASK-260929-root.log.md"), "# лог");
  w.fs.set(J("260101-old"), "---\ntask: 260101-old\ntitle: \"Старая\"\nstage: cleanup\nupdated: 2026-01-01T10:00\n---\n");
  w.fs.set(J("260102-stuck"), "---\ntask: 260102-stuck\ntitle: \"Брошенная\"\nstage: implement\nupdated: 2026-01-02T10:00\n---\n");
  const from = w.out.length;
  await run(["list"], w.deps);
  const text = w.out.slice(from).join("\n");
  check("list: активная задача отмечена", /260929-root Корень - в работе.*<- активна/.test(text), text);
  check("list: новый ребёнок в списке", text.includes("260929-one Ребёнок one - новая"), text);
  check("list: закрытый ребёнок не в списке", !text.includes("260929-two"), text);
  check("list: журнал без статуса на cleanup читается закрытым", !text.includes("260101-old"), text);
  check("list: брошенная на середине задача без статуса видна", text.includes("260102-stuck Брошенная - в работе"), text);
  check("list: свежие первыми", text.indexOf("260102-stuck") > text.indexOf("260929-root"), text);

  const none = world({ [STATE]: "{}", [J("260101-old")]: "---\ntask: 260101-old\nstage: cleanup\n---\n" });
  await run(["list"], none.deps);
  check("list без незакрытых задач так и говорит", none.out.join(" ") === "незакрытых задач нет", none.out.join(" "));
}

console.log(failures ? `\nПРОВАЛЕНО: ${failures}` : "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ");
process.exit(failures ? 1 : 0);
