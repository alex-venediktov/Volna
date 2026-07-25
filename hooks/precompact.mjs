#!/usr/bin/env node
/**
 * PreCompact: перед сжатием контекста напомнить дописать журнал. Не блокирует - сжатие
 * бывает автоматическим, и мешать ему нельзя. Смысл в том, чтобы после /compact работа
 * восстанавливалась по журналу, а не по остаткам контекста.
 */
import { readHookInput, loadActive, runQuietly, emitContext, minutesSince, openItems }
  from "./lib/volna-state.mjs";

await runQuietly(async () => {
  const input = await readHookInput();
  const active = loadActive(input.cwd, { respectMute: false });
  if (!active) return;

  const { fm, task } = active;
  const mins = minutesSince(active.mtimeMs);
  const open = openItems(fm, 3);

  const lines = [
    `Волна: контекст сжимается${input.compaction_trigger === "auto" ? " автоматически" : ""}.` +
      ` До сжатия допиши журнал задачи ${task} (этап ${fm.stage || "?"}).`,
    "Инвариант: по журналу задача восстанавливается с нуля. Три проверки -",
    "понятно ли, на чём остановились; перечислены ли следующие шаги в «осталось»;",
    "все ли открытые вопросы в open[] frontmatter.",
  ];
  if (mins !== null && mins >= 15) {
    lines.push(`Журнал не обновлялся ${mins} мин - скорее всего, запись отстала от работы.`);
  }
  if (open.length) {
    lines.push(`Открытые пункты сейчас: ${open.length}. Проверь, не появились ли новые.`);
  }

  emitContext("PreCompact", lines);
});
