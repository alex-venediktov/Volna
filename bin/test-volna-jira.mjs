/**
 * Проверка CLI над Jira без сети: клиент подменяется заглушкой, которая записывает вызовы,
 * а сетевой слой - подставным fetch. Главное, что проверяется: markdown уходит в трекер
 * wiki-разметкой, статус меняется переходом, --dry-run не отправляет ничего.
 *
 * Запуск: node bin/test-volna-jira.mjs
 */
import { run, parseArgs, describeIntent, ISSUE_KEY } from "./volna-jira.mjs";
import { JiraClient, jiraConfigFromEnv, markdownToJiraWiki, jiraWikiToMarkdown, matchTransition,
  issueKind, formatDuration, retryAfterMs, summarizeIssue, errorHint } from "../lib/jira-client.mjs";

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${!cond && detail ? ` -> ${detail}` : ""}`);
  if (!cond) failures++;
}

/** Заглушка клиента: помнит вызовы, ничего не отправляет. */
function fakeClient(issue = {}, extra = {}) {
  const calls = [];
  return {
    calls,
    jqlMine: extra.jqlMine,
    async verifyAccess() {
      calls.push(["verifyAccess"]);
      return extra.access ?? { ok: true, status: 200, user: { displayName: "Иван Петров", emailAddress: "i@p" } };
    },
    async accessProblem() {
      calls.push(["accessProblem"]);
      return extra.denied ?? null;
    },
    async currentUser() {
      calls.push(["currentUser"]);
      return { displayName: "Иван Петров", accountId: "acc-1", emailAddress: "i@p" };
    },
    async getIssue(key) { calls.push(["getIssue", key]); return issue; },
    async comments(key) { calls.push(["comments", key]); return extra.comments ?? []; },
    async searchJql(jql, opts) {
      calls.push(["searchJql", jql, opts]);
      return extra.search ?? { issues: [], pages: 1, truncated: false };
    },
    async transitions(key) { calls.push(["transitions", key]); return extra.transitions ?? []; },
    async transitionTo(key, wanted) {
      calls.push(["transitionTo", key, wanted]);
      return { id: "31", name: wanted, to: { name: "В работе" } };
    },
    async addComment(key, md) { calls.push(["addComment", key, md]); return { id: "10001" }; },
    async setDescription(key, md, opts) { calls.push(["setDescription", key, md, opts]); return {}; },
    async setEstimate(key, v) { calls.push(["setEstimate", key, v]); return {}; },
    async addWorklog(key, hours, opts) { calls.push(["addWorklog", key, hours, opts]); return {}; },
    async projectStatuses() {
      calls.push(["projectStatuses"]);
      return extra.statuses ?? [{ name: "Task", statuses: [{ name: "В работе" }] }];
    },
  };
}

/** Собрать вывод команды: строки stdout и stderr раздельно. */
async function runCli(argv, deps = {}) {
  const out = [];
  const errs = [];
  const code = await run(argv, { log: (s) => out.push(s), err: (s) => errs.push(s), ...deps });
  return { code, out: out.join("\n"), err: errs.join("\n") };
}

const ISSUE = {
  key: "ABC-2228",
  fields: {
    summary: "Заголовок задачи",
    issuetype: { name: "Баг" },
    status: { name: "For testing", statusCategory: { name: "Готово" } },
    assignee: { displayName: "Пётр Иванов" },
    parent: { key: "XYZ-4475", fields: { summary: "Эпик" } },
    labels: ["автотесты"],
    description: "h2. Итог\n\n* пункт",
    timetracking: { originalEstimate: "1d", timeSpent: "1d", remainingEstimate: "0m" },
  },
};

// --- 1. Разбор аргументов ---------------------------------------------------

{
  const { command, args, flags } = parseArgs(["comment", "ABC-1", "текст", "--body-file", "f.md", "--dry-run"]);
  check("разбор аргументов: команда и позиционные отделяются от признаков",
    command === "comment" && args[0] === "ABC-1" && flags["body-file"] === "f.md" && flags["dry-run"] === true,
    JSON.stringify({ command, args, flags }));
}

check("ключ задачи опознаётся по форме, а число - нет",
  ISSUE_KEY.test("ABC-2228") && ISSUE_KEY.test("A1-7") && !ISSUE_KEY.test("21571") && !ISSUE_KEY.test("Задача"));

// --- 2. Чтение --------------------------------------------------------------

{
  const client = fakeClient(ISSUE, { comments: [{ author: { displayName: "Автор" }, created: "2026-07-01T10:00", body: "*важно*" }] });
  const { code, out } = await runCli(["get", "ABC-2228"], { client });
  check("get печатает карточку задачи с видом для флоу", code === 0 && out.includes("вид для флоу: bug"), out.slice(0, 200));
  check("get называет родителя из чужого проекта", out.includes("XYZ-4475"), out.slice(0, 200));
  check("get переводит wiki-разметку описания в markdown", out.includes("## Итог") && out.includes("- пункт"), out);
  check("get показывает обсуждение", out.includes("Автор") && out.includes("**важно**"), out);
}

{
  const client = fakeClient({}, { access: { ok: false, status: 401, body: "unauthorized" } });
  const { code, out } = await runCli(["check"], { client });
  check("check различает истекший токен", code === 1 && out.includes("401"), out);
}

{
  const client = fakeClient({}, { access: { ok: false, status: 0, body: "network" } });
  const { out } = await runCli(["check"], { client });
  check("check отличает недоступность сети от отказа сервера", out.includes("недоступен"), out);
}

{
  const client = fakeClient({}, { search: { issues: [{ key: "ABC-1", fields: { summary: "с", issuetype: { name: "Задача" }, status: { name: "В работе" } } }], pages: 2, truncated: true } });
  const { out } = await runCli(["query", "project", "=", "ABC"], { client, env: {} });
  check("query называет обрезанный по пределу страниц ответ", out.includes("обрезан"), out);
  check("query печатает строку на задачу", out.includes("ABC-1"), out);
}

{
  const client = fakeClient({}, {});
  await runCli(["query"], { client, env: { JIRA_JQL_MINE: "assignee = currentUser()" } });
  check("query без аргумента берёт выборку из JIRA_JQL_MINE",
    client.calls[0][1] === "assignee = currentUser()", JSON.stringify(client.calls[0]));
}

// пустая выборка неотличима от отказа: сервер отвечает пустым списком и на запрос без доступа
{
  const client = fakeClient({}, { denied: "токен истёк (401)" });
  const { code, out, err } = await runCli(["query", "project = ABC"], { client, env: {} });
  check("пустая выборка при отсутствии доступа подаётся как отказ, а не как «задач нет»",
    code === 1 && err.includes("Доступа к трекеру нет") && !out.includes("найдено: 0"), `${code} | ${out} | ${err}`);
}

{
  const client = fakeClient({}, {});
  const { code, out } = await runCli(["query", "project = ABC"], { client, env: {} });
  check("пустая выборка при живом доступе называет доступ проверенным",
    code === 0 && out.includes("доступ к трекеру есть"), `${code} | ${out}`);
}

{
  const client = fakeClient({}, { denied: "прав не хватает (403)" });
  client.getIssue = async () => { throw new Error("Jira GET .../issue/A-1 -> HTTP 404: Issue does not exist"); };
  const { code, err } = await runCli(["get", "A-1"], { client });
  check("«задачи не существует» дополняется проверкой доступа: 404 приходит и без прав",
    code === 1 && err.includes("Дело может быть не в ключе"), err);
}

{
  const client = fakeClient({}, { denied: "токен истёк (401)" });
  client.getIssue = async () => { throw new Error("Jira PUT .../issue/A-1 -> HTTP 400: bad request"); };
  const { err } = await runCli(["get", "A-1"], { client });
  check("на отказ, не связанный с ненайденным, доступ не перепроверяется",
    !err.includes("Дело может быть не в ключе"), err);
}

{
  const client = fakeClient({}, { transitions: [{ id: "1", name: "В тестирование", to: { name: "Тестирование" } }] });
  const { out } = await runCli(["states", "ABC-2228"], { client });
  check("states по ключу печатает переходы, а не статусы",
    out.includes("В тестирование -> статус Тестирование"), out);
}

{
  const client = fakeClient({}, { statuses: [{ name: "Bug", statuses: [{ name: "В работе" }, { name: "Готово" }] }] });
  const { out } = await runCli(["states", "Баг"], { client });
  check("states находит тип по переведённому имени", out.includes("Статусы типа Bug"), out);
}

// --- 3. Запись --------------------------------------------------------------

{
  const client = fakeClient();
  const { code } = await runCli(["comment", "ABC-1", "текст с **жирным**"], { client });
  check("comment отправляет запись сразу, без флага подтверждения",
    code === 0 && client.calls.some((c) => c[0] === "addComment"), JSON.stringify(client.calls));
}

{
  const client = fakeClient();
  const { code, err } = await runCli(["comment", "ABC-1", "текст", "--dry-run"], { client });
  check("dry-run печатает намерение и не зовёт клиент",
    code === 0 && !client.calls.length && err.includes("ничего не отправлено"), err);
}

{
  const client = fakeClient();
  await runCli(["describe", "ABC-1", "абзац"], { client });
  const call = client.calls.find((c) => c[0] === "setDescription");
  check("describe по умолчанию дополняет описание, а не заменяет", call && call[3].replace === false,
    JSON.stringify(call));
}

{
  const client = fakeClient();
  await runCli(["describe", "ABC-1", "абзац", "--replace"], { client });
  const call = client.calls.find((c) => c[0] === "setDescription");
  check("describe с --replace заменяет описание целиком", call && call[3].replace === true, JSON.stringify(call));
}

{
  const client = fakeClient();
  const { out } = await runCli(["state", "ABC-1", "В работе"], { client });
  check("state называет выполненный переход и целевой статус",
    out.includes("переход") && out.includes("В работе"), out);
}

{
  const client = fakeClient();
  await runCli(["time", "ABC-1", "1,5", "--comment", "правка"], { client });
  const call = client.calls.find((c) => c[0] === "addWorklog");
  check("time принимает часы с запятой как десятичную дробь", call && call[2] === "1.5", JSON.stringify(call));
}

{
  const client = fakeClient();
  const { code, err } = await runCli(["estimate", "ABC-1"], { client });
  check("estimate без значений отказывается работать", code === 1 && err.includes("хотя бы одно"), err);
}

check("намерение dry-run называет ключ и действие",
  describeIntent("state", ["ABC-1", "В", "работе"], {}).includes("ABC-1"));

// --- 4. Разметка ------------------------------------------------------------

{
  const wiki = markdownToJiraWiki("Текст с **жирным**, *курсивом* и `кодом 5` и числом 42.");
  check("markdown: жирный не превращается в курсив", wiki.includes("*жирным*") && wiki.includes("_курсивом_"), wiki);
  check("markdown: инлайн-код уходит в двойные фигурные скобки", wiki.includes("{{кодом 5}}"), wiki);
  check("markdown: число в тексте не съедается маркером кода", wiki.includes("числом 42"), wiki);
}

check("markdown: заголовок переводится в h-уровень", markdownToJiraWiki("## Итог") === "h2. Итог");
check("markdown: маркированный список переводится в звёздочки",
  markdownToJiraWiki("- первый\n  - вложенный") === "* первый\n** вложенный");
check("markdown: нумерованный список переводится в решётки",
  markdownToJiraWiki("1. первый\n2. второй") === "# первый\n# второй");
check("markdown: ссылка собирается через вертикальную черту",
  markdownToJiraWiki("[текст](https://e.com)") === "[текст|https://e.com]");
check("markdown: цитата переводится в bq.", markdownToJiraWiki("> цитата") === "bq. цитата");

{
  const wiki = markdownToJiraWiki("```js\nconst a = **не разметка**;\n```");
  check("markdown: содержимое блока кода переносится дословно",
    wiki === "{code:js}\nconst a = **не разметка**;\n{code}", wiki);
}

{
  const wiki = markdownToJiraWiki("| поле | значение |\n|---|---|\n| a | 1 |");
  check("markdown: шапка таблицы получает двойные черты", wiki === "||поле||значение||\n|a|1|", wiki);
}

{
  const md = "Текст с **жирным**, *курсивом* и `кодом`.";
  check("разметка выдерживает обратный перевод", jiraWikiToMarkdown(markdownToJiraWiki(md)) === md,
    jiraWikiToMarkdown(markdownToJiraWiki(md)));
}

check("wiki: вложение показывается именем файла",
  jiraWikiToMarkdown("!image-1.png|width=671!") === "(вложение: image-1.png)");

// --- 5. Правила клиента -----------------------------------------------------

check("переход ищется по имени самого перехода",
  matchTransition([{ id: "1", name: "Начать", to: { name: "В работе" } }], "Начать")?.id === "1");
check("переход ищется и по имени целевого статуса",
  matchTransition([{ id: "1", name: "Начать", to: { name: "В работе" } }], "в работе")?.id === "1");
check("недоступный переход не подбирается наугад",
  matchTransition([{ id: "1", name: "Начать", to: { name: "В работе" } }], "Закрыть") === null);

check("вид задачи определяется по переведённому имени типа", issueKind({ name: "Баг" }) === "bug");
check("вид задачи определяется по исходному имени типа", issueKind({ name: "Bug" }) === "bug");
check("история опознаётся как story", issueKind({ name: "История" }) === "story");
check("незнакомый тип считается задачей", issueKind({ name: "Improvement" }) === "task");

check("часы переводятся в запись длительности Jira", formatDuration(1.5) === "1h 30m");
check("целые часы записываются без минут", formatDuration(8) === "8h");

check("пауза берётся из Retry-After в секундах", retryAfterMs("30") === 30000);
check("пустой Retry-After даёт разумную паузу по умолчанию", retryAfterMs("") === 10000);
check("пауза ограничена сверху", retryAfterMs("100000") === 120000);

check("подсказка объясняет удалённый адрес поиска", errorHint("", 410).includes("/search/jql"));
check("подсказка объясняет отказ по правам", errorHint("", 403).includes("прав"));

{
  const text = summarizeIssue(ISSUE, []);
  check("карточка задачи называет время работ", text.includes("оценка 1d"), text);
  check("карточка задачи пустое описание называет словами",
    summarizeIssue({ key: "A-1", fields: {} }, []).includes("описание пустое"));
}

// --- 6. Конфигурация и сеть -------------------------------------------------

{
  let failed = "";
  try {
    jiraConfigFromEnv({ JIRA_BASE_URL: "https://e.atlassian.net", JIRA_TOKEN_FILE: "t.txt" });
  } catch (e) {
    failed = String(e.message);
  }
  check("без JIRA_EMAIL конфигурация не собирается: Basic без почты бесполезен",
    failed.includes("JIRA_EMAIL"), failed);
}

{
  const seen = [];
  const client = new JiraClient({
    baseUrl: "https://e.atlassian.net/", email: "i@p", token: "секрет",
    fetchFn: (url, init) => {
      seen.push({ url, auth: init.headers.Authorization });
      return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ key: "A-1" }) });
    },
  });
  await client.getIssue("A-1");
  check("адрес собирается по версии 2: текстовые поля приходят строкой",
    seen[0].url.startsWith("https://e.atlassian.net/rest/api/2/issue/A-1"), seen[0].url);
  check("доступ идёт Basic-парой из почты и токена",
    seen[0].auth === `Basic ${Buffer.from("i@p:секрет").toString("base64")}`, seen[0].auth);
}

{
  let calls = 0;
  const waited = [];
  const client = new JiraClient({
    baseUrl: "https://e.atlassian.net", email: "i@p", token: "t",
    sleepFn: (ms) => { waited.push(ms); return Promise.resolve(); },
    fetchFn: () => {
      calls++;
      const tooMany = calls === 1;
      return Promise.resolve({
        ok: !tooMany, status: tooMany ? 429 : 200,
        headers: { get: () => "2" },
        text: async () => (tooMany ? "rate limited" : "{}"),
      });
    },
  });
  await client.getIssue("A-1");
  check("при 429 повтор идёт после паузы, названной сервером",
    calls === 2 && waited[0] === 2000, JSON.stringify({ calls, waited }));
}

{
  const client = new JiraClient({
    baseUrl: "https://e.atlassian.net", email: "i@p", token: "t",
    fetchFn: () => Promise.resolve({ ok: false, status: 401, text: async () => "unauthorized" }),
  });
  const problem = await client.accessProblem();
  check("отказ в доступе объясняется словами, а не кодом", /401/.test(problem) && /токен/.test(problem), problem);
}

{
  const client = new JiraClient({
    baseUrl: "https://e.atlassian.net", email: "i@p", token: "t",
    fetchFn: () => Promise.resolve({ ok: true, status: 200, text: async () => "{}" }),
  });
  check("при живом доступе проверка молчит", (await client.accessProblem()) === null);
}

{
  const client = new JiraClient({
    baseUrl: "https://e.atlassian.net", email: "i@p", token: "t",
    fetchFn: () => Promise.reject(new Error("network down")),
  });
  const problem = await client.accessProblem();
  check("недоступность сети не выдаётся за отказ в правах", /недоступен/.test(problem), problem);
}

{
  const pages = [
    { issues: [{ key: "A-1" }], nextPageToken: "t1", isLast: false },
    { issues: [{ key: "A-2" }], nextPageToken: "t2", isLast: false },
  ];
  let i = 0;
  const client = new JiraClient({
    baseUrl: "https://e.atlassian.net", email: "i@p", token: "t",
    fetchFn: () => Promise.resolve({
      ok: true, status: 200, text: async () => JSON.stringify(pages[Math.min(i++, 1)]),
    }),
  });
  const res = await client.searchJql("project = A", { maxPages: 2 });
  check("страницы поиска идут курсором и кончаются на пределе",
    res.issues.length === 2 && res.truncated === true, JSON.stringify(res));
}

{
  const seen = [];
  const client = new JiraClient({
    baseUrl: "https://e.atlassian.net", email: "i@p", token: "t",
    fetchFn: (url, init) => {
      seen.push({ url, body: init.body ? Buffer.from(init.body).toString("utf8") : null });
      return Promise.resolve({ ok: true, status: 200, text: async () => "{}" });
    },
  });
  await client.addComment("A-1", "текст с **жирным**");
  check("комментарий уходит wiki-разметкой, а не markdown",
    seen[0].body.includes("*жирным*") && !seen[0].body.includes("**жирным**"), seen[0].body);
  check("тело запроса кодируется UTF8-байтами", seen[0].body.includes("текст"), seen[0].body);
}

{
  const client = new JiraClient({
    baseUrl: "https://e.atlassian.net", email: "i@p", token: "t",
    fetchFn: () => Promise.resolve({
      ok: true, status: 200,
      text: async () => JSON.stringify({ transitions: [{ id: "1", name: "Начать", to: { name: "В работе" } }] }),
    }),
  });
  let failed = "";
  try {
    await client.transitionTo("A-1", "Закрыть");
  } catch (e) {
    failed = String(e.message);
  }
  check("недоступный переход даёт список доступных, а не трассировку",
    failed.includes("недоступен") && failed.includes("Начать"), failed);
}

console.log(failures ? `\nПРОВАЛЕНО: ${failures}` : "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ");
process.exit(failures ? 1 : 0);
