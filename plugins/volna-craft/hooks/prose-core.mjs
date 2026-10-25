#!/usr/bin/env node
// SessionStart: кладёт в сессию раздел "Ядро" скилла humanizer (skills/humanizer/SKILL.md)
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillPath = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "humanizer", "SKILL.md");

// Текст раздела "## Ядро" до следующего заголовка второго уровня, без пустых строк
export function extractCore(markdown) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Ядро");
  if (start < 0) return "";
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => line.trim()).join("\n").trim();
}

// Отключение переменной окружения VOLNA_PROSE_CORE=off (docs/INSTALL.md)
export function isDisabled(env) {
  return ["off", "0", "false", "no"].includes(String(env.VOLNA_PROSE_CORE ?? "").trim().toLowerCase());
}

// Ошибка hook'а - тихий выход 0, работа не ломается (правило тишины hooks)
function main() {
  try {
    if (isDisabled(process.env)) return;
    const core = extractCore(readFileSync(skillPath, "utf8"));
    if (!core) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `Проза (volna-craft:humanizer):\n${core}` },
    }));
  } catch {
    // молча: hook не мешает работе
  }
}

// Запуск файлом, а не импортом из теста; регистр пути на Windows не важен
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main();
