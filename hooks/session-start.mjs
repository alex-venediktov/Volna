#!/usr/bin/env node
/**
 * SessionStart: если есть активная задача - напомнить, где остановились.
 * Нет задачи, нет .volna/, сопровождение заглушено - молчание (обычный чат не трогаем).
 * Единственное, о чём говорим вне задачи: неопознанные ключи state.json - из-за них задачи и
 * «нет», так что молчание здесь было бы последствием дефекта, а не его отсутствием.
 */
import { readHookInput, loadActive, findVolnaDir, runQuietly, emitContext, stagePosition, openItems, minutesSince, readSummary, summaryField, summaryLag, summaryIssues, stateKeyWarning, truncate, localStamp, partOf, partsProgress, taskStatus, statusLabel, ancestry, childIds, taskTree, openCheckpoint, openTasks, treeIds, readState, STAGES }
  from "./lib/volna-state.mjs";

await runQuietly(async () => {
  const input = await readHookInput();
  const active = loadActive(input.cwd);
  if (!active) {
    // Задачи нет либо она не опознана - разные вещи, и вторая молчала бы так же, как первая
    const volnaDir = findVolnaDir(input.cwd);
    const keyWarning = stateKeyWarning(volnaDir);
    // Незакрытая работа без активной задачи - забытая: её и надо видеть в начале сессии.
    const open = volnaDir && !readState(volnaDir).muted ? openTasks(volnaDir) : [];
    const lines = [
      ...(keyWarning ? [`Волна: ${keyWarning}`] : []),
      ...(open.length ? [`Волна: активной задачи нет, незакрытых задач: ${open.length}`, ...openLines(open)] : []),
    ];
    if (lines.length) emitContext("SessionStart", lines);
    return;
  }

  const { fm, task } = active;
  const stage = fm.stage || "?";
  const pos = stagePosition(stage);
  const ownStatus = taskStatus(fm, true);
  const lines = [
    `Волна: активна задача ${task}${fm.title ? ` «${fm.title}»` : ""}` +
      `${fm.type ? ` (${fm.type})` : ""}`,
    `Этап: ${stage}${pos ? ` · ${pos}/${STAGES.length}` : ""}` +
      // Часть говорит то, чего не говорит этап: у задачи есть незакрытый остаток.
      `${partOf(fm) ? ` · часть ${partOf(fm)}` : ""}` +
      `${ownStatus.status !== "в работе" ? ` · ${statusLabel(ownStatus)}` : ""}` +
      `${fm.branch ? ` · ветка ${fm.branch}` : ""}`,
    // Время машины для меток журнала: локальное, не UTC.
    `Сейчас: ${localStamp()}`,
  ];

  // Карта частей целиком: возврат к задаче - тот момент, когда состав работы надо видеть
  // весь, а не одним номером. Дальше по ходу печатается только счёт (шапка).
  const summary0 = readSummary(active.text);
  const progress = partsProgress(summary0?.body);
  if (progress) {
    lines.push(`Части: ${progress.total}, сделано ${progress.done}, осталось ${progress.left}` +
      `${progress.dropped ? `, снято ${progress.dropped}` : ""}`);
    for (const it of progress.items) lines.push(`  ${it.n}. ${truncate(it.title, 60)} - ${it.state}`);
  }

  // Дерево задач от корня: возврат к работе - момент, когда очередь детей надо видеть целиком.
  const chain = ancestry(active.volnaDir, fm, task);
  const cycle = chain.find((node) => node.cycle);
  if (cycle) lines.push(`Цепочка parent замкнута на ${cycle.id}: поправь поле parent в журналах.`);
  const up = chain.filter((node) => !node.cycle);
  if (up.length) lines.push(`Путь: ${[task, ...up.map((node) => node.id)].join(" <- ")}`);
  // Связь с одной стороны: ребёнок выпадает из очереди родителя и из его счёта детей.
  if (up.length && !up[0].children.includes(task)) {
    lines.push(`Родитель ${up[0].id} не перечисляет ${task} в children: поправь поле children родителя.`);
  }
  const rootId = up.length ? up[up.length - 1].id : task;
  if (up.length || childIds(fm).length) {
    lines.push("Дерево задач:");
    for (const line of taskTree(active.volnaDir, rootId, task)) lines.push(`  ${line}`);
  }
  // Незакрытые задачи вне дерева: отложенная ради срочной работа не должна пропадать из виду.
  const others = openTasks(active.volnaDir, task, new Set([task, ...treeIds(active.volnaDir, rootId)]));
  if (others.length) lines.push(`Другие незакрытые задачи: ${others.length}`, ...openLines(others));

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

/** Строки списка незакрытых задач: до пяти, остальное - счётом. */
function openLines(nodes, limit = 5) {
  const lines = nodes.slice(0, limit).map((node) =>
    `  ${node.id}${node.title ? ` ${truncate(node.title, 50)}` : ""} - ${statusLabel(node)}` +
    `${node.stage ? ` · ${node.stage}` : ""}${node.updated ? ` · ${node.updated.replace("T", " ")}` : ""}`);
  if (nodes.length > limit) lines.push(`  ... ещё ${nodes.length - limit}: volna-task list`);
  return lines;
}
