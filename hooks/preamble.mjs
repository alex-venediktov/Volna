#!/usr/bin/env node
/**
 * UserPromptSubmit: шапка контекста, жёсткий бюджет - не больше MAX_LINES строк.
 * Шапка идёт с каждым сообщением, поэтому платится каждый раз: экономия важнее полноты.
 *
 * Дополнительно: если в промпте есть номер задачи (4-6 цифр) и для него ЕСТЬ журнал,
 * добавляется ссылка и три строки резюме. Только точное совпадение по номеру - никакого
 * поиска по смыслу: он стоил бы токенов на каждом сообщении.
 */
import { readHookInput, loadActive, findVolnaDir, readJournal, runQuietly, emitContext, stagePosition, openItems, minutesSince, truncate, readSummary, summaryField, summaryLag, localStamp, STAGES }
  from "./lib/volna-state.mjs";

const MAX_LINES = 20;

await runQuietly(async () => {
  const input = await readHookInput();
  const lines = [];

  const active = loadActive(input.cwd);
  if (active) {
    const { fm, task } = active;
    const stage = fm.stage || "?";
    const pos = stagePosition(stage);
    const head = [`Волна: задача ${task}`];
    if (fm.title) head.push(`«${truncate(String(fm.title), 60)}»`);
    head.push(`· этап ${stage}${pos ? ` ${pos}/${STAGES.length}` : ""}`);
    if (fm.branch) head.push(`· ${fm.branch}`);
    // Время машины: метки журнала ставит модель, а текущего времени она не знает.
    head.push(`· сейчас ${localStamp()}`);
    lines.push(head.join(" "));

    const open = openItems(fm, 3);
    for (const item of open) lines.push(`  открыто: ${item}`);

    const mins = minutesSince(active.mtimeMs);
    if (mins !== null && mins >= 30) {
      lines.push(`  журнал не дописан ${mins} мин - на этапе положена запись`);
    }

    // Отставшее резюме опаснее его отсутствия: оно читается как актуальное.
    const lag = summaryLag(active.text);
    if (lag === "missing") {
      lines.push("  в журнале нет секции «## Состояние» - после /compact придётся читать лог целиком");
    } else if (lag) {
      lines.push(`  «Состояние» отстало от лога (последняя запись ${lag}) - перепиши его`);
    }
  }

  // Точный подъём референса по номеру из промпта (не активная задача, а упомянутая).
  const mentioned = mentionedTask(input.prompt, active?.task);
  if (mentioned) {
    const volnaDir = findVolnaDir(input.cwd);
    const journal = volnaDir ? readJournal(volnaDir, mentioned) : null;
    if (journal) {
      lines.push(`Про ${mentioned} есть журнал: .volna/journal/TASK-${mentioned}.md`);
      for (const s of summarize(journal, 3)) lines.push(`  ${s}`);
    }
  }

  if (!lines.length) return;                       // вне задачи система молчит
  emitContext("UserPromptSubmit", lines.slice(0, MAX_LINES));
});

/**
 * Первый идентификатор задачи в промпте, отличный от активной: номер трекера (4-6 цифр)
 * либо локальный id вида 260730-slug. Локальная форма проверяется первой - иначе от неё
 * осталась бы одна дата, и журнал по ней не нашёлся бы.
 */
function mentionedTask(prompt, activeTask) {
  if (!prompt) return null;
  const text = String(prompt);
  const matches = [
    ...(text.match(/\b\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*\b/gi) ?? []),
    ...(text.match(/\b\d{4,6}\b/g) ?? []),
  ];
  if (!matches.length) return null;
  return matches.find((n) => n !== activeTask) ?? null;
}

/** Три строки резюме журнала: заголовок, этап, «сделано» из секции «Состояние». */
function summarize(journal, limit) {
  const { fm } = journal;
  const out = [];
  if (fm.title) out.push(`заголовок: ${truncate(String(fm.title), 70)}`);
  const done = Array.isArray(fm.stages_done) ? fm.stages_done.length : 0;
  out.push(`тип ${fm.type || "?"}, этап ${fm.stage || "?"}, пройдено ${done}`);
  const last = summaryLine(journal.text);
  if (last) out.push(`последнее: ${truncate(last, 80)}`);
  return out.slice(0, limit);
}

/**
 * Строка «сделано» из секции «Состояние»; её нет - откат на последнюю секцию лога.
 * Резюме предпочтительнее хвоста лога: хвост может быть отменённой итерацией.
 */
function summaryLine(text) {
  const summary = readSummary(text);
  const fromSummary = summary && (summaryField(summary.body, "сделано") || summaryField(summary.body, "цель"));
  if (fromSummary) return fromSummary;
  const idx = text.lastIndexOf("\n## ");
  const tail = idx < 0 ? text : text.slice(idx);
  const m = /\*\*(?:сделано|что)\:\*\*\s*(.+)/.exec(tail);
  return m ? m[1].trim() : null;
}
