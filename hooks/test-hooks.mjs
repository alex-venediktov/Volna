/**
 * Прогон hooks «Волны» на синтетическом .volna: проверяем шапку, гейт и тихое поведение
 * при отсутствии состояния. Запуск: node test-hooks.mjs <корень Волны>
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const volnaRoot = process.argv[2] || process.cwd();
const sandbox = join(tmpdir(), "claude", "volna-hooks-test");
const volnaDir = join(sandbox, ".volna");

if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
mkdirSync(join(volnaDir, "journal"), { recursive: true });

const journal = (stage, extra = {}) => `---
task: 21571
title: "Клапан не рисуется при зеркале"
type: ${extra.type ?? "bug"}
tracker: "http://tracker/_workitems/edit/21571"
fix_task: ${extra.fix_task ?? ""}
branch: bugfix/21571-klapan-mirror
repos: [front]
stage: ${stage}
stages_done: [${(extra.done ?? ["intake", "analyze"]).join(", ")}]
skipped: []
open:
  - "радиус дуги: значение в эталоне не найдено, спросить"
  - "нужен снимок заказа для теста"
started: 2026-07-25T10:12
updated: 2026-07-25T12:30
---

# 21571 — Клапан не рисуется при зеркале
${extra.summary === null ? "" : `
## Состояние · ${extra.summary ?? "2026-07-25 12:30"}

**цель:** клапан должен рисоваться на зеркальном изделии.
**сделано:** воспроизведено на позиции 3 заказа 100500;
тест на зеркале падает как ожидалось.
**следующий шаг:**
1. снять радиус дуги с эталона и повторить расчёт;
2. прогнать тесты по матрице зеркал.
**осторожно:** правка задевает общий вид.
`}
## intake · итерация 1 · 2026-07-25 10:12
**что:** принята задача 21571 (bug), создана ветка.
**сделано:** журнал создан, ветка создана.
**осталось:** анализ постановки.
${extra.sections ?? ""}`;

const write = (stage, extra) => {
  writeFileSync(join(volnaDir, "journal", "TASK-21571.md"), journal(stage, extra), "utf8");
  writeFileSync(join(volnaDir, "state.json"),
    JSON.stringify({ active: "21571", updated: "2026-07-25T12:30", muted: extra?.muted === true }), "utf8");
};

function run(hook, payload) {
  const res = spawnSync(process.execPath, [join(volnaRoot, "hooks", hook)], {
    input: JSON.stringify(payload), encoding: "utf8", timeout: 10000,
  });
  return { code: res.status, out: (res.stdout || "").trim(), err: (res.stderr || "").trim() };
}

let failures = 0;
function check(name, cond, detail = "") {
  const mark = cond ? "OK  " : "FAIL";
  if (!cond) failures++;
  console.log(`${mark} ${name}${detail && !cond ? ` -> ${detail}` : ""}`);
}

const ctx = (r) => {
  try { return JSON.parse(r.out)?.hookSpecificOutput?.additionalContext ?? ""; } catch { return ""; }
};

/**
 * Ожидаемое начало метки времени: «YYYY-MM-DD HH:» по локальным часам.
 * Минуты не сверяем - между запуском hook'а и проверкой они могут перевалить.
 */
function localHourStamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:`;
}
const decision = (r) => {
  try { return JSON.parse(r.out)?.hookSpecificOutput ?? {}; } catch { return {}; }
};

// --- 1. Нет .volna: все hooks молчат и выходят 0 --------------------------------
{
  const empty = join(sandbox, "no-volna");
  mkdirSync(empty, { recursive: true });
  for (const hook of ["session-start.mjs", "preamble.mjs", "gate.mjs"]) {
    const r = run(hook, { cwd: empty, hook_event_name: "X", tool_name: "Bash",
      tool_input: { command: "git commit -m x" } });
    check(`без .volna ${hook}: код 0 и пустой вывод`, r.code === 0 && r.out === "",
      `code=${r.code} out=${r.out}`);
  }
}

// --- 2. SessionStart с активной задачей ----------------------------------------
write("implement");
{
  const r = run("session-start.mjs", { cwd: sandbox, hook_event_name: "SessionStart", source: "startup" });
  const c = ctx(r);
  check("SessionStart: назвал задачу и этап", c.includes("21571") && c.includes("implement"), c);
  check("SessionStart: показал открытые пункты", c.includes("радиус дуги"), c);
  // Значение подпункта со следующей строки (нумерованный список) должно читаться целиком.
  check("SessionStart: следующий шаг из «Состояния»", c.includes("снять радиус дуги с эталона"), c);
  check("SessionStart: многострочный подпункт склеен, а не обрезан",
    c.includes("прогнать тесты по матрице зеркал"), c);
  check("SessionStart: резюме свежее - без предупреждения", !c.includes("отстало"), c);
  check("SessionStart: время машины отдано модели", c.includes(`Сейчас: ${localHourStamp()}`), c);
}

// --- 2a. Секция «Состояние»: отсутствует и отстала от лога ---------------------
{
  const later = "\n## implement · итерация 2 · 2026-07-25 18:40\n**что:** правка\n**сделано:** собрано\n";

  write("implement", { summary: null, sections: later });
  const miss = ctx(run("session-start.mjs", { cwd: sandbox, hook_event_name: "SessionStart" }));
  check("нет «Состояния»: сказано прямо", miss.includes("нет секции"), miss);
  const missHead = ctx(run("preamble.mjs", { cwd: sandbox, hook_event_name: "UserPromptSubmit", prompt: "дальше" }));
  check("нет «Состояния»: шапка предупреждает", missHead.includes("Состояние"), missHead);

  write("implement", { sections: later });                 // резюме 12:30 против записи 18:40
  const lag = ctx(run("preamble.mjs", { cwd: sandbox, hook_event_name: "UserPromptSubmit", prompt: "дальше" }));
  check("резюме отстало от лога: шапка предупреждает", lag.includes("отстало") && lag.includes("18:40"), lag);

  write("implement", { summary: "2026-07-25 19:00", sections: later });
  const fresh = ctx(run("preamble.mjs", { cwd: sandbox, hook_event_name: "UserPromptSubmit", prompt: "дальше" }));
  check("резюме свежее лога: шапка молчит про отставание", !fresh.includes("отстало"), fresh);

  // Журнал старого формата: заголовок «## Состояние задачи на <дата>» - не резюме.
  write("implement", { summary: null,
    sections: `${later}\n## Состояние задачи на 2026-07-25 12:00\n**сделано:** старое резюме\n` });
  const legacy = ctx(run("preamble.mjs", { cwd: sandbox, hook_event_name: "UserPromptSubmit", prompt: "дальше" }));
  check("старый заголовок резюме не считается «Состоянием»", legacy.includes("нет секции"), legacy);

  // Метка не читается как дата - свежесть недоказуема, просим перезаписать.
  write("implement", { summary: "без даты", sections: later });
  const nostamp = ctx(run("preamble.mjs", { cwd: sandbox, hook_event_name: "UserPromptSubmit", prompt: "дальше" }));
  check("«Состояние» без даты: шапка требует перезаписи", nostamp.includes("отстало"), nostamp);

  write("implement");
}

// --- 3. Шапка UserPromptSubmit: бюджет и содержимое ----------------------------
{
  const r = run("preamble.mjs", { cwd: sandbox, hook_event_name: "UserPromptSubmit",
    prompt: "продолжаем правку" });
  const c = ctx(r);
  const lines = c.split("\n").length;
  check("шапка: задача, этап, позиция", c.includes("21571") && c.includes("implement") && c.includes("5/13"), c);
  check(`шапка: бюджет <=20 строк (сейчас ${lines})`, lines <= 20, c);
  check("шапка: не больше 3 открытых пунктов", (c.match(/открыто:/g) || []).length <= 3, c);
  // Метки журнала ставит модель по этой строке: UTC вместо локального времени уехал бы на зону.
  check("шапка: метка времени локальная, не UTC", c.includes(`сейчас ${localHourStamp()}`), c);
}

// --- 4. Точный подъём журнала по номеру из промпта -----------------------------
{
  const r = run("preamble.mjs", { cwd: sandbox, hook_event_name: "UserPromptSubmit",
    prompt: "а что было по 21571 в прошлый раз?" });
  const c = ctx(r);
  check("номер == активная задача: без дубля ссылки", !c.includes("есть журнал"), c);

  const r2 = run("preamble.mjs", { cwd: sandbox, hook_event_name: "UserPromptSubmit",
    prompt: "посмотри заодно 99999" });
  const c2 = ctx(r2);
  check("чужой номер без журнала: ссылку не выдумал", !c2.includes("99999"), c2);

  // Резюме чужого журнала берётся из «Состояния», а не из хвоста лога.
  writeFileSync(join(volnaDir, "journal", "TASK-99123.md"), `---
task: 99123
title: "Прошлая задача"
type: task
stage: close
stages_done: [intake, analyze]
---

## Состояние · 2026-07-20 10:00

**сделано:** порт закрыт, тесты зелёные.

## implement · итерация 4 · 2026-07-19 09:00
**сделано:** отменённая гипотеза про масштаб.
`, "utf8");
  const r3 = run("preamble.mjs", { cwd: sandbox, hook_event_name: "UserPromptSubmit",
    prompt: "что было по 99123?" });
  const c3 = ctx(r3);
  check("чужой журнал: резюме из «Состояния», не из хвоста лога",
    c3.includes("порт закрыт") && !c3.includes("отменённая гипотеза"), c3);
}

// --- 5. muted глушит шапку, но не гейт -----------------------------------------
{
  write("implement", { muted: true });
  const r = run("preamble.mjs", { cwd: sandbox, hook_event_name: "UserPromptSubmit", prompt: "правим" });
  check("muted: шапки нет", r.out === "", r.out);

  const g = run("gate.mjs", { cwd: sandbox, hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command: "git commit -m \"21571 правка\"" } });
  check("muted: гейт всё равно работает", decision(g).permissionDecision === "deny", g.out);
  write("implement");
}

// --- 6. Гейт commit: нет записи по этапу -> deny, есть -> пропуск --------------
{
  const g = run("gate.mjs", { cwd: sandbox, hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command: "git commit -m \"21571 правка\"" } });
  const d = decision(g);
  check("commit без записи этапа: deny", d.permissionDecision === "deny", g.out);
  check("commit deny: сказано, что дописать", /implement/.test(d.permissionDecisionReason || ""), g.out);

  write("implement", { sections: "\n## implement · итерация 1 · 2026-07-25 13:00\n**что:** правка\n**сделано:** собрано\n" });
  const g2 = run("gate.mjs", { cwd: sandbox, hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command: "git commit -m \"21571 правка\"" } });
  check("commit с записью этапа: пропуск", g2.out === "" && g2.code === 0, g2.out);
}

// --- 7. Гейт push: этап доставки не начат -> deny; начат + bug без fix_task -> warn
{
  const p = run("gate.mjs", { cwd: sandbox, hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command: "git push -u origin HEAD" } });
  check("push вне этапа deliver: deny", decision(p).permissionDecision === "deny", p.out);
  check("push deny: назван этап доставки",
    /deliver/.test(decision(p).permissionDecisionReason || ""), p.out);

  // Коммит - шаг deliver: на самом этапе push проходит по одному «да», второй записи не нужно.
  write("deliver", { done: ["intake", "analyze", "implement"],
    sections: "\n## deliver · итерация 1 · 2026-07-25 14:00\n**что:** коммит\n**сделано:** зафиксировано\n" });
  const p2 = run("gate.mjs", { cwd: sandbox, hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command: "git push" } });
  let sys = "";
  try { sys = JSON.parse(p2.out)?.systemMessage ?? ""; } catch { /* пусто */ }
  check("push для бага без fix_task: предупреждение, не блок", sys.includes("fix_task"), p2.out);

  write("deliver", { fix_task: "21572", done: ["intake", "analyze", "implement"],
    sections: "\n## deliver · итерация 1 · 2026-07-25 14:00\n**что:** коммит\n**сделано:** зафиксировано\n" });
  const p3 = run("gate.mjs", { cwd: sandbox, hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command: "git push" } });
  check("push с fix_task: пропуск", p3.out === "", p3.out);

  // Журнал задачи, начатой до объединения и переименования этапов: прежние имена этапа
  // доставки («commit», «push-pr») тоже открывают push.
  write("push-pr", { fix_task: "21572", done: ["intake", "analyze", "implement"],
    sections: "\n## push-pr · итерация 1 · 2026-07-25 14:00\n**что:** коммит\n**сделано:** зафиксировано\n" });
  const pOld = run("gate.mjs", { cwd: sandbox, hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command: "git push" } });
  check("push при старом этапе push-pr в журнале: пропуск", pOld.out === "", pOld.out);

  write("implement", { fix_task: "21572", done: ["intake", "analyze", "implement", "commit"],
    sections: "\n## commit · итерация 1 · 2026-07-25 14:00\n**что:** коммит\n**сделано:** зафиксировано\n" });
  const p4 = run("gate.mjs", { cwd: sandbox, hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command: "git push" } });
  check("push при старом этапе commit в журнале: пропуск", p4.out === "", p4.out);
}

// --- 7a. Гейт молчит, когда git идёт в стороннем репозитории -------------------
{
  write("implement", { done: ["intake", "analyze"] });

  // Сторонний каталог берётся рядом с песочницей: абсолютные пути машины в тест не зашиваем.
  const foreign = resolve(sandbox, "..", "сторонний-репозиторий").replace(/\\/g, "/");
  const foreignMsys = foreign.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);

  const outside = run("gate.mjs", { cwd: sandbox, hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command: `cd ${foreign} && git push origin main` } });
  check("push в стороннем репозитории: гейт молчит", outside.out === "", outside.out);

  const outsideMsys = run("gate.mjs", { cwd: sandbox, hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command: `cd ${foreignMsys} && git commit -m "правка"` } });
  check("commit в стороннем репозитории (путь Git Bash): гейт молчит", outsideMsys.out === "", outsideMsys.out);

  const inside = run("gate.mjs", { cwd: sandbox, hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command: `cd ${sandbox.replace(/\\/g, "/")} && git push` } });
  check("push в рабочем каталоге: гейт работает", decision(inside).permissionDecision === "deny", inside.out);

  const nested = run("gate.mjs", { cwd: sandbox, hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command: "cd подпроект && git push" } });
  check("push в репозитории внутри рабочего каталога: гейт работает",
    decision(nested).permissionDecision === "deny", nested.out);
}

// --- 8. Гейт не трогает посторонние команды -----------------------------------
{
  for (const cmd of ["git status", "npm run build", "git log --oneline", "echo commit"]) {
    const r = run("gate.mjs", { cwd: sandbox, hook_event_name: "PreToolUse", tool_name: "Bash",
      tool_input: { command: cmd } });
    check(`гейт молчит на «${cmd}»`, r.out === "", r.out);
  }
  const r = run("gate.mjs", { cwd: sandbox, hook_event_name: "PreToolUse", tool_name: "Write",
    tool_input: { file_path: "x.md" } });
  check("гейт молчит на не-Bash инструменте", r.out === "", r.out);
}

// --- 9. Битый state.json и битый frontmatter не ломают hooks -------------------
{
  writeFileSync(join(volnaDir, "state.json"), "{ это не json", "utf8");
  const r = run("preamble.mjs", { cwd: sandbox, hook_event_name: "UserPromptSubmit", prompt: "тест" });
  check("битый state.json: тихий выход", r.code === 0 && r.out === "", `code=${r.code} out=${r.out}`);

  write("implement");
  writeFileSync(join(volnaDir, "journal", "TASK-21571.md"), "нет frontmatter вообще", "utf8");
  const r2 = run("session-start.mjs", { cwd: sandbox, hook_event_name: "SessionStart" });
  check("журнал без frontmatter: код 0", r2.code === 0, `code=${r2.code}`);
}

console.log(failures === 0 ? "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ" : `\nПРОВАЛОВ: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
