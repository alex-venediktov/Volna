/**
 * Проверка общего CLI трекера без сети: профиль и статусы подаются напрямую, шлюзы - настоящие
 * volna-tfs, volna-jira и volna-tt с подставным клиентом; ФС - только временный project.md для разбора секции. Главное, что проверяется: глагол
 * контракта доходит до того же метода клиента, что прямой вызов шлюза; статус по смыслу
 * становится именем трекера; чего шлюз не умеет, туда ничего не уходит.
 *
 * Запуск: node bin/test-volna-tracker.mjs
 */
import { run, resolveGateway, resolveStatus, translateState, gatewayVerbs, CONTRACT_VERBS, GATEWAYS,
  EXIT_UNSUPPORTED } from "./volna-tracker.mjs";
import { readSection, readProfile } from "../hooks/lib/volna-state.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${!cond && detail ? ` -> ${detail}` : ""}`);
  if (!cond) failures++;
}

/** Подставной клиент TFS: помнит вызовы, ничего не отправляет. */
function fakeTfs() {
  const calls = [];
  return {
    calls,
    fieldOps(fields) {
      return Object.entries(fields).map(([ref, value]) => ({ op: "add", path: `/fields/${ref}`, value }));
    },
    async verifyAccess() { calls.push(["verifyAccess"]); return { ok: true, status: 200 }; },
    async updateWorkItem(id, ops) { calls.push(["updateWorkItem", id, ops]); return { id }; },
    async addComment(id, html) { calls.push(["addComment", id, html]); return { id }; },
  };
}

/** Подставной клиент Jira: помнит вызовы, ничего не отправляет. */
function fakeJira() {
  const calls = [];
  return {
    calls,
    async verifyAccess() { calls.push(["verifyAccess"]); return { ok: true, status: 200, user: { displayName: "И" } }; },
    async transitionTo(key, wanted) { calls.push(["transitionTo", key, wanted]); return { name: wanted, to: { name: wanted } }; },
    async addComment(key, md) { calls.push(["addComment", key, md]); return { id: "1" }; },
  };
}

/** Подставной клиент task-tracker: помнит вызовы, ничего не отправляет. */
function fakeTt() {
  const calls = [];
  return {
    calls,
    project: "volna",
    async moveTask(id, status) { calls.push(["moveTask", id, status]); return { id, status }; },
    async commentTask(id, text) { calls.push(["commentTask", id, text]); return { id }; },
  };
}

/** Прогон адаптера: вывод собирается, профиль и статусы - из аргументов. */
async function call(argv, { tracker, statuses = {}, client, loadGateway } = {}) {
  const out = [];
  const errs = [];
  const profile = tracker === undefined ? {} : { "трекер": tracker };
  const code = await run(argv, { profile, statuses, client, loadGateway, env: {},
    log: (s) => out.push(s), err: (s) => errs.push(s) });
  return { code, out: out.join("\n"), err: errs.join("\n") };
}

// --- выбор шлюза по профилю ---------------------------------------------------

check("строки трекер нет: шлюз tfs, как до профиля", resolveGateway({}).name === "tfs");
check("трекер: jira -> шлюз jira", resolveGateway({ "трекер": "jira" }).name === "jira");
check("трекер: нет -> отказ, шлюза нет", /нет трекера/.test(resolveGateway({ "трекер": "нет" }).error ?? ""));
check("плейсхолдер трекера -> отказ «не заполнена»",
  /не заполнена/.test(resolveGateway({ "трекер": "<нет|tfs|jira>" }).error ?? ""));
check("неизвестный трекер -> отказ со списком шлюзов",
  /есть: tfs, jira, task-tracker/.test(resolveGateway({ "трекер": "youtrack" }).error ?? ""));

{
  const r = await call(["check"], { tracker: "нет" });
  check("трекер: нет -> код 2 и ни одного вызова шлюза", r.code === 2 && /нет трекера/.test(r.err), r.err);
}

// --- статусы по смыслу -------------------------------------------------------

check("в-работе у tfs без строки секции -> Active", resolveStatus("в-работе", "tfs").name === "Active");
check("«в работе» через пробел читается как статус по смыслу", resolveStatus("в работе", "tfs").name === "Active");
check("закрыта у tfs -> Closed, на-проверке -> Resolved",
  resolveStatus("закрыта", "tfs").name === "Closed" && resolveStatus("на-проверке", "tfs").name === "Resolved");
check("строка секции важнее умолчания шлюза",
  resolveStatus("в-работе", "tfs", { "в работе": "В процессе" }).name === "В процессе");
check("плейсхолдер в секции - как строки нет: умолчание шлюза",
  resolveStatus("в-работе", "tfs", { "в работе": "<заполнить>" }).name === "Active");
check("у jira без строки секции статус по смыслу - отказ с подсказкой",
  /Статусы трекера/.test(resolveStatus("в-работе", "jira").error ?? ""));
check("имя статуса не по смыслу уходит как есть", resolveStatus("For testing", "jira").name === "For testing");

{
  const t = translateState(["state", "21571", "на-проверке", "--assign", "Тестер"], "tfs", {});
  check("state: флаги после статуса сохраняются", JSON.stringify(t.argv) ===
    JSON.stringify(["state", "21571", "Resolved", "--assign", "Тестер"]), JSON.stringify(t.argv));
}
{
  const t = translateState(["state", "21571", "--assign", "Тестер", "закрыта"], "tfs", {});
  check("state: статус по смыслу после флагов тоже переводится", JSON.stringify(t.argv) ===
    JSON.stringify(["state", "21571", "--assign", "Тестер", "Closed"]), JSON.stringify(t.argv));
}
{
  const t = translateState(["state", "21571", "--reason", "Fixed", "Resolved"], "tfs", {});
  check("state: имя трекера после флагов не трогается", t.argv[4] === "Resolved" && t.argv[3] === "Fixed");
}

// --- контракт на шлюзе tfs ----------------------------------------------------

{
  const client = fakeTfs();
  const r = await call(["state", "21571", "в-работе"], { tracker: "tfs", client });
  const op = client.calls.find((c) => c[0] === "updateWorkItem");
  check("tfs: state в-работе доходит до трекера именем Active",
    r.code === 0 && op?.[1] === "21571" && op[2].some((o) => o.value === "Active"), r.err);
}
{
  const client = fakeTfs();
  const r = await call(["comment", "21571", "готово"], { tracker: "tfs", client });
  check("tfs: comment доходит до addComment того же id",
    r.code === 0 && client.calls.some((c) => c[0] === "addComment" && c[1] === "21571"), r.err);
}
{
  const client = fakeTfs();
  const r = await call(["check"], { client });
  check("профиль без строки трекер: check идёт в tfs", r.code === 0 && client.calls[0]?.[0] === "verifyAccess", r.err);
}

// --- контракт на шлюзе jira ---------------------------------------------------

{
  const client = fakeJira();
  const r = await call(["state", "ABC-1", "в-работе"], { tracker: "jira", statuses: { "в работе": "В работе" }, client });
  check("jira: state в-работе уходит переходом к имени из секции",
    r.code === 0 && client.calls.some((c) => c[0] === "transitionTo" && c[1] === "ABC-1" && c[2] === "В работе"), r.err);
}
{
  const client = fakeJira();
  const r = await call(["state", "ABC-1", "закрыта"], { tracker: "jira", client });
  check("jira: статус по смыслу без строки секции -> код 1, в трекер ничего не ушло",
    r.code === 1 && client.calls.length === 0, `${r.code} ${JSON.stringify(client.calls)}`);
}
{
  const client = fakeJira();
  const r = await call(["state", "ABC-1", "Ready", "to", "prod"], { tracker: "jira", client });
  check("jira: имя статуса из нескольких слов уходит как есть",
    r.code === 0 && client.calls.some((c) => c[0] === "transitionTo" && c[2] === "Ready to prod"), r.err);
}
{
  const client = fakeJira();
  const r = await call(["comment", "ABC-1", "готово"], { tracker: "jira", client });
  check("jira: comment доходит до addComment того же ключа",
    r.code === 0 && client.calls.some((c) => c[0] === "addComment" && c[1] === "ABC-1"), r.err);
}
{
  const client = fakeJira();
  const r = await call(["pr", "list", "front"], { tracker: "jira", client });
  check("jira: pr - код 4 «не умеет», клиент не вызван",
    r.code === EXIT_UNSUPPORTED && client.calls.length === 0 && /не умеет/.test(r.err), r.err);
}

// --- контракт на шлюзе task-tracker -------------------------------------------

{
  const client = fakeTt();
  const r = await call(["state", "feature-3", "в-работе"], { tracker: "task-tracker", client });
  check("task-tracker: state в-работе уходит в move_task статусом doing",
    r.code === 0 && client.calls.some((c) => c[0] === "moveTask" && c[1] === "feature-3" && c[2] === "doing"), r.err);
}
{
  const client = fakeTt();
  const r = await call(["state", "feature-3", "закрыта"], { tracker: "task-tracker", client });
  check("task-tracker: закрыта без строки секции -> done",
    r.code === 0 && client.calls.some((c) => c[0] === "moveTask" && c[2] === "done"), r.err);
}
{
  const client = fakeTt();
  const r = await call(["comment", "1", "готово"], { tracker: "task-tracker", client });
  check("task-tracker: comment доходит до comment_task того же id",
    r.code === 0 && client.calls.some((c) => c[0] === "commentTask" && c[1] === "1" && c[2] === "готово"), r.err);
}
{
  const client = fakeTt();
  const r = await call(["time", "feature-3", "1.5"], { tracker: "task-tracker", client });
  check("task-tracker: time - код 4 «не умеет», клиент не вызван",
    r.code === EXIT_UNSUPPORTED && client.calls.length === 0, r.err);
}
check("трекер: task-tracker -> шлюз task-tracker", resolveGateway({ "трекер": "task-tracker" }).name === "task-tracker");

// --- возможности и состав глаголов -------------------------------------------

check("каждый шлюз понимает все глаголы контракта",
  Object.keys(GATEWAYS).every((g) => CONTRACT_VERBS.every((v) => gatewayVerbs(g).includes(v))));
{
  const r = await call(["capabilities"], { tracker: "jira" });
  check("capabilities называет шлюз и его возможности", r.code === 0 && /шлюз: jira/.test(r.out) && /time/.test(r.out), r.out);
}
{
  let loaded = null;
  const r = await call(["get", "21571"], { tracker: "tfs", loadGateway: async (n) => { loaded = n; return { run: async () => 0 }; } });
  check("глагол контракта загружает шлюз из профиля", r.code === 0 && loaded === "tfs");
}
{
  const r = await call(["get", "1"], { tracker: "jira", loadGateway: async () => { throw new Error("нет модуля"); } });
  check("шлюз не загрузился -> код 2 с причиной", r.code === 2 && /нет модуля/.test(r.err), r.err);
}

// --- секция статусов в project.md ---------------------------------------------

{
  const dir = join(tmpdir(), "claude", "volna-tracker-test", ".volna");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "project.md"), "## Профиль\n\n- трекер: Jira\n\n## Статусы трекера\n\n" +
    "- в работе: `В работе`   # переход\n- на проверке: For Testing\n- закрыта: <заполнить>\n\n### Подраздел\n\n" +
    "- лишнее: x\n\n## Команды\n\n- в работе: чужое\n", "utf8");
  const s = readSection(dir, "Статусы трекера");
  check("секция статусов: регистр и пробелы имени сохраняются, кавычки и комментарий сняты",
    s["в работе"] === "В работе" && s["на проверке"] === "For Testing", JSON.stringify(s));
  check("секция статусов кончается на следующем «## », а не на «### »",
    s["лишнее"] === "x" && s["в работе"] !== "чужое", JSON.stringify(s));
  check("профиль по-прежнему в нижнем регистре", readProfile(dir)["трекер"] === "jira");
}

console.log(failures ? `\nПРОВАЛЕНО: ${failures}` : "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ");
process.exit(failures ? 1 : 0);
