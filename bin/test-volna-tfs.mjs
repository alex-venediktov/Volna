/**
 * Проверка CLI над трекером без сети: клиент подменяется заглушкой, которая записывает вызовы.
 * Главное, что проверяется: без --confirm запись НЕ происходит ни при каких аргументах.
 *
 * Запуск: node bin/test-volna-tfs.mjs
 */
import { run, parseArgs } from "./volna-tfs.mjs";
import { parseEnv } from "../lib/env.mjs";
import { TfsClient, normalizeRefName, parsePullRequestUrl, pullRequestArtifactUrl, pullRequestIds }
  from "../lib/tfs-client.mjs";

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${!cond && detail ? ` -> ${detail}` : ""}`);
  if (!cond) failures++;
}

/**
 * Заглушка клиента: помнит вызовы, ничего не отправляет. found - id для выборки, items - поля
 * этих задач; пакетное чтение отдаёт их в обратном порядке, как это вправе делать сервер.
 */
function fakeClient(workItem = {}, found = [], items = {}) {
  const calls = [];
  return {
    calls,
    fieldOps(fields) {
      return Object.entries(fields).map(([ref, value]) => ({ op: "add", path: `/fields/${ref}`, value }));
    },
    async verifyAccess() { calls.push(["verifyAccess"]); return { ok: true, status: 200 }; },
    async getWorkItem(id, expand) { calls.push(["getWorkItem", id, expand]); return workItem; },
    async wiql(query) { calls.push(["wiql", query]); return found; },
    async getWorkItems(ids) {
      calls.push(["getWorkItems", ids]);
      return ids.filter((id) => items[id]).map((id) => ({ id, fields: items[id] })).reverse();
    },
    async updateWorkItem(id, ops) { calls.push(["updateWorkItem", id, ops]); return { id }; },
    async addComment(id, html) { calls.push(["addComment", id, html]); return { id }; },
    async addAttachment(id, name, bytes, opts) {
      calls.push(["addAttachment", id, name, bytes.length, opts]);
      return { id, url: "http://tracker/att/1" };
    },
    async createPullRequest(repo, opts) {
      calls.push(["createPullRequest", repo, opts]);
      return {
        id: 77, title: opts.title, status: "active", mergeStatus: "succeeded",
        source: `refs/heads/${String(opts.source).replace(/^refs\/heads\//, "")}`,
        target: `refs/heads/${String(opts.target).replace(/^refs\/heads\//, "")}`,
        repositoryId: "guid", repositoryName: repo,
        webUrl: `http://tracker/Проект/_git/${repo}/pullrequest/77`,
      };
    },
    async getPullRequest(repo, prId) {
      calls.push(["getPullRequest", repo, prId]);
      return {
        id: Number(prId), title: "Заголовок PR", status: "active", mergeStatus: "succeeded",
        source: "refs/heads/feature/1234_суть", target: "refs/heads/main",
        repositoryId: "guid", repositoryName: repo, webUrl: "",
      };
    },
    async getPullRequestCommits(repo, prId) {
      calls.push(["getPullRequestCommits", repo, prId]);
      return [{ id: "aaaaaaaa", comment: "1234: своя правка" }, { id: "bbbbbbbb", comment: "1200: чужая правка" }];
    },
    async linkPullRequestArtifact(id, repo, prId, name) {
      calls.push(["linkPullRequestArtifact", id, repo, prId, name]);
      return { url: `vstfs:///Git/PullRequestId/p%2Fr%2F${prId}`, repositoryId: "guid" };
    },
  };
}

const WI = {
  id: 2001,
  fields: {
    "System.Title": "Ошибка в примере",
    "System.WorkItemType": "Bug",
    "System.State": "Active",
    "System.AreaPath": "Проект\\Область",
    "System.Description": "<p>Ожидается маркер на <b>дальнем</b> конце дуги</p>",
    "Microsoft.VSTS.TCM.ReproSteps": "<ul><li>открыть заказ</li><li>включить зеркало</li></ul>",
    "System.History": "<p>обсуждение: смотри вложение</p>",
    "Microsoft.VSTS.Scheduling.CompletedWork": 2.5,
  },
  relations: [
    { rel: "System.LinkTypes.Hierarchy-Reverse", url: "http://tracker/_apis/wit/workItems/2000" },
    { rel: "AttachedFile", url: "http://tracker/att/9", attributes: { name: "снимок.png" } },
  ],
};

const capture = () => {
  const out = [], errs = [];
  return { out, errs, log: (s) => out.push(s), err: (s) => errs.push(s), text: () => out.join("\n"),
    errText: () => errs.join("\n") };
};

// --- разбор аргументов --------------------------------------------------------
{
  const p = parseArgs(["comment", "2001", "готово", "--confirm", "--assign", "Иван Петров"]);
  check("parseArgs: команда и позиционные", p.command === "comment" && p.args[0] === "2001", JSON.stringify(p));
  check("parseArgs: флаг со значением", p.flags.assign === "Иван Петров", JSON.stringify(p.flags));
  check("parseArgs: булев флаг", p.flags.confirm === true, JSON.stringify(p.flags));
}

// --- .env --------------------------------------------------------------------
{
  const e = parseEnv([
    "# комментарий",
    "TFS_BASE_URL=http://host/tfs/Coll   # адрес коллекции",
    'TFS_PROJECT="Проект С Пробелом"',
    "export TFS_API_VERSION=5.0",
    "EMPTY=",
  ].join("\n"));
  check(".env: значение без комментария", e.TFS_BASE_URL === "http://host/tfs/Coll", e.TFS_BASE_URL);
  check(".env: кавычки снимаются", e.TFS_PROJECT === "Проект С Пробелом", e.TFS_PROJECT);
  check(".env: префикс export", e.TFS_API_VERSION === "5.0", e.TFS_API_VERSION);
  check(".env: пустое значение", e.EMPTY === "", JSON.stringify(e.EMPTY));
}

// --- имена веток, адреса PR и связи ------------------------------------------
{
  check("ветка: короткое имя дополняется до refs/heads",
    normalizeRefName("feature/2001_суть") === "refs/heads/feature/2001_суть", normalizeRefName("feature/x"));
  check("ветка: полное имя не удваивается",
    normalizeRefName("refs/heads/main") === "refs/heads/main", normalizeRefName("refs/heads/main"));

  const art = pullRequestArtifactUrl("p-guid", "r-guid", 101);
  check("artifact-адрес: разделители именно %2F",
    art === "vstfs:///Git/PullRequestId/p-guid%2Fr-guid%2F101", art);

  const web = parsePullRequestUrl("http://host/tfs/Coll/backend/_git/frontend/pullrequest/103");
  check("веб-ссылка: репозиторий и номер разобраны",
    web?.repository === "frontend" && web?.id === 103, JSON.stringify(web));
  check("веб-ссылка: посторонний URL не выдаёт себя за PR",
    parsePullRequestUrl("http://host/tfs/Coll/_workitems/edit/2001") === null, "разобрался зря");

  const withPr = { relations: [
    { rel: "ArtifactLink", url: "vstfs:///Git/PullRequestId/p%2Fr%2F101" },
    { rel: "Hyperlink", url: "http://host/tfs/Coll/backend/_git/backend/pullrequest/102" },
    { rel: "AttachedFile", url: "http://host/att/1" },
  ] };
  check("связи задачи: номера PR собраны из artifact-ссылок и гиперссылок",
    JSON.stringify(pullRequestIds(withPr)) === "[101,102]", JSON.stringify(pullRequestIds(withPr)));
}

// --- клиент: git-запросы без сети ---------------------------------------------
{
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, method: init.method, body: init.body, contentType: init["headers"]?.["Content-Type"] });
    const body = /pullrequests/i.test(url) ? {
      pullRequestId: 101, title: "2001: суть", status: "active", mergeStatus: "succeeded",
      sourceRefName: "refs/heads/feature/2001_суть", targetRefName: "refs/heads/main",
      repository: { name: "backend" },
    }
      : /_apis\/git\/repositories/i.test(url) ? { value: [{ id: "repo-guid", name: "backend" }] }
      : /_apis\/projects\//i.test(url) ? { id: "project-guid" }
      : { id: 2001 };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const client = new TfsClient({
    baseUrl: "http://host/tfs/Coll", project: "backend", pat: "секрет", fetchFn,
  });

  const pr = await client.createPullRequest("backend", {
    source: "feature/2001_суть", target: "main", title: "2001: суть", description: "Порт, строки 15832.",
  });
  const created = seen.find((s) => /pullrequests/i.test(s.url) && s.method === "POST");
  const sent = JSON.parse(Buffer.from(created.body).toString("utf8"));
  check("клиент: имя репозитория превращено в id в адресе запроса",
    /repositories\/repo-guid\/pullrequests/.test(created.url), created.url);
  check("клиент: ветки в теле нормализованы",
    sent.sourceRefName === "refs/heads/feature/2001_суть" && sent.targetRefName === "refs/heads/main",
    JSON.stringify(sent));
  check("клиент: тело ушло UTF8-байтами и кириллица цела",
    created.body instanceof Uint8Array && sent.description === "Порт, строки 15832.",
    typeof created.body);
  check("клиент: номер PR и веб-ссылка собраны",
    pr.id === 101 && pr.webUrl === "http://host/tfs/Coll/backend/_git/backend/pullrequest/101", JSON.stringify(pr));

  const link = await client.linkPullRequestArtifact(2001, "backend", 101);
  const patched = seen.find((s) => s.method === "PATCH");
  const ops = JSON.parse(Buffer.from(patched.body).toString("utf8"));
  check("клиент: связь ставится как ArtifactLink с vstfs-адресом",
    ops[0].value.rel === "ArtifactLink" &&
    ops[0].value.url === "vstfs:///Git/PullRequestId/project-guid%2Frepo-guid%2F101" &&
    ops[0].value.attributes.name === "Pull Request", JSON.stringify(ops));
  check("клиент: адрес связи возвращается вызывающему", link.url === ops[0].value.url, link.url);

  const repoCalls = seen.filter((s) => /_apis\/git\/repositories\?/.test(s.url)).length;
  check("клиент: список репозиториев спрашивается один раз", repoCalls === 1, String(repoCalls));
}

// --- запись без --confirm НЕ выполняется -------------------------------------
{
  const cases = [
    ["comment", "2001", "текст"],
    ["time", "2001", "1.5"],
    ["link-pr", "2001", "http://pr/1"],
    ["state", "2001", "Resolved"],
    ["attach", "2001", "shot.png"],
    ["pr", "create", "backend", "feature/2001_суть", "--title", "2001: суть", "--target", "main"],
  ];
  for (const argv of cases) {
    const c = capture();
    const client = fakeClient(WI);
    const code = await run(argv, { client, log: c.log, err: c.err });
    check(`«${argv[0]}» без --confirm: код 1 и ни одного вызова`,
      code === 1 && client.calls.length === 0, `code=${code} calls=${client.calls.length}`);
    check(`«${argv[0]}» без --confirm: сказано, что собирался сделать`,
      /Собирался/.test(c.errText()), c.errText());
  }
}

// --- get: markdown с постановкой и вложениями --------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["get", "2001"], { client, log: c.log, err: c.err });
  const t = c.text();
  check("get: код 0", code === 0, String(code));
  check("get: заголовок и тип", t.includes("# 2001") && t.includes("тип: Bug"), t);
  check("get: родитель назван", t.includes("родитель: 2000"), t);
  check("get: HTML описания превращён в текст", t.includes("Ожидается маркер") && !t.includes("<b>"), t);
  check("get: шаги воспроизведения списком", t.includes("- открыть заказ"), t);
  check("get: вложение и предупреждение про PAT", t.includes("снимок.png") && t.includes("401"), t);
  check("get: часы показаны", t.includes("списано 2.5"), t);
  check("get: связи запрошены с expand", client.calls.some(([m, , e]) => m === "getWorkItem" && e === true),
    JSON.stringify(client.calls));
}

// --- query: выборка списком ---------------------------------------------------
const FOUND = [3003, 3002, 3001];
const FOUND_FIELDS = {
  3003: { "System.Title": "Первая история", "System.WorkItemType": "User Story", "System.State": "New" },
  3002: { "System.Title": "Вторая история", "System.WorkItemType": "User Story", "System.State": "New",
    "System.AssignedTo": { displayName: "Иван Петров" } },
  3001: { "System.Title": "Третья история", "System.WorkItemType": "User Story", "System.State": "New" },
};

{
  const c = capture();
  const client = fakeClient(WI, FOUND, FOUND_FIELDS);
  const code = await run(["query", "[System.State]='New'"], { client, log: c.log, err: c.err });
  const t = c.text();
  const [, sent] = client.calls.find(([m]) => m === "wiql") ?? [];
  check("query: код 0", code === 0, String(code));
  check("query: условие дополнено до полного WIQL",
    /^SELECT \[System\.Id\] FROM WorkItems WHERE \[System\.State\]='New' ORDER BY/.test(sent || ""), String(sent));
  check("query: показано число найденного", t.includes("Найдено: 3"), t);
  check("query: строка с типом, состоянием и заголовком",
    t.includes("- 3003 · User Story · New · Первая история"), t);
  check("query: назначенный показан, когда он есть", t.includes("· Иван Петров ·"), t);
  check("query: порядок из запроса сохранён",
    t.indexOf("3003") < t.indexOf("3002") && t.indexOf("3002") < t.indexOf("3001"), t);
}

{
  const c = capture();
  const client = fakeClient(WI, FOUND, FOUND_FIELDS);
  await run(["query", "SELECT [System.Id] FROM WorkItems WHERE [System.Id]=1"], { client, log: c.log, err: c.err });
  const [, sent] = client.calls.find(([m]) => m === "wiql") ?? [];
  check("query: готовый SELECT уходит без изменений",
    sent === "SELECT [System.Id] FROM WorkItems WHERE [System.Id]=1", String(sent));
}

{
  const c = capture();
  const client = fakeClient(WI, FOUND, FOUND_FIELDS);
  await run(["query", "[System.State]='New'", "--top", "2"], { client, log: c.log, err: c.err });
  const t = c.text();
  const [, asked] = client.calls.find(([m]) => m === "getWorkItems") ?? [];
  check("query --top: читаются только первые задачи", asked?.length === 2, JSON.stringify(asked));
  check("query --top: сказано, что показаны не все",
    t.includes("Найдено: 3, показано 2") && t.includes("Показаны не все"), t);
}

{
  const c = capture();
  const client = fakeClient(WI, FOUND, FOUND_FIELDS);
  const code = await run(["query", "[System.State]='New'", "--ids"], { client, log: c.log, err: c.err });
  check("query --ids: только id, без чтения полей",
    code === 0 && c.text() === "3003,3002,3001" && !client.calls.some(([m]) => m === "getWorkItems"),
    c.text());
}

{
  const c = capture();
  const client = fakeClient(WI, [], {});
  const code = await run(["query", "[System.Id]=0"], { client, log: c.log, err: c.err });
  check("query: пустая выборка не читает поля",
    code === 0 && /Ничего не найдено/.test(c.text()) && !client.calls.some(([m]) => m === "getWorkItems"),
    c.text());

  const c2 = capture();
  const client2 = fakeClient(WI, FOUND, FOUND_FIELDS);
  const code2 = await run(["query"], { client: client2, log: c2.log, err: c2.err });
  check("query без запроса: код 1, запросов нет", code2 === 1 && client2.calls.length === 0, String(code2));
}

// --- comment: markdown уходит как HTML ---------------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["comment", "2001", "- правка в модуле\n- тест добавлен", "--confirm"],
    { client, log: c.log, err: c.err });
  const [, , html] = client.calls.find(([m]) => m === "addComment") ?? [];
  check("comment: код 0", code === 0, String(code));
  check("comment: markdown превращён в HTML", /<ul><li>/.test(html || ""), String(html));
}

// --- time: прибавление и замена ----------------------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  await run(["time", "2001", "1.5", "--confirm"], { client, log: c.log, err: c.err });
  const ops = client.calls.find(([m]) => m === "updateWorkItem")?.[2] ?? [];
  check("time: прибавляет к текущим часам (2.5 + 1.5 = 4)",
    ops.some((o) => o.path.endsWith("CompletedWork") && o.value === 4), JSON.stringify(ops));

  const c2 = capture();
  const client2 = fakeClient(WI);
  await run(["time", "2001", "1.5", "--set", "--confirm"], { client: client2, log: c2.log, err: c2.err });
  const ops2 = client2.calls.find(([m]) => m === "updateWorkItem")?.[2] ?? [];
  check("time --set: заменяет значение", ops2.some((o) => o.value === 1.5), JSON.stringify(ops2));
  check("time --set: текущее значение не читалось",
    !client2.calls.some(([m]) => m === "getWorkItem"), JSON.stringify(client2.calls));
}

// --- pr create ---------------------------------------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["pr", "create", "backend", "feature/2001_суть", "--title", "2001: суть правки",
    "--target", "main", "--work-item", "2001", "--confirm"], { client, log: c.log, err: c.err });
  const [, repo, opts] = client.calls.find(([m]) => m === "createPullRequest") ?? [];
  const link = client.calls.find(([m]) => m === "linkPullRequestArtifact");
  const t = c.text();
  check("pr create: код 0", code === 0, String(code));
  check("pr create: репозиторий, ветки и заголовок переданы",
    repo === "backend" && opts?.source === "feature/2001_суть" && opts?.target === "main" &&
    opts?.title === "2001: суть правки", JSON.stringify([repo, opts]));
  check("pr create: номер PR и состояние слияния показаны",
    t.includes("PR 77 создан") && t.includes("слияние succeeded"), t);
  check("pr create: --work-item ставит нативную связь",
    link?.[1] === "2001" && link?.[3] === 77 && link?.[4] === "Pull Request", JSON.stringify(link));
  check("pr create: про пустое описание предупредил", /Описание пустое/.test(t), t);
}

{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["pr", "create", "backend", "feature/2001_суть", "--title", "2001: суть",
    "--body-file", "D:/tmp/описание.md", "--confirm"],
    { client, log: c.log, err: c.err, env: { TFS_TARGET_BRANCH: "main" },
      readFile: () => Buffer.from("Порт по эталону, строки 15832-16246.", "utf8") });
  const [, , opts] = client.calls.find(([m]) => m === "createPullRequest") ?? [];
  const t = c.text();
  check("pr create: целевая ветка берётся из TFS_TARGET_BRANCH", opts?.target === "main", JSON.stringify(opts));
  check("pr create: описание читается файлом как UTF8",
    opts?.description === "Порт по эталону, строки 15832-16246.", JSON.stringify(opts?.description));
  check("pr create: без --work-item подсказана команда привязки",
    /link-pr 2001 backend 77|link-pr <id> backend 77/.test(t), t);
}

{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["pr", "create", "backend", "feature/2001_суть", "--title", "2001: суть", "--confirm"],
    { client, log: c.log, err: c.err, env: {} });
  check("pr create: без целевой ветки ничего не создаётся",
    code === 1 && client.calls.length === 0 && /TFS_TARGET_BRANCH/.test(c.errText()), c.errText());

  const c2 = capture();
  const client2 = fakeClient(WI);
  const code2 = await run(["pr", "create", "backend", "feature/2001_суть", "--target", "main", "--confirm"],
    { client: client2, log: c2.log, err: c2.err, env: {} });
  check("pr create: без заголовка ничего не создаётся",
    code2 === 1 && client2.calls.length === 0 && /заголовок/.test(c2.errText()), c2.errText());

  const c3 = capture();
  const client3 = fakeClient(WI);
  const code3 = await run(["pr", "чепуха", "backend"], { client: client3, log: c3.log, err: c3.err });
  check("pr: неизвестная подкоманда - код 1 и подсказка",
    code3 === 1 && client3.calls.length === 0 && /pr create/.test(c3.errText()), c3.errText());
}

// --- pr status ---------------------------------------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["pr", "status", "backend", "77"], { client, log: c.log, err: c.err });
  const t = c.text();
  check("pr status: чтение работает без --confirm", code === 0 && t.includes("# PR 77"), t);
  check("pr status: слияние и ветки показаны",
    t.includes("слияние: succeeded") && t.includes("refs/heads/main"), t);
  check("pr status: при нескольких коммитах предупредил про чужие изменения",
    t.includes("Коммиты (2)") && /не тащит ли ветка чужие/.test(t), t);
}

// --- link-pr и state ---------------------------------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  await run(["link-pr", "2001", "backend", "77", "--confirm"], { client, log: c.log, err: c.err });
  const link = client.calls.find(([m]) => m === "linkPullRequestArtifact");
  check("link-pr: форма «репозиторий номер» даёт нативную связь",
    link?.[1] === "2001" && link?.[2] === "backend" && link?.[3] === "77", JSON.stringify(client.calls));

  const cWeb = capture();
  const clientWeb = fakeClient(WI);
  await run(["link-pr", "2001", "http://tracker/Проект/_git/frontend/pullrequest/103", "--confirm"],
    { client: clientWeb, log: cWeb.log, err: cWeb.err });
  const linkWeb = clientWeb.calls.find(([m]) => m === "linkPullRequestArtifact");
  check("link-pr: репозиторий и номер разобраны из веб-ссылки",
    linkWeb?.[2] === "frontend" && linkWeb?.[3] === 103, JSON.stringify(clientWeb.calls));

  const cOld = capture();
  const clientOld = fakeClient(WI);
  await run(["link-pr", "2001", "http://tracker/pr/11", "--title", "PR 11", "--confirm"],
    { client: clientOld, log: cOld.log, err: cOld.err });
  const ops = clientOld.calls.find(([m]) => m === "updateWorkItem")?.[2] ?? [];
  const rel = ops[0]?.value ?? {};
  check("link-pr: неопознанный URL остаётся гиперссылкой с подписью",
    rel.rel === "Hyperlink" && rel.attributes?.comment === "PR 11", JSON.stringify(ops));
  check("link-pr: про отсутствие нативной связи сказано",
    /не нативная связь/.test(cOld.text()), cOld.text());

  const c2 = capture();
  const client2 = fakeClient(WI);
  await run(["state", "2001", "Resolved", "--assign", "Тестер", "--reason", "Fixed", "--confirm"],
    { client: client2, log: c2.log, err: c2.err });
  const ops2 = client2.calls.find(([m]) => m === "updateWorkItem")?.[2] ?? [];
  const paths = ops2.map((o) => o.path);
  check("state: состояние, назначение и причина",
    paths.includes("/fields/System.State") && paths.includes("/fields/System.AssignedTo") &&
    paths.includes("/fields/System.Reason"), JSON.stringify(ops2));
  check("state: предупредил про правила перехода", /TF401320/.test(c2.text()), c2.text());
}

// --- attach ------------------------------------------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["attach", "2001", "D:/tmp/после.png", "--discussion", "--comment", "исправлено", "--confirm"],
    { client, log: c.log, err: c.err, readFile: () => Buffer.from([1, 2, 3]) });
  const call = client.calls.find(([m]) => m === "addAttachment");
  check("attach: код 0", code === 0, String(code));
  check("attach: имя файла без пути", call?.[2] === "после.png", JSON.stringify(call));
  check("attach: встраивание в обсуждение", call?.[4]?.discussion === true, JSON.stringify(call?.[4]));
}

// --- прочее ------------------------------------------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["check"], { client, log: c.log, err: c.err });
  check("check: доступ подтверждён", code === 0 && /Доступ к трекеру есть/.test(c.text()), c.text());

  const c2 = capture();
  const code2 = await run(["чепуха"], { client: fakeClient(), log: c2.log, err: c2.err });
  check("неизвестная команда: код 1 и подсказка", code2 === 1 && /volna-tfs/.test(c2.errText()), c2.errText());

  const c3 = capture();
  const code3 = await run([], { client: fakeClient(), log: c3.log, err: c3.err });
  check("без аргументов: показал использование", code3 === 1 && /Запись только с --confirm/.test(c3.text()), c3.text());

  const c4 = capture();
  const client4 = fakeClient(WI);
  const code4 = await run(["get"], { client: client4, log: c4.log, err: c4.err });
  check("get без id: код 1, запросов нет", code4 === 1 && client4.calls.length === 0, String(code4));
}

console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ" : `\nПРОВАЛОВ: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
