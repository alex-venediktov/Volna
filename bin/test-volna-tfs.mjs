/**
 * Проверка CLI над трекером без сети: клиент подменяется заглушкой, которая записывает вызовы.
 * Главное, что проверяется: без --confirm запись НЕ происходит ни при каких аргументах.
 *
 * Запуск: node bin/test-volna-tfs.mjs
 */
import { run, parseArgs } from "./volna-tfs.mjs";
import { parseEnv } from "../lib/env.mjs";

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${!cond && detail ? ` -> ${detail}` : ""}`);
  if (!cond) failures++;
}

/** Заглушка клиента: помнит вызовы, ничего не отправляет. */
function fakeClient(workItem = {}) {
  const calls = [];
  return {
    calls,
    fieldOps(fields) {
      return Object.entries(fields).map(([ref, value]) => ({ op: "add", path: `/fields/${ref}`, value }));
    },
    async verifyAccess() { calls.push(["verifyAccess"]); return { ok: true, status: 200 }; },
    async getWorkItem(id, expand) { calls.push(["getWorkItem", id, expand]); return workItem; },
    async updateWorkItem(id, ops) { calls.push(["updateWorkItem", id, ops]); return { id }; },
    async addComment(id, html) { calls.push(["addComment", id, html]); return { id }; },
    async addAttachment(id, name, bytes, opts) {
      calls.push(["addAttachment", id, name, bytes.length, opts]);
      return { id, url: "http://tracker/att/1" };
    },
  };
}

const WI = {
  id: 21571,
  fields: {
    "System.Title": "Клапан не рисуется при зеркале",
    "System.WorkItemType": "Bug",
    "System.State": "Active",
    "System.AreaPath": "Проект\\Область",
    "System.Description": "<p>Ожидается маркер на <b>дальнем</b> конце дуги</p>",
    "Microsoft.VSTS.TCM.ReproSteps": "<ul><li>открыть заказ</li><li>включить зеркало</li></ul>",
    "System.History": "<p>обсуждение: смотри вложение</p>",
    "Microsoft.VSTS.Scheduling.CompletedWork": 2.5,
  },
  relations: [
    { rel: "System.LinkTypes.Hierarchy-Reverse", url: "http://tracker/_apis/wit/workItems/21440" },
    { rel: "AttachedFile", url: "http://tracker/att/9", attributes: { name: "факт.png" } },
  ],
};

const capture = () => {
  const out = [], errs = [];
  return { out, errs, log: (s) => out.push(s), err: (s) => errs.push(s), text: () => out.join("\n"),
    errText: () => errs.join("\n") };
};

// --- разбор аргументов --------------------------------------------------------
{
  const p = parseArgs(["comment", "21571", "готово", "--confirm", "--assign", "Иван Петров"]);
  check("parseArgs: команда и позиционные", p.command === "comment" && p.args[0] === "21571", JSON.stringify(p));
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

// --- запись без --confirm НЕ выполняется -------------------------------------
{
  const cases = [
    ["comment", "21571", "текст"],
    ["time", "21571", "1.5"],
    ["link-pr", "21571", "http://pr/1"],
    ["state", "21571", "Resolved"],
    ["attach", "21571", "shot.png"],
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
  const code = await run(["get", "21571"], { client, log: c.log, err: c.err });
  const t = c.text();
  check("get: код 0", code === 0, String(code));
  check("get: заголовок и тип", t.includes("# 21571") && t.includes("тип: Bug"), t);
  check("get: родитель назван", t.includes("родитель: 21440"), t);
  check("get: HTML описания превращён в текст", t.includes("Ожидается маркер") && !t.includes("<b>"), t);
  check("get: шаги воспроизведения списком", t.includes("- открыть заказ"), t);
  check("get: вложение и предупреждение про PAT", t.includes("факт.png") && t.includes("401"), t);
  check("get: часы показаны", t.includes("списано 2.5"), t);
  check("get: связи запрошены с expand", client.calls.some(([m, , e]) => m === "getWorkItem" && e === true),
    JSON.stringify(client.calls));
}

// --- comment: markdown уходит как HTML ---------------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  const code = await run(["comment", "21571", "- правка в модуле\n- тест добавлен", "--confirm"],
    { client, log: c.log, err: c.err });
  const [, , html] = client.calls.find(([m]) => m === "addComment") ?? [];
  check("comment: код 0", code === 0, String(code));
  check("comment: markdown превращён в HTML", /<ul><li>/.test(html || ""), String(html));
}

// --- time: прибавление и замена ----------------------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  await run(["time", "21571", "1.5", "--confirm"], { client, log: c.log, err: c.err });
  const ops = client.calls.find(([m]) => m === "updateWorkItem")?.[2] ?? [];
  check("time: прибавляет к текущим часам (2.5 + 1.5 = 4)",
    ops.some((o) => o.path.endsWith("CompletedWork") && o.value === 4), JSON.stringify(ops));

  const c2 = capture();
  const client2 = fakeClient(WI);
  await run(["time", "21571", "1.5", "--set", "--confirm"], { client: client2, log: c2.log, err: c2.err });
  const ops2 = client2.calls.find(([m]) => m === "updateWorkItem")?.[2] ?? [];
  check("time --set: заменяет значение", ops2.some((o) => o.value === 1.5), JSON.stringify(ops2));
  check("time --set: текущее значение не читалось",
    !client2.calls.some(([m]) => m === "getWorkItem"), JSON.stringify(client2.calls));
}

// --- link-pr и state ---------------------------------------------------------
{
  const c = capture();
  const client = fakeClient(WI);
  await run(["link-pr", "21571", "http://tracker/pr/2113", "--title", "PR 2113", "--confirm"],
    { client, log: c.log, err: c.err });
  const ops = client.calls.find(([m]) => m === "updateWorkItem")?.[2] ?? [];
  const rel = ops[0]?.value ?? {};
  check("link-pr: гиперссылка с подписью", rel.rel === "Hyperlink" && rel.attributes?.comment === "PR 2113",
    JSON.stringify(ops));

  const c2 = capture();
  const client2 = fakeClient(WI);
  await run(["state", "21571", "Resolved", "--assign", "Тестер", "--reason", "Fixed", "--confirm"],
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
  const code = await run(["attach", "21571", "D:/tmp/после.png", "--discussion", "--comment", "исправлено", "--confirm"],
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
