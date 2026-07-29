/**
 * Проверка CLI над трекером без сети: клиент подменяется заглушкой, которая записывает вызовы.
 * Главное, что проверяется: запись идёт без флага подтверждения, а --dry-run не отправляет
 * в трекер ничего.
 *
 * Запуск: node bin/test-volna-tfs.mjs
 */
import { run, parseArgs, parseFieldAssignments } from "./volna-tfs.mjs";
import { parseEnv } from "../lib/env.mjs";
import { TfsClient, normalizeRefName, parsePullRequestUrl, pullRequestArtifactUrl, pullRequestIds,
  errorHint, looksLikeHtml } from "../lib/tfs-client.mjs";

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
    async comments(id) {
      calls.push(["comments", id]);
      return [
        { by: "Иван Петров", date: "2026-07-01T10:00:00Z", html: "<p>первый</p>", text: "первый" },
        { by: "Пётр Иванов", date: "2026-07-02T10:00:00Z", html: "<p>второй</p>", text: "второй" },
      ];
    },
    async downloadAttachments(id) {
      calls.push(["downloadAttachments", id]);
      return [{ name: "снимок.png", data: Buffer.from("картинка") }];
    },
    async workItemTypeStates(type) {
      calls.push(["workItemTypeStates", type]);
      return [{ name: "New", category: "Proposed" }, { name: "Closed", category: "Completed" }];
    },
    async fieldAllowedValues(type, field) {
      calls.push(["fieldAllowedValues", type, field]);
      return ["Completed", "Deferred"];
    },
    async setDescription(id, html, opts) {
      calls.push(["setDescription", id, html, opts]);
      return { id, replaced: opts?.replace === true };
    },
    async setEstimate(id, values) {
      calls.push(["setEstimate", id, values]);
      return {
        id,
        "Microsoft.VSTS.Scheduling.OriginalEstimate": values.original,
        "Microsoft.VSTS.Scheduling.RemainingWork": values.remaining,
      };
    },
    async setTags(id, opts) {
      calls.push(["setTags", id, opts]);
      return { id, tags: ["прежний", ...(opts.add ?? [])] };
    },
    async createChildTask(parentId, fields, type) {
      calls.push(["createChildTask", parentId, fields, type]);
      // сервер отдаёт созданную задачу целиком: состояние он ставит сам, мы его не посылали
      return {
        id: "4242", url: "http://tracker/_apis/wit/workItems/4242",
        fields: { ...fields, "System.State": "New" },
      };
    },
    async createWorkItem(type, ops) {
      calls.push(["createWorkItem", type, ops]);
      return { id: 4343, url: "http://tracker/_apis/wit/workItems/4343" };
    },
    async currentUser() {
      calls.push(["currentUser"]);
      return { id: "u-1", displayName: "Иван Петров", uniqueName: "DOMAIN\\ipetrov" };
    },
    async typeFields(type, opts) {
      calls.push(["typeFields", type, opts]);
      const all = [
        { ref: "proj.control", name: "Контроль проекта", required: true, allowed: ["ОКР", "Поддержка"] },
        { ref: "System.Title", name: "Заголовок", required: true, allowed: [] },
        { ref: "Microsoft.VSTS.Common.Priority", name: "Приоритет", required: false, allowed: ["1", "2"] },
      ];
      return opts?.requiredOnly ? all.filter((f) => f.required) : all;
    },
    async linkWorkItem(id, targetId, rel) {
      calls.push(["linkWorkItem", id, targetId, rel]);
      return { id };
    },
    async listPullRequests(repo, opts) {
      calls.push(["listPullRequests", repo, opts]);
      return [{
        id: 88, title: "2001: суть", status: "active", mergeStatus: "succeeded",
        source: "refs/heads/feature/2001_суть", target: "refs/heads/DEV",
        repositoryId: "guid", repositoryName: repo, webUrl: "",
      }];
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
  const p = parseArgs(["comment", "2001", "готово", "--dry-run", "--assign", "Иван Петров"]);
  check("parseArgs: команда и позиционные", p.command === "comment" && p.args[0] === "2001", JSON.stringify(p));
  check("parseArgs: флаг со значением", p.flags.assign === "Иван Петров", JSON.stringify(p.flags));
  check("parseArgs: булев флаг", p.flags["dry-run"] === true, JSON.stringify(p.flags));
}

// прежний --confirm больше ничего не требует и не ломает старые команды
{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["comment", "2001", "текст", "--confirm"], { client, log: c.log, err: c.err });
  check("совместимость: старый --confirm принимается и игнорируется",
    code === 0 && client.calls.some(([m]) => m === "addComment"), `code=${code}`);
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

// --- запись идёт без флага подтверждения, --dry-run не пишет ------------------
const WRITE_CASES = [
  ["comment", "2001", "текст"],
  ["time", "2001", "1.5"],
  ["link-pr", "2001", "http://pr/1"],
  ["state", "2001", "Resolved"],
  ["attach", "2001", "shot.png"],
  ["pr", "create", "backend", "feature/2001_суть", "--title", "2001: суть", "--target", "main"],
];

{
  for (const argv of WRITE_CASES) {
    const c = capture();
    const client = fakeClient(WI);
    const code = await run(argv, { client, log: c.log, err: c.err, readFile: () => Buffer.from("x") });
    check(`«${argv[0]}» без флагов: код 0 и запись выполнена`,
      code === 0 && client.calls.length > 0, `code=${code} calls=${client.calls.length}`);
  }
}

{
  for (const argv of WRITE_CASES) {
    const c = capture();
    const client = fakeClient(WI);
    const code = await run([...argv, "--dry-run"], { client, log: c.log, err: c.err });
    check(`«${argv[0]}» с --dry-run: код 0 и ни одного вызова`,
      code === 0 && client.calls.length === 0, `code=${code} calls=${client.calls.length}`);
    check(`«${argv[0]}» с --dry-run: сказано, что собирался сделать`,
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
  check("get: обсуждение собрано из ревизий, а не из поля истории",
    t.includes("## Обсуждение (2)") && t.includes("первый") && t.includes("второй"), t);
  check("get: у комментария назван автор", t.includes("**Иван Петров**"), t);
}

// --- get: ревизии недоступны - остаётся то, что лежало в поле -----------------
{
  const c = capture();
  const client = fakeClient(WI);
  client.comments = async () => { throw new Error("нет прав на ревизии"); };
  const code = await run(["get", "2001"], { client, log: c.log, err: c.err });
  check("get: отказ ревизий не роняет чтение задачи", code === 0, String(code));
  check("get: при отказе ревизий показано поле истории",
    c.text().includes("обсуждение: смотри вложение"), c.text());
}

// --- states: справочник процесса ----------------------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["states", "Task"], { client, log: c.log, err: c.err });
  const t = c.text();
  check("states: код 0", code === 0, String(code));
  check("states: состояния показаны", t.includes("New (Proposed)") && t.includes("Closed (Completed)"), t);
  check("states: причины показаны", t.includes("Completed, Deferred"), t);
  check("states: сказано, что свободный текст отклоняется", t.includes("свободный текст"), t);
}

// --- attachments: скачивание вложений -----------------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  const written = [];
  const code = await run(["attachments", "2001", "--out", "каталог"],
    { client, log: c.log, err: c.err, writeFile: (p, data) => written.push([p, data.length]) });
  check("attachments: код 0", code === 0, String(code));
  check("attachments: файл записан", written.length === 1 && /снимок\.png$/.test(written[0][0]),
    JSON.stringify(written));
  check("attachments: размер назван", c.text().includes("байт"), c.text());
}

// --- describe: описание дополняется, а не затирается --------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["describe", "2001", "Ограничение реализации. Причина."],
    { client, log: c.log, err: c.err });
  const [, , html, opts] = client.calls.find(([m]) => m === "setDescription") ?? [];
  check("describe: код 0", code === 0, String(code));
  check("describe: по умолчанию дополняет", opts?.replace !== true, JSON.stringify(opts));
  check("describe: markdown превращён в HTML", String(html).startsWith("<p>"), String(html));
  check("describe: сказано, что описание дополнено", c.text().includes("дополнено"), c.text());
}

{
  const c = capture();
  const client = fakeClient(WI);
  await run(["describe", "2001", "Новый текст", "--replace"], { client, log: c.log, err: c.err });
  const [, , , opts] = client.calls.find(([m]) => m === "setDescription") ?? [];
  check("describe: с --replace заменяет целиком", opts?.replace === true, JSON.stringify(opts));
}

{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["describe", "2001", "текст", "--dry-run"], { client, log: c.log, err: c.err });
  check("describe: с --dry-run не пишет", code === 0 && !client.calls.length, String(code));
  check("describe: намерение объяснено", c.errText().includes("дополнить описание задачи 2001"), c.errText());
}

// --- create: задача с родителем и часами --------------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["create", "Task", "--title", "2100: суть правки", "--parent", "2000",
    "--estimate", "3", "--tags", "первый,второй тег"], { client, log: c.log, err: c.err });
  const [, parent, fields, type] = client.calls.find(([m]) => m === "createChildTask") ?? [];
  check("create: код 0", code === 0, String(code));
  check("create: тип и родитель", type === "Task" && parent === "2000", `${type} ${parent}`);
  check("create: оценка попала в обе колонки часов",
    fields?.["Microsoft.VSTS.Scheduling.OriginalEstimate"] === 3 &&
    fields?.["Microsoft.VSTS.Scheduling.RemainingWork"] === 3, JSON.stringify(fields));
  check("create: теги разделены точкой с запятой", fields?.["System.Tags"] === "первый; второй тег",
    JSON.stringify(fields?.["System.Tags"]));
  check("create: номер новой задачи назван", c.text().includes("4242"), c.text());
}

{
  const c = capture();
  const client = fakeClient(WI);
  await run(["create", "Task", "--title", "без часов"], { client, log: c.log, err: c.err });
  check("create: без родителя создаётся самостоятельная задача",
    client.calls.some(([m]) => m === "createWorkItem"), JSON.stringify(client.calls));
  check("create: про незаполненные часы предупредил", c.text().includes("Оценка не задана"), c.text());
}

{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["create", "Task", "--parent", "2000"], { client, log: c.log, err: c.err });
  check("create: без заголовка ничего не создаётся", code === 1 && !client.calls.length, String(code));
}

// --- create: обязательные поля процесса ---------------------------------------
{
  const fields = parseFieldAssignments("first.field=значение с = внутри; second.field=2\nthird=x");
  check("поля процесса: пары через ; и перевод строки",
    fields["first.field"] === "значение с = внутри" && fields.third === "x", JSON.stringify(fields));
  check("поля процесса: число отдаётся числом", fields["second.field"] === 2, JSON.stringify(fields));
  check("поля процесса: пустая строка ничего не даёт",
    Object.keys(parseFieldAssignments("")).length === 0 &&
    Object.keys(parseFieldAssignments(undefined)).length === 0, "");
}

{
  const c = capture();
  const client = fakeClient(WI);
  await run(["create", "Task", "--title", "суть", "--field", "some.field=из флага",
    "--field", "other.field=7"],
    { client, log: c.log, err: c.err, env: { TFS_CREATE_FIELDS: "some.field=из env; env.only=да" } });
  const [, , ops] = client.calls.find(([m]) => m === "createWorkItem") ?? [];
  const value = (ref) => ops?.find((o) => o.path === `/fields/${ref}`)?.value;
  check("create: поле процесса из .env попало в запрос", value("env.only") === "да", JSON.stringify(ops));
  check("create: флаг важнее переменной окружения", value("some.field") === "из флага", JSON.stringify(ops));
  check("create: числовое значение поля ушло числом", value("other.field") === 7, JSON.stringify(ops));
}

{
  const c = capture();
  const client = fakeClient(WI);
  await run(["create", "Task", "--title", "суть", "--field", "some.field=значение", "--dry-run"],
    { client, log: c.log, err: c.err });
  check("create: при --dry-run поля процесса названы в намерении",
    c.errText().includes("some.field=значение") && !client.calls.length, c.errText());
}

// --- create: исполнитель по умолчанию -----------------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  await run(["create", "Task", "--title", "суть", "--parent", "2000", "--estimate", "2"],
    { client, log: c.log, err: c.err });
  const [, , fields] = client.calls.find(([m]) => m === "createChildTask") ?? [];
  check("create: без --assign исполнителем ставится текущий пользователь",
    fields?.["System.AssignedTo"] === "Иван Петров", JSON.stringify(fields?.["System.AssignedTo"]));
  check("create: исполнитель напечатан в ответе", c.text().includes("исполнитель: Иван Петров"), c.text());
  check("create: состояние из ответа сервера напечатано", c.text().includes("состояние: New"), c.text());
}

{
  const c = capture();
  const client = fakeClient(WI);
  await run(["create", "Task", "--title", "суть", "--assign", "Пётр Иванов"],
    { client, log: c.log, err: c.err });
  const [, , ops] = client.calls.find(([m]) => m === "createWorkItem") ?? [];
  const assigned = ops?.find((o) => o.path === "/fields/System.AssignedTo")?.value;
  check("create: --assign важнее текущего пользователя", assigned === "Пётр Иванов", String(assigned));
  check("create: текущего пользователя при явном --assign не спрашиваем",
    !client.calls.some(([m]) => m === "currentUser"), JSON.stringify(client.calls));
}

{
  const c = capture();
  const client = fakeClient(WI);
  await run(["create", "Task", "--title", "суть", "--no-assign"], { client, log: c.log, err: c.err });
  const [, , ops] = client.calls.find(([m]) => m === "createWorkItem") ?? [];
  check("create: --no-assign оставляет поле исполнителя пустым",
    !ops?.some((o) => o.path === "/fields/System.AssignedTo"), JSON.stringify(ops));
  check("create: отсутствие исполнителя названо явно", c.text().includes("НЕ ЗАДАН"), c.text());
}

{
  const c = capture();
  const client = fakeClient(WI);
  client.currentUser = async () => { throw new Error("HTTP 404 connectionData"); };
  const code = await run(["create", "Task", "--title", "суть"], { client, log: c.log, err: c.err });
  check("create: недоступный connectionData не роняет создание",
    code === 0 && client.calls.some(([m]) => m === "createWorkItem"), String(code));
  check("create: про неопределённого пользователя сказано",
    c.errText().includes("без исполнителя"), c.errText());
}

{
  const c = capture();
  const client = fakeClient(WI);
  await run(["create", "Task", "--title", "суть", "--dry-run"], { client, log: c.log, err: c.err });
  check("create: при --dry-run исполнитель назван в намерении",
    c.errText().includes("исполнитель - текущий пользователь") && !client.calls.length, c.errText());
}

// --- create: поля процесса с соседней задачи (--like) --------------------------
{
  const c = capture();
  const neighbour = { id: 2000, fields: { "proj.control": "ОКР", "System.Title": "чужая суть" } };
  const client = fakeClient(neighbour);
  await run(["create", "Task", "--title", "своя суть", "--like", "2000"],
    { client, log: c.log, err: c.err });
  const [, , ops] = client.calls.find(([m]) => m === "createWorkItem") ?? [];
  const value = (ref) => ops?.find((o) => o.path === `/fields/${ref}`)?.value;
  check("--like: обязательное поле процесса снято с соседней задачи",
    value("proj.control") === "ОКР", JSON.stringify(ops));
  check("--like: заголовок соседней задачи не наследуется",
    value("System.Title") === "своя суть", String(value("System.Title")));
  check("--like: снятые поля напечатаны", c.text().includes("proj.control=ОКР"), c.text());
}

{
  const c = capture();
  const client = fakeClient(WI);
  await run(["create", "Task", "--title", "суть", "--like", "2000", "--field", "proj.control=Поддержка"],
    { client, log: c.log, err: c.err });
  const [, , ops] = client.calls.find(([m]) => m === "createWorkItem") ?? [];
  check("--like: флаг --field важнее снятого значения",
    ops?.find((o) => o.path === "/fields/proj.control")?.value === "Поддержка", JSON.stringify(ops));
}

// --- create: отказ на обязательном поле процесса ------------------------------
{
  const c = capture();
  const client = fakeClient({ id: 2000, fields: { "proj.control": "ОКР" } });
  client.createChildTask = async () => {
    throw new Error('TFS POST -> HTTP 400: {"customProperties":' +
      '{"fieldReferenceName":"proj.control"},"message":"TF401320: Rule Error"}');
  };
  client.fieldAllowedValues = async () => ["ОКР", "Поддержка"];
  const code = await run(["create", "Task", "--title", "суть", "--parent", "2000"],
    { client, log: c.log, err: c.err });
  check("TF401320: код 1 и сказано, что задача не создана",
    code === 1 && c.errText().includes("НЕ создана"), `${code} ${c.errText()}`);
  check("TF401320: названо поле процесса", c.errText().includes("proj.control"), c.errText());
  check("TF401320: перечислены допустимые значения процесса",
    c.errText().includes("ОКР, Поддержка"), c.errText());
  check("TF401320: показано значение у родителя", c.errText().includes("У родителя 2000"), c.errText());
  check("TF401320: предложены --field и --like", c.errText().includes("--field proj.control=") &&
    c.errText().includes("--like 2000"), c.errText());
  check("TF401320: постоянное значение предложено записать знанием",
    c.errText().includes("knowledge/tfs/"), c.errText());
}

{
  const c = capture();
  const client = fakeClient(WI);
  client.createWorkItem = async () => { throw new Error("HTTP 500: сервер лежит"); };
  const code = await run(["create", "Task", "--title", "суть"], { client, log: c.log, err: c.err });
  check("create: посторонняя ошибка не выдаётся за правило процесса",
    code === 2 && c.errText().includes("сервер лежит"), `${code} ${c.errText()}`);
}

// --- whoami и fields ----------------------------------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["whoami"], { client, log: c.log, err: c.err });
  check("whoami: код 0 и имя пользователя", code === 0 && c.text().includes("Иван Петров"), c.text());
  check("whoami: учётная запись показана", c.text().includes("DOMAIN\\ipetrov"), c.text());
  check("whoami: сказано, что уйдёт в исполнителя", c.text().includes("исполнителя новой задачи"), c.text());
}

{
  const c = capture();
  const client = fakeClient(WI);
  client.currentUser = async () => ({ id: "", displayName: "", uniqueName: "" });
  const code = await run(["whoami"], { client, log: c.log, err: c.err });
  check("whoami: пустой ответ - код 1 и предупреждение",
    code === 1 && c.errText().includes("без исполнителя"), `${code} ${c.errText()}`);
}

{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["fields", "Task"], { client, log: c.log, err: c.err });
  const t = c.text();
  check("fields: код 0", code === 0, String(code));
  check("fields: обязательное поле и его значения показаны",
    t.includes("proj.control") && t.includes("ОКР, Поддержка"), t);
  check("fields: необязательное поле по умолчанию не показано",
    !t.includes("Priority"), t);
  check("fields: назван способ задать значение", t.includes("--field") && t.includes("--like"), t);
  check("fields: постоянное значение области - в знания, не в окружение",
    t.includes("knowledge/tfs/"), t);
}

{
  const c = capture();
  const client = fakeClient(WI);
  await run(["fields", "Task", "--all"], { client, log: c.log, err: c.err });
  check("fields: с --all показаны и необязательные поля", c.text().includes("Priority"), c.text());
}

{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["fields"], { client, log: c.log, err: c.err });
  check("fields: без типа задачи - код 1 и подсказка",
    code === 1 && !client.calls.length, String(code));
}

// --- многострочные поля принимают Markdown, не HTML ---------------------------
{
  check("HTML на входе: блочные теги распознаны", looksLikeHtml("<p>абзац</p>"), "");
  check("HTML на входе: список распознан", looksLikeHtml("текст<br/>ещё"), "");
  check("HTML на входе: markdown ложно не срабатывает",
    !looksLikeHtml("- пункт\n**жирный** и `код`, 5 < 7 и a -> b"), "");
}

{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["describe", "2001", "<p>Ограничение реализации</p>"],
    { client, log: c.log, err: c.err });
  const [, , html] = client.calls.find(([m]) => m === "setDescription") ?? [];
  check("describe: про HTML на входе предупреждено",
    c.errText().includes("принимает Markdown"), c.errText());
  check("describe: предупреждение не отменяет записи", code === 0 && String(html).length > 0, String(code));
  check("describe: поданные теги ушли экранированными",
    String(html).includes("&lt;p&gt;"), String(html));
}

{
  const c = capture();
  const client = fakeClient(WI);
  await run(["create", "Task", "--title", "суть", "--body", "<ul><li>пункт</li></ul>"],
    { client, log: c.log, err: c.err });
  check("create: про HTML в описании предупреждено",
    c.errText().includes("принимает Markdown"), c.errText());
}

// --- поля: скаляр и подсказки к ошибкам сервера -------------------------------
{
  const client = new TfsClient({ baseUrl: "http://tracker", pat: "x", fetchFn: async () => ({}) });
  let message = "";
  try {
    client.fieldOps({ "System.Description": { value: "текст" } });
  } catch (e) {
    message = e.message;
  }
  check("fieldOps: объект вместо строки отвергается с именем поля",
    message.includes("System.Description"), message);
  check("fieldOps: скаляры проходят",
    client.fieldOps({ a: "текст", b: 2, c: true }).length === 3, "");
}

{
  const required = errorHint('{"customProperties":{"fieldReferenceName":"some.field"},"message":"TF401320: Rule Error"}');
  check("подсказка: обязательное поле процесса названо",
    required.includes("some.field") && required.includes("--field"), required);
  const cast = errorHint('{"message":"Unable to cast object of type \'Dictionary`2\' to type \'System.String\'."}');
  check("подсказка: значение поля ушло объектом", cast.includes("строк"), cast);
  check("подсказка: обычная ошибка без подсказки", errorHint('{"message":"HTTP 500"}') === "", errorHint("x"));
}

// --- estimate, link, tag ------------------------------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["estimate", "2001", "--original", "6", "--remaining", "0"],
    { client, log: c.log, err: c.err });
  const [, , values] = client.calls.find(([m]) => m === "setEstimate") ?? [];
  check("estimate: код 0", code === 0, String(code));
  check("estimate: оценка и остаток переданы числами",
    values?.original === 6 && values?.remaining === 0, JSON.stringify(values));
  check("estimate: нулевой остаток не потерян", c.text().includes("остаток 0"), c.text());
}

{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["estimate", "2001"], { client, log: c.log, err: c.err });
  check("estimate: без значений ничего не пишет", code === 1 && !client.calls.length, String(code));
}

{
  const c = capture();
  const client = fakeClient(WI);
  await run(["link", "2001", "2002", "--rel", "duplicate"], { client, log: c.log, err: c.err });
  const [, id, target, rel] = client.calls.find(([m]) => m === "linkWorkItem") ?? [];
  check("link: вид связи переведён в имя типа трекера",
    id === "2001" && target === "2002" && rel === "System.LinkTypes.Duplicate-Forward", `${rel}`);
}

{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["link", "2001", "2002", "--rel", "неизвестно"],
    { client, log: c.log, err: c.err });
  check("link: неизвестный вид связи отклонён", code === 1 && !client.calls.length, String(code));
}

{
  const c = capture();
  const client = fakeClient(WI);
  await run(["tag", "2001", "--add", "первый,второй тег"], { client, log: c.log, err: c.err });
  const [, , opts] = client.calls.find(([m]) => m === "setTags") ?? [];
  check("tag: список разобран по запятой",
    opts?.add?.length === 2 && opts.add[1] === "второй тег", JSON.stringify(opts));
  check("tag: итоговые теги показаны", c.text().includes("прежний; первый"), c.text());
}

// --- pr list ------------------------------------------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["pr", "list", "frontend", "--source", "feature/2001_суть"],
    { client, log: c.log, err: c.err });
  const [, repo, opts] = client.calls.find(([m]) => m === "listPullRequests") ?? [];
  check("pr list: чтение работает и без флагов", code === 0, String(code));
  check("pr list: ветка и статус переданы",
    repo === "frontend" && opts?.source === "feature/2001_суть" && opts?.status === "active",
    JSON.stringify(opts));
  check("pr list: номер и ветки показаны", c.text().includes("- 88 · active"), c.text());
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
  const code = await run(["comment", "2001", "- правка в модуле\n- тест добавлен"],
    { client, log: c.log, err: c.err });
  const [, , html] = client.calls.find(([m]) => m === "addComment") ?? [];
  check("comment: код 0", code === 0, String(code));
  check("comment: markdown превращён в HTML", /<ul><li>/.test(html || ""), String(html));
}

// --- time: прибавление и замена ----------------------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  await run(["time", "2001", "1.5"], { client, log: c.log, err: c.err });
  const ops = client.calls.find(([m]) => m === "updateWorkItem")?.[2] ?? [];
  check("time: прибавляет к текущим часам (2.5 + 1.5 = 4)",
    ops.some((o) => o.path.endsWith("CompletedWork") && o.value === 4), JSON.stringify(ops));

  const c2 = capture();
  const client2 = fakeClient(WI);
  await run(["time", "2001", "1.5", "--set"], { client: client2, log: c2.log, err: c2.err });
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
    "--target", "main", "--work-item", "2001"], { client, log: c.log, err: c.err });
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
    "--body-file", "D:/tmp/описание.md"],
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
  const code = await run(["pr", "create", "backend", "feature/2001_суть", "--title", "2001: суть"],
    { client, log: c.log, err: c.err, env: {} });
  check("pr create: без целевой ветки ничего не создаётся",
    code === 1 && client.calls.length === 0 && /TFS_TARGET_BRANCH/.test(c.errText()), c.errText());

  const c2 = capture();
  const client2 = fakeClient(WI);
  const code2 = await run(["pr", "create", "backend", "feature/2001_суть", "--target", "main"],
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
  check("pr status: чтение работает и без флагов", code === 0 && t.includes("# PR 77"), t);
  check("pr status: слияние и ветки показаны",
    t.includes("слияние: succeeded") && t.includes("refs/heads/main"), t);
  check("pr status: при нескольких коммитах предупредил про чужие изменения",
    t.includes("Коммиты (2)") && /не тащит ли ветка чужие/.test(t), t);
}

// --- link-pr и state ---------------------------------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  await run(["link-pr", "2001", "backend", "77"], { client, log: c.log, err: c.err });
  const link = client.calls.find(([m]) => m === "linkPullRequestArtifact");
  check("link-pr: форма «репозиторий номер» даёт нативную связь",
    link?.[1] === "2001" && link?.[2] === "backend" && link?.[3] === "77", JSON.stringify(client.calls));

  const cWeb = capture();
  const clientWeb = fakeClient(WI);
  await run(["link-pr", "2001", "http://tracker/Проект/_git/frontend/pullrequest/103"],
    { client: clientWeb, log: cWeb.log, err: cWeb.err });
  const linkWeb = clientWeb.calls.find(([m]) => m === "linkPullRequestArtifact");
  check("link-pr: репозиторий и номер разобраны из веб-ссылки",
    linkWeb?.[2] === "frontend" && linkWeb?.[3] === 103, JSON.stringify(clientWeb.calls));

  const cOld = capture();
  const clientOld = fakeClient(WI);
  await run(["link-pr", "2001", "http://tracker/pr/11", "--title", "PR 11"],
    { client: clientOld, log: cOld.log, err: cOld.err });
  const ops = clientOld.calls.find(([m]) => m === "updateWorkItem")?.[2] ?? [];
  const rel = ops[0]?.value ?? {};
  check("link-pr: неопознанный URL остаётся гиперссылкой с подписью",
    rel.rel === "Hyperlink" && rel.attributes?.comment === "PR 11", JSON.stringify(ops));
  check("link-pr: про отсутствие нативной связи сказано",
    /не нативная связь/.test(cOld.text()), cOld.text());

  const c2 = capture();
  const client2 = fakeClient(WI);
  await run(["state", "2001", "Resolved", "--assign", "Тестер", "--reason", "Fixed"],
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
  const code = await run(["attach", "2001", "D:/tmp/после.png", "--discussion", "--comment", "исправлено"],
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
  check("без аргументов: показал использование", code3 === 1 && /--dry-run печатает намерение/.test(c3.text()), c3.text());

  const c4 = capture();
  const client4 = fakeClient(WI);
  const code4 = await run(["get"], { client: client4, log: c4.log, err: c4.err });
  check("get без id: код 1, запросов нет", code4 === 1 && client4.calls.length === 0, String(code4));
}

console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ" : `\nПРОВАЛОВ: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
