/**
 * Проверка CLI над task-tracker без сети: сервер подменяется подставным fetch, который отвечает
 * JSON-RPC как настоящий и помнит вызванные инструменты. Главное, что проверяется: глагол доходит
 * до своего инструмента с нужными аргументами и X-Project; отказ инструмента при HTTP 200 - отказ,
 * а не успех; висящий сервер - «недоступен»; id новой задачи - наибольший номер по серверу + 1.
 *
 * Запуск: node bin/test-volna-tt.mjs
 */
import { run, parseArgs, describeIntent, summarizeTask } from "./volna-tt.mjs";
import { TaskTrackerClient, ttConfigFromEnv, prefixFor, taskKind, nextNumber, parseRpcBody, toolResult,
  TtError } from "../lib/tt-client.mjs";

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${!cond && detail ? ` -> ${detail}` : ""}`);
  if (!cond) failures++;
}

/** Ответ инструмента как у сервера: structuredContent.result и тот же JSON строкой в content. */
function ok(result) {
  return { content: [{ type: "text", text: JSON.stringify(result) }], isError: false, structuredContent: { result } };
}

/** Подставной сервер: tools - имя инструмента -> функция(аргументы) -> результат либо { error }. */
function fakeServer(tools = {}, { sse = false } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const msg = JSON.parse(new TextDecoder().decode(init.body));
    const { name, arguments: args } = msg.params;
    calls.push({ name, args, headers: init.headers, signal: init.signal });
    const impl = tools[name];
    const out = impl ? impl(args) : { error: `инструмента ${name} нет` };
    const result = out?.error !== undefined
      ? { content: [{ type: "text", text: `Error executing tool ${name}: ${out.error}` }], isError: true }
      : ok(out);
    const body = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
    return { ok: true, status: 200, text: async () => (sse ? `event: message\ndata: ${body}\n\n` : body) };
  };
  return { calls, fetchFn };
}

/** Сервер с задачами в двух проектах: голые номера, свои префиксные id и чужой. */
function serverWithTasks(extra = {}) {
  const tasks = {
    volna: [{ id: "1", status: "done", title: "a", tags: [] }, { id: "feature-4", status: "doing", title: "b", tags: [] }],
    other: [{ id: "bugfix-7", status: "todo", title: "c", tags: ["bug"] }, { id: "notes", status: "todo", title: "d", tags: [] }],
  };
  return fakeServer({
    list_projects: () => Object.keys(tasks).map((project) => ({ project, tasks: tasks[project].length })),
    list_tasks: (a) => (tasks[a.project ?? "volna"] ?? []).filter((t) => !a.status || t.status === a.status),
    create_task: (a) => ({ id: a.task_id, title: a.title, status: a.status ?? "backlog" }),
    comment_task: (a) => ({ id: a.task_id }),
    ...extra,
  });
}

/** Прогон CLI на настоящем клиенте с подставным fetch. */
async function call(argv, server, files = {}) {
  const out = [];
  const errs = [];
  const client = new TaskTrackerClient({ url: "http://tt/mcp", project: "volna", fetchFn: server.fetchFn });
  const code = await run(argv, { client, env: {}, readFile: (p) => files[p],
    log: (s) => out.push(s), err: (s) => errs.push(s) });
  return { code, out: out.join("\n"), err: errs.join("\n") };
}

// --- чистые функции ---------------------------------------------------------

check("вид -> префикс: bug -> bugfix, task и story -> feature, research -> research",
  prefixFor("bug") === "bugfix" && prefixFor("task") === "feature" && prefixFor("Story") === "feature" &&
  prefixFor("research") === "research");
check("префикс принимается как вид, неизвестный вид - null", prefixFor("bugfix") === "bugfix" && prefixFor("epic") === null);
check("вид для флоу по префиксу id", taskKind({ id: "bugfix-2" }) === "bug" && taskKind({ id: "research-5" }) === "research");
check("вид без префикса - по тегу, без тега - task",
  taskKind({ id: "1", tags: ["Bug"] }) === "bug" && taskKind({ id: "2", tags: ["video"] }) === "task");
check("номер - наибольший среди голых номеров и префиксных id, чужие строки не в счёт",
  nextNumber(["1", "2", "feature-4", "bugfix-3", "notes", "x-99"]) === 5);
check("пустой сервер - номер 1", nextNumber([]) === 1);
check("ответ SSE: сообщение берётся из строки data:",
  parseRpcBody('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n')?.id === 1);
check("результат - structuredContent.result", JSON.stringify(toolResult(ok([1, 2]))) === "[1,2]");
check("результат без structuredContent - JSON из content",
  toolResult({ content: [{ type: "text", text: '{"a":1}' }] }).a === 1);
{
  let thrown = null;
  try { toolResult({ content: [{ type: "text", text: "задачи #9 нет" }], isError: true }); } catch (e) { thrown = e; }
  check("isError -> исключение с текстом сервера", thrown instanceof TtError && thrown.status === "tool" &&
    /задачи #9 нет/.test(thrown.message));
}
{
  let thrown = null;
  try { ttConfigFromEnv({ TT_MCP_URL: "http://tt/mcp" }); } catch (e) { thrown = e; }
  check("без TT_PROJECT конфиг не собирается, переменная названа", /TT_PROJECT/.test(thrown?.message ?? ""));
  check("таймаут из TT_TIMEOUT_MS, без него - 5000",
    ttConfigFromEnv({ TT_MCP_URL: "u", TT_PROJECT: "p", TT_TIMEOUT_MS: "1500" }).timeoutMs === 1500 &&
    ttConfigFromEnv({ TT_MCP_URL: "u", TT_PROJECT: "p" }).timeoutMs === 5000);
}
check("parseArgs: значение флага --title и признак --all",
  JSON.stringify(parseArgs(["create", "bug", "--title", "Т", "--all"])) ===
  JSON.stringify({ command: "create", args: ["bug"], flags: { title: "Т", all: true } }));

// --- запрос к серверу -------------------------------------------------------

{
  const s = fakeServer({ get_task: (a) => ({ id: a.task_id, title: "Заголовок", status: "todo", tags: [], body: "## Цель\n\nтекст" }) });
  const r = await call(["get", "feature-3"], s);
  const c = s.calls[0];
  check("get: инструмент get_task с task_id, заголовок X-Project своего проекта",
    c?.name === "get_task" && c.args.task_id === "feature-3" && c.headers["X-Project"] === "volna", JSON.stringify(c));
  check("get: у запроса есть сигнал таймаута", Boolean(c?.signal));
  check("get: карточка с видом для флоу и постановкой", r.code === 0 && /вид для флоу: task/.test(r.out) && /## Цель/.test(r.out), r.out);
}
{
  const s = fakeServer({ get_task: (a) => ({ id: a.task_id, title: "x", status: "todo", tags: [] }) }, { sse: true });
  const r = await call(["get", "1"], s);
  check("ответ потоком SSE разбирается так же", r.code === 0 && /# 1 · x/.test(r.out), r.err);
}
{
  const s = fakeServer({ get_task: () => ({ error: "задачи #999999 нет" }) });
  const r = await call(["get", "999999"], s);
  check("отказ инструмента при HTTP 200 -> код 1 с текстом сервера", r.code === 1 && /задачи #999999 нет/.test(r.err), r.err);
}
{
  // таймер держит процесс, как держал бы открытый сокет: таймер сигнала процесс не держит
  const hang = { fetchFn: async (url, init) => new Promise((_, reject) => {
    const hold = setTimeout(() => reject(new Error("таймаут клиента не сработал")), 2000);
    init.signal.addEventListener("abort", () => { clearTimeout(hold); reject(init.signal.reason); });
  }) };
  const out = [];
  const errs = [];
  const client = new TaskTrackerClient({ url: "http://tt/mcp", project: "volna", timeoutMs: 50, fetchFn: hang.fetchFn });
  const code = await run(["get", "1"], { client, env: {}, log: (s) => out.push(s), err: (s) => errs.push(s) });
  check("висящий сервер -> «недоступен» по таймауту, код не 0",
    code !== 0 && /недоступен: не ответил за 50 мс/.test(errs.join("\n")), errs.join("\n"));
}
{
  const client = new TaskTrackerClient({ url: "http://tt/mcp", project: "volna",
    fetchFn: async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); } });
  const res = await client.verifyAccess();
  check("check без сервера: status 0 и причина сети", !res.ok && res.status === 0 && /ECONNREFUSED/.test(res.body), res.body);
}
{
  const s = fakeServer({ list_projects: () => [{ project: "volna", tasks: 3 }] });
  const r = await call(["check"], s);
  check("check: сервер ответил - код 0, число задач своего проекта", r.code === 0 && /задач 3/.test(r.out), r.out);
}
{
  const r = await call(["query"], serverWithTasks());
  check("query без статуса: свой проект без done", r.code === 0 && /feature-4/.test(r.out) && !/- 1 ·/.test(r.out), r.out);
}
{
  const r = await call(["query", "--all"], serverWithTasks());
  check("query --all: и закрытые тоже", r.code === 0 && /- 1 ·/.test(r.out), r.out);
}
{
  const r = await call(["states"], fakeServer());
  check("states: пять статусов сервера без запроса", r.code === 0 && /backlog · todo · doing · review · done/.test(r.out), r.out);
}

// --- запись -----------------------------------------------------------------

{
  const s = fakeServer({ move_task: (a) => ({ id: a.task_id, status: a.status }) });
  const r = await call(["state", "feature-3", "doing"], s);
  check("state: move_task с id и статусом", r.code === 0 && s.calls[0]?.name === "move_task" &&
    s.calls[0].args.status === "doing", JSON.stringify(s.calls));
}
{
  const s = fakeServer();
  const r = await call(["state", "feature-3", "Active"], s);
  check("state: чужое имя статуса - отказ до запроса со списком", r.code === 1 && s.calls.length === 0 && /doing/.test(r.err), r.err);
}
{
  const s = fakeServer({ comment_task: (a) => ({ id: a.task_id }) });
  const r = await call(["comment", "1", "--body-file", "c.md"], s, { "c.md": "Доставлено: abc123" });
  check("comment: текст из файла уходит comment_task", r.code === 0 && s.calls[0]?.args.text === "Доставлено: abc123", r.err);
}
{
  const s = fakeServer({ get_task: () => ({ id: "1", body: "## Цель\n\nбыло\n" }), update_task: (a) => ({ id: a.task_id }) });
  const r = await call(["describe", "1", "--body-file", "d.md"], s, { "d.md": "## Итог\n\nстало" });
  const upd = s.calls.find((c) => c.name === "update_task");
  check("describe: абзац дописывается к прежней постановке", r.code === 0 && upd?.args.body === "## Цель\n\nбыло\n\n## Итог\n\nстало",
    JSON.stringify(upd?.args));
}
{
  const s = fakeServer({ update_task: (a) => ({ id: a.task_id }) });
  const r = await call(["describe", "1", "--body-file", "d.md", "--replace"], s, { "d.md": "новое" });
  check("describe --replace: прежняя постановка не читается", r.code === 0 && s.calls.length === 1 &&
    s.calls[0].args.body === "новое", JSON.stringify(s.calls));
}
{
  const s = serverWithTasks();
  const r = await call(["create", "bug", "--title", "Падает экспорт"], s);
  const c = s.calls.find((x) => x.name === "create_task");
  check("create bug: id bugfix-<наибольший по серверу + 1>, тег bug",
    r.code === 0 && c?.args.task_id === "bugfix-8" && JSON.stringify(c.args.tags) === '["bug"]', JSON.stringify(c?.args));
  check("create: в максимум идут задачи всех проектов сервера",
    s.calls.filter((x) => x.name === "list_tasks").map((x) => x.args.project).join(",") === "volna,other");
}
{
  const s = serverWithTasks();
  const r = await call(["create", "task", "--title", "Ребёнок", "--parent", "feature-4", "--body", "постановка"], s);
  const c = s.calls.find((x) => x.name === "create_task");
  const parentNote = s.calls.find((x) => x.name === "comment_task");
  check("create --parent: родитель строкой в постановке", c?.args.body === "родитель: feature-4\n\nпостановка" &&
    c.args.task_id === "feature-8", JSON.stringify(c?.args));
  check("create --parent: у родителя комментарий с id ребёнка",
    r.code === 0 && parentNote?.args.task_id === "feature-4" && /feature-8/.test(parentNote.args.text), JSON.stringify(parentNote));
}
{
  let tries = 0;
  const s = serverWithTasks({
    create_task: (a) => (++tries === 1 ? { error: `id ${a.task_id} уже занят` } : { id: a.task_id, title: a.title }),
  });
  const r = await call(["create", "research", "--title", "Разбор"], s);
  check("create: id заняли между подсчётом и заведением - номер считается заново",
    r.code === 0 && tries === 2 && /research-8 создана/.test(r.out), r.out + r.err);
}
{
  const s = serverWithTasks({ create_task: () => "" });
  const r = await call(["create", "task", "--title", "x"], s);
  check("create: ответ без id - код 1 и одна попытка, а не перебор номеров",
    r.code === 1 && s.calls.filter((c) => c.name === "create_task").length === 1 && /feature-8/.test(r.err), r.err);
}
{
  const s = serverWithTasks({ create_task: (a) => ({ error: `id ${a.task_id} уже занят` }) });
  const r = await call(["create", "task", "--title", "x", "--id", "feature-4"], s);
  check("create --id: занятый свой id - отказ без перебора", r.code === 1 &&
    s.calls.filter((c) => c.name === "create_task").length === 1, r.err);
}
{
  const s = fakeServer();
  const r = await call(["create", "epic", "--title", "x"], s);
  check("create неизвестного вида - отказ до запроса", r.code === 1 && s.calls.length === 0 && /bug, task/.test(r.err), r.err);
}
{
  const s = fakeServer();
  const r = await call(["create", "bug", "--title", "x", "--dry-run"], s);
  check("--dry-run: ни одного запроса, намерение с правилом id",
    r.code === 0 && s.calls.length === 0 && /bugfix-<N>/.test(r.err), r.err);
}
check("describeIntent state называет статус", /в "doing"/.test(describeIntent("state", ["1", "doing"], {})));
check("summarizeTask без постановки говорит это прямо", /постановка пуста/.test(summarizeTask({ id: "1", title: "t" })));

console.log(failures ? `\nПРОВАЛЕНО: ${failures}` : "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ");
process.exit(failures ? 1 : 0);
