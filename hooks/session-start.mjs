#!/usr/bin/env node
/**
 * SessionStart: если есть активная задача - напомнить, где остановились.
 * Нет задачи, нет .volna/, сопровождение заглушено - молчание (обычный чат не трогаем).
 * Единственное, о чём говорим вне задачи: неопознанные ключи state.json - из-за них задачи и
 * «нет», так что молчание здесь было бы последствием дефекта, а не его отсутствием.
 */
import { readHookInput, loadActive, findVolnaDir, runQuietly, emitContext, stagePosition, openItems, minutesSince, readSummary, summaryField, summaryLag, summaryIssues, stateKeyWarning, truncate, localStamp, STAGES }
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
      `${fm.branch ? ` · ветка ${fm.branch}` : ""}`,
    // Время машины для меток журнала: локальное, не UTC.
    `Сейчас: ${localStamp()}`,
  ];

  // Начало сессии - единственное место, где уместен следующий шаг из резюме целиком.
  const summary = readSummary(active.text);
  const next = summary && summaryField(summary.body, "следующий шаг");
  if (next) lines.push(`Следующий шаг: ${truncate(next, 200)}`);

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
  emitContext("SessionStart", lines);
});

function formatAge(mins) {
  if (mins < 120) return `${mins} мин`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} ч` : `${Math.round(hours / 24)} дн`;
}
