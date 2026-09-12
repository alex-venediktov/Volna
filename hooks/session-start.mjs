#!/usr/bin/env node
/**
 * SessionStart: если есть активная задача - напомнить, где остановились.
 * Нет задачи, нет .volna/, сопровождение заглушено - молчание (обычный чат не трогаем).
 * Единственное, о чём говорим вне задачи: неопознанные ключи state.json - из-за них задачи и
 * «нет», так что молчание здесь было бы последствием дефекта, а не его отсутствием.
 */
import { readHookInput, loadActive, findVolnaDir, runQuietly, emitContext, stagePosition, openItems, minutesSince, readSummary, summaryField, summaryLag, summaryIssues, stateKeyWarning, truncate, localStamp, partOf, openCheckpoint, STAGES }
  from "./lib/volna-state.mjs";

await runQuietly(async () => {
  const input = await readHookInput();
  const active = loadActive(input.cwd);
  if (!active) {
    // Задачи нет либо она не опознана - разные вещи, и вторая молчала бы так же, как первая
    const keyWarning = stateKeyWarning(findVolnaDir(input.cwd));
    if (keyWarning) emitContext("SessionStart", [`Волна: ${keyWarning}`]);
    return;
  }

  const { fm, task } = active;
  const stage = fm.stage || "?";
  const pos = stagePosition(stage);
  const lines = [
    `Волна: активна задача ${task}${fm.title ? ` «${fm.title}»` : ""}` +
      `${fm.type ? ` (${fm.type})` : ""}`,
    `Этап: ${stage}${pos ? ` · ${pos}/${STAGES.length}` : ""}` +
      // Часть говорит то, чего не говорит этап: у задачи есть незакрытый остаток.
      `${partOf(fm) ? ` · часть ${partOf(fm)}` : ""}` +
      `${fm.branch ? ` · ветка ${fm.branch}` : ""}`,
    // Время машины для меток журнала: локальное, не UTC.
    `Сейчас: ${localStamp()}`,
  ];

  // Начало сессии - единственное место, где уместен следующий шаг из резюме целиком.
  const summary = readSummary(active.text);
  const next = summary && summaryField(summary.body, "следующий шаг");
  if (next) lines.push(`Следующий шаг: ${truncate(next, 200)}`);

  // Фаза говорит то, чего не говорит этап: работа стоит, и следующий шаг из журнала неверен
  if (active.phase === "paused") {
    lines.push("Задача на паузе: прежде чем продолжать, спроси человека, снимаем ли паузу.");
  } else if (active.phase === "blocked") {
    lines.push(`Задача заблокирована${active.blocked ? `: ${truncate(active.blocked, 120)}` : ""}.` +
      " Снимать блокировку - решение человека, а не вывод из журнала.");
  }

  const lock = openCheckpoint(active.logText || active.text);
  if (lock) {
    lines.push(`Чек-пойнт начат ${lock} и не закрыт: ход оборвался посреди записи.` +
      " «Состояние» могло остаться от прошлого захода - восстанавливай по хвосту лога.");
  }

  const open = openItems(fm, 3);
  if (open.length) {
    lines.push(`Открыто (${open.length}):`);
    for (const item of open) lines.push(`  - ${item}`);
  }

  const mins = minutesSince(active.mtimeMs);
  if (mins !== null && mins > 60) {
    lines.push(`Журнал не обновлялся ${formatAge(mins)} - сверь, соответствует ли он реальности.`);
  }

  const lag = summaryLag(active.text, active.logText);
  if (lag === "missing") {
    lines.push("В журнале нет секции «## Состояние» - восстановление пойдёт по логу целиком, это дорого.");
  } else if (lag) {
    lines.push(`«Состояние» отстало от лога (последняя запись ${lag}) - сначала перепиши резюме.`);
  }

  const issues = summaryIssues(active.text);
  if (issues?.oversize) {
    lines.push(`«Состояние» разрослось до ${Math.round(issues.size / 1024)} КБ вместо экрана: ` +
      "историю унеси в лог, «где что лежит и как запускается» - в .volna/wiki/.");
  }
  if (issues?.missing.length) {
    lines.push(`В «Состоянии» нет подпунктов ${issues.missing.map((m) => `**${m}:**`).join(", ")} - ` +
      "назови их ровно так, иначе ни hooks, ни следующая сессия их не найдут.");
  }

  lines.push("Читай состояние задачи целиком; лог итераций (TASK-<id>.log.md) - только по ссылке из резюме.");
  lines.push("Продолжить с текущего этапа или закрыть задачу: /volna:status, /volna:close.");
  // Автопроход разоружён возобновлением: цепочка запрещает останов внутри хода, но не переносит
  // разрешение человека через границу сессии - он мог за это время передумать
  lines.push("Контекст восстановлен, а не продолжен: первый ход - человеку. Назови, где мы " +
    "остановились и что делаешь дальше, и дождись его слова, прежде чем идти по цепочке этапов.");
  emitContext("SessionStart", lines);
});

function formatAge(mins) {
  if (mins < 120) return `${mins} мин`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} ч` : `${Math.round(hours / 24)} дн`;
}
