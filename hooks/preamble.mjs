#!/usr/bin/env node
/**
 * UserPromptSubmit: шапка контекста, жёсткий бюджет - не больше MAX_LINES строк.
 * Шапка идёт с каждым сообщением, поэтому платится каждый раз: экономия важнее полноты.
 *
 * Дополнительно: если в промпте есть номер задачи (4-6 цифр) и для него ЕСТЬ журнал,
 * добавляется ссылка и три строки резюме. Только точное совпадение по номеру - никакого
 * поиска по смыслу: он стоил бы токенов на каждом сообщении.
 */
import { readHookInput, loadActive, findVolnaDir, readJournal, runQuietly, emitContext, stagePosition, openItems, minutesSince, truncate, STAGES }
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
    lines.push(head.join(" "));

    const open = openItems(fm, 3);
    for (const item of open) lines.push(`  открыто: ${item}`);

    const mins = minutesSince(active.mtimeMs);
    if (mins !== null && mins >= 30) {
      lines.push(`  журнал не дописан ${mins} мин - на этапе положена запись`);
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

/** Первый номер задачи в промпте, отличный от активной. */
function mentionedTask(prompt, activeTask) {
  if (!prompt) return null;
  const matches = String(prompt).match(/\b\d{4,6}\b/g);
  if (!matches) return null;
  return matches.find((n) => n !== activeTask) ?? null;
}

/** Три строки резюме журнала: тип, этап, последняя запись. */
function summarize(journal, limit) {
  const { fm } = journal;
  const out = [];
  if (fm.title) out.push(`заголовок: ${truncate(String(fm.title), 70)}`);
  const done = Array.isArray(fm.stages_done) ? fm.stages_done.length : 0;
  out.push(`тип ${fm.type || "?"}, этап ${fm.stage || "?"}, пройдено ${done}`);
  const last = lastSectionLine(journal.text);
  if (last) out.push(`последнее: ${truncate(last, 80)}`);
  return out.slice(0, limit);
}

/** Строка «сделано» или «что» из последней секции журнала. */
function lastSectionLine(text) {
  const idx = text.lastIndexOf("\n## ");
  const tail = idx < 0 ? text : text.slice(idx);
  const m = /\*\*(?:сделано|что)\:\*\*\s*(.+)/.exec(tail);
  return m ? m[1].trim() : null;
}
