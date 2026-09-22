#!/usr/bin/env node
/**
 * PostToolUse на записи в журнал: метка секции, ушедшая вперёд часов машины, называется СРАЗУ,
 * в том же ходе, где её написали.
 *
 * Почему не строкой правил: правило «метку берут у часов» стоит в трёх местах скилла и в вике,
 * а метки всё равно уезжали вперёд на шести задачах подряд. Почему не шапкой: шапка приходит
 * на сообщение человека, а внутри автопрохода сообщений нет - именно там несколько секций
 * пишутся одним ходом, и до шапки расхождение доживает уже необъяснимым.
 *
 * Не блокирует: блокирующее место в «Волне» одно (hooks/gate.mjs), и метка - не необратимое
 * действие, а запись, которую в том же ходе можно поправить.
 */
import { readFileSync } from "node:fs";
import { readHookInput, runQuietly, emitContext, findVolnaDir, readState, stampAhead, aheadLabel }
  from "./lib/volna-state.mjs";

const WRITERS = ["Write", "Edit", "MultiEdit"];

await runQuietly(async () => {
  const input = await readHookInput();
  if (!WRITERS.includes(String(input.tool_name || ""))) return;

  const file = String(input.tool_input?.file_path || "");
  if (!isJournalFile(file)) return;

  // Глушение уважается: /volna:off просили о тишине, а это сопровождение, а не защита необратимого
  const volnaDir = findVolnaDir(input.cwd);
  if (volnaDir && readState(volnaDir).muted) return;

  const ahead = stampAhead(readFileSync(file, "utf8"));
  if (!ahead) return;

  emitContext("PostToolUse", [
    `Волна: метка «${ahead.stamp}» в журнале впереди часов машины на ${aheadLabel(ahead.minutes)}` +
      ` (сейчас ${ahead.now}).`,
    'Спроси date +"%Y-%m-%d %H:%M" и поправь заголовок секции сейчас: на close по этим меткам',
    "считаются списываемые часы, и там расхождение уже неотличимо от потраченного времени.",
  ]);
});

/** Файл журнала «Волны»: .volna/journal/** и расширение md. Разделитель пути - любой. */
function isJournalFile(path) {
  const p = path.replace(/\\/g, "/");
  return /\/\.volna\/journal\//.test(p) && p.endsWith(".md");
}
