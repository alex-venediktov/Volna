#!/usr/bin/env node
/**
 * PreToolUse на Bash(git commit|git push) - ЕДИНСТВЕННОЕ блокирующее место «Волны».
 *
 * Блокируем только то, что необратимо и проверяемо по журналу:
 *  - commit без записи журнала по текущему этапу (потом контекст не восстановить);
 *  - push вне этапа доставки deliver (по процессу пушить ещё нечего).
 * Всё остальное - предупреждение в systemMessage, без блокировки: гейт, который срабатывает
 * зря, обходят руками, и тогда он бесполезен.
 *
 * Нет активной задачи, нет .volna/, сопровождение заглушено - гейт молчит.
 */
import { dirname, resolve, relative } from "node:path";
import { readHookInput, loadActive, runQuietly } from "./lib/volna-state.mjs";

await runQuietly(async () => {
  const input = await readHookInput();
  if (input.tool_name !== "Bash") return;

  const command = String(input.tool_input?.command || "");
  const action = classify(command);
  if (!action) return;

  // muted не отключает гейт: глушится сопровождение, а не защита необратимого
  const active = loadActive(input.cwd, { respectMute: false });
  if (!active) return;

  // Задача живёт в рабочем каталоге «Волны». Git в стороннем репозитории (сам плагин, чужой
  // проект) к её этапам отношения не имеет, и блокировать его - ложное срабатывание.
  if (!insideWorkspace(commandDir(command, input.cwd), active.volnaDir)) return;

  const { fm, sections, task } = active;
  const stage = String(fm.stage || "").trim();
  const done = Array.isArray(fm.stages_done) ? fm.stages_done : [];

  if (action === "commit") {
    const hasStageEntry = stage && sections.includes(stage);
    if (!hasStageEntry) {
      return deny([
        `Волна: в журнале задачи ${task} нет записи по этапу «${stage || "?"}».`,
        `Допиши секцию «## ${stage || "<этап>"} · итерация N · <дата>» в ${relJournal(active)}:`,
        "что / зачем / как / сделано / осталось - и повтори коммит.",
        "Причина правила: после коммита контекст уходит, и восстановить «почему так» будет нечем.",
      ]);
    }
  }

  if (action === "push") {
    // Локальная задача (mode: local): доставки в трекер нет, а журнал и знание пушить законно.
    if (String(fm.mode || "").trim() === "local") return;
    // Коммит - первый шаг deliver, отдельного этапа commit нет; прежние имена «push-pr»
    // и «commit» терпим ради задач, начатых до объединения и переименования этапов.
    const delivery = ["deliver", "push-pr", "commit"];
    const started = delivery.includes(stage) ||
      delivery.some((s) => done.includes(s) || sections.includes(s));
    if (!started) {
      return deny([
        `Волна: этап deliver по задаче ${task} не начат - push не имеет смысла по процессу.`,
        "Коммит и push - шаги одного этапа доставки: вызови /volna:deliver, он спросит решение",
        "и проведёт коммит, задачу-фикс, push и PR по порядку.",
      ]);
    }
    // Для бага задача-фикс создаётся ДО push, иначе в PR попадёт номер бага.
    if (String(fm.type || "") === "bug" && isEmpty(fm.fix_task)) {
      return warn(
        `Волна: у бага ${task} не заполнен fix_task. Задача-фикс создаётся до push, ` +
        "иначе в PR уйдёт номер бага. Если фикс-задача не нужна - зафиксируй причину в журнале.",
      );
    }
  }
});

/**
 * Каталог, в котором реально выполнится git: последний `cd <путь>` перед ним, иначе каталог
 * сессии. Команда вида `cd <путь> && git ...` уводит git из рабочего каталога, и по одному
 * лишь cwd это не видно.
 */
function commandDir(command, cwd) {
  const base = String(cwd || process.cwd());
  let dir = base;
  const re = /(?:^|[;&|]|&&)\s*cd\s+(?:\/d\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/gi;
  for (const m of command.matchAll(re)) {
    const raw = m[1].replace(/^["']|["']$/g, "");
    if (!raw || raw === "-") continue;
    dir = resolve(base, toNativePath(raw));
  }
  return dir;
}

/** Путь из командной строки Git Bash в вид файловой системы: /c/каталог -> C:/каталог. */
function toNativePath(p) {
  const msys = /^\/([a-z])\/(.*)$/i.exec(p);
  return msys ? `${msys[1].toUpperCase()}:/${msys[2]}` : p;
}

/** Лежит ли каталог внутри рабочего каталога «Волны» (там, где найден .volna). */
function insideWorkspace(dir, volnaDir) {
  const root = norm(dirname(volnaDir));
  const target = norm(dir);
  return target === root || target.startsWith(`${root}/`);
}

/** Сравнение путей: разделители и регистр на Windows значения не имеют. */
function norm(p) {
  return resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Что именно делает команда: commit, push или ничего интересного. */
function classify(command) {
  const c = command.toLowerCase();
  if (!/\bgit\b/.test(c)) return null;
  if (/\bgit\s+(-[^\s]+\s+)*commit\b/.test(c)) return "commit";
  if (/\bgit\s+(-[^\s]+\s+)*push\b/.test(c)) return "push";
  return null;
}

function isEmpty(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  return String(v).trim() === "";
}

/**
 * Куда дописывать секцию этапа: найденный лог, а у журналов до разделения - файл состояния.
 * Признак старого формата: лога нет, а секции итераций лежат в самом файле состояния.
 */
function relJournal(active) {
  if (active.logPath) {
    return `.volna/${relative(active.volnaDir, active.logPath).replace(/\\/g, "/")}`;
  }
  const legacy = /^##\s+\S+\s+·\s+итерация\s+\d+/m.test(active.text);
  return legacy
    ? `.volna/journal/TASK-${active.task}.md`
    : `.volna/journal/logs/TASK-${active.task}.log.md`;
}

/** Отказ с объяснением: exit 0 + permissionDecision, чтобы причина дошла до модели и человека. */
function deny(lines) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: lines.join(" "),
    },
  }));
}

/** Предупреждение без блокировки. */
function warn(message) {
  process.stdout.write(JSON.stringify({ systemMessage: message }));
}
