/**
 * Проверка замера расхода задачи без файловой системы: журнал и логи сессий живут в карте в памяти.
 * Главное, что проверяется: ход попадает в секцию, чья метка его закрывает, повтор сообщения
 * считается один раз, подагенты не смешиваются с ходами сессии, окно задачи не захватывает чужое.
 *
 * Запуск: node bin/test-volna-cost.mjs
 */
import { join, sep } from "node:path";
import { run, projectDirName, parseStamp, logSections, parseTurns, fmt } from "./volna-cost.mjs";

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${!cond && detail ? ` -> ${detail}` : ""}`);
  if (!cond) failures++;
}

const VOLNA = join("repo", ".volna");
const DIR = join("home", ".claude", "projects", projectDirName("repo"));
const ID = "261025-demo";

const STATE = `---
task: ${ID}
stage: plan
started: 2026-10-25T10:00
---

## Состояние · 2026-10-25 10:30
`;
const LOG = `# лог

## intake · итерация 1 · 2026-10-25 10:05
текст
## analyze · итерация 1 · 2026-10-25 10:20
## spec · итерация 1 · 2026-10-25 10:20
## plan · итерация 1 · 2026-10-25 10:30
`;

/** Строка jsonl хода модели; время - местное, как метки журнала. */
function turn(id, h, m, s, usage = {}, extra = {}) {
  return JSON.stringify({
    type: "assistant", timestamp: new Date(2026, 9, 25, h, m, s).toISOString(),
    message: { id, usage: { input_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 10, ...usage } },
    ...extra,
  });
}

function fs(files) {
  const map = new Map(Object.entries(files));
  return {
    readFile: (p) => map.get(p) ?? null,
    listDir: (p) => {
      const prefix = p + sep;
      const names = new Set();
      for (const k of map.keys()) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split(sep)[0]);
      return names.size ? [...names] : null;
    },
  };
}

function harness(sessions, { log = LOG, argv = [] } = {}) {
  const files = {
    [join(VOLNA, "journal", `TASK-${ID}.md`)]: STATE,
    [join(VOLNA, "journal", "logs", `TASK-${ID}.log.md`)]: log,
    ...sessions,
  };
  const out = [];
  const errs = [];
  const deps = { ...fs(files), volnaDir: VOLNA, home: "home", env: {}, now: new Date(2026, 9, 25, 12, 0),
    log: (s) => out.push(s), err: (s) => errs.push(s) };
  return { deps, out, errs, go: async (extra = []) => ({ code: await run([ID, "--json", ...argv, ...extra], deps), json: () => JSON.parse(out.join("\n")) }) };
}

const row = (j, label) => j.rows.find((r) => r.label === label);

// чистые функции
check("имя каталога логов: всё кроме букв и цифр -> '-'", projectDirName("D:\\projects\\AI\\Volna") === "D--projects-AI-Volna", projectDirName("D:\\projects\\AI\\Volna"));
check("метка журнала читается по местному времени, с пробелом и с T",
  parseStamp("2026-10-25 10:05") === new Date(2026, 9, 25, 10, 5).getTime() && parseStamp("2026-10-25T10:05") === parseStamp("2026-10-25 10:05"));
check("не метка - null", parseStamp("вчера") === null && parseStamp(undefined) === null);
{
  const s = logSections(LOG + "## Состояние · 2026-10-25 11:00\n");
  check("секции лога: этап и итерация, «Состояние» не секция", s.map((x) => x.label).join(",") === "intake·1,analyze·1,spec·1,plan·1", s.map((x) => x.label).join(","));
}
{
  const p = parseTurns([turn("a", 10, 1, 0), '{"type":"assistant","message":{"id":"b"}}', "не json", '{"type":"user"}'].join("\n"), { session: "s" });
  check("ход без usage пропущен и посчитан, не-json и чужие записи молча", p.turns.length === 1 && p.skipped === 1, JSON.stringify(p));
}
check("число коротко: 950, 18.9k, 2.18M", fmt(950) === "950" && fmt(18_900) === "18.9k" && fmt(2_180_000) === "2.18M");

// раскладка по секциям
{
  const h = harness({
    [join(DIR, "s1.jsonl")]: [
      turn("before", 9, 59, 0),          // до started - не считается
      turn("a", 10, 1, 0),
      turn("a", 10, 1, 0),               // повтор того же сообщения
      turn("a", 10, 1, 0),
      turn("b", 10, 5, 40),              // внутри минуты метки intake - ещё intake
      turn("c", 10, 6, 0, { cache_read_input_tokens: 5000 }),
      turn("d", 10, 31, 0),              // после последней метки - вне окна без --until
    ].join("\n"),
  });
  const { code, json } = await h.go();
  const j = json();
  check("ход внутри минуты метки относится к этой секции", row(j, "intake·1")?.turns === 2, JSON.stringify(row(j, "intake·1")));
  check("повтор одного message.id считается один раз", row(j, "intake·1")?.cacheRead === 2000, JSON.stringify(row(j, "intake·1")));
  check("ход после метки - в следующую секцию", row(j, "analyze·1 + spec·1")?.turns === 1, j.rows.map((r) => r.label).join("|"));
  check("секции одной метки - одна строка", j.rows.length === 3 && !row(j, "spec·1"), j.rows.map((r) => r.label).join("|"));
  check("контекст макс - самый большой ввод одного хода", row(j, "analyze·1 + spec·1")?.context === 5101 && j.total.context === 5101, JSON.stringify(j.total));
  check("ход до started и после последней метки не считается", code === 0 && j.total.turns === 3 && !row(j, "после записи"), JSON.stringify(j.total));
}
{
  const h = harness({ [join(DIR, "s1.jsonl")]: [turn("a", 10, 1, 0), turn("d", 10, 45, 0)].join("\n") }, { argv: ["--until", "now"] });
  const j = (await h.go()).json();
  check("--until now: ход после последней метки - строкой «после записи»", row(j, "после записи")?.turns === 1, j.rows.map((r) => r.label).join("|"));
}

{
  const h = harness({ [join(DIR, "s1.jsonl")]: turn("a", 10, 1, 0) });
  const lines = [];
  h.deps.log = (s) => lines.push(s);
  const code = await run(["--json", ID], h.deps);
  check("--json перед id: замер, а не справка", code === 0 && JSON.parse(lines.join("\n")).total.turns === 1, lines.join("\n"));
}

// подагенты и сессии
{
  const h = harness({
    [join(DIR, "s1.jsonl")]: turn("a", 10, 1, 0),
    [join(DIR, "s1", "subagents", "agent-x.jsonl")]: turn("sa", 10, 2, 0),
    [join(DIR, "s2.jsonl")]: turn("b", 10, 3, 0),
  });
  const j = (await h.go()).json();
  const r = row(j, "intake·1");
  check("ход подагента - в колонку подагентов, не в ходы сессии", r?.turns === 2 && r?.subTurns === 1 && r?.subTokens === 1111, JSON.stringify(r));
  check("все сессии окна названы вместе с подагентами", j.sessions.s1?.subTurns === 1 && j.sessions.s2?.turns === 1, JSON.stringify(j.sessions));
  const only = harness({ [join(DIR, "s1.jsonl")]: turn("a", 10, 1, 0), [join(DIR, "s2.jsonl")]: turn("b", 10, 3, 0) }, { argv: ["--session", "s2"] });
  const k = (await only.go()).json();
  check("--session оставляет одну сессию", Object.keys(k.sessions).join() === "s2" && k.total.turns === 1, JSON.stringify(k.sessions));
}

// отказы
{
  const h = harness({ [join(DIR, "s1.jsonl")]: turn("a", 10, 1, 0) });
  h.deps.readFile = (p) => (p.includes("TASK-") ? null : "");
  check("нет журнала - код 1", (await run([ID], h.deps)) === 1 && h.errs.join(" ").includes(ID), h.errs.join("; "));
  const n = harness({}, { log: "# лог без секций\n" });
  check("нет секций с меткой - код 1", (await run([ID], n.deps)) === 1, n.errs.join("; "));
  const d = harness({});
  check("нет каталога логов сессий - код 3 и путь в тексте", (await run([ID], d.deps)) === 3 && d.errs.join(" ").includes("projects"), d.errs.join("; "));
  const t = harness({ [join(DIR, "s1.jsonl")]: turn("a", 10, 1, 0) });
  const lines = [];
  t.deps.log = (s) => lines.push(s);
  check("текстовый вывод: таблица с итогом и список сессий", (await run([ID], t.deps)) === 0
    && lines.some((l) => l.startsWith("итого")) && lines.some((l) => l.includes("сессии в окне: 1")), lines.join("\n"));
}

console.log(failures ? `\nПРОВАЛЕНО: ${failures}` : "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ");
process.exit(failures ? 1 : 0);
