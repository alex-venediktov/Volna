/**
 * Чтение .env без зависимостей: Node умеет --env-file, но полагаться на флаг нельзя -
 * CLI зовут из Bash, из PowerShell и из hooks, где аргументы запуска не наши.
 *
 * Правила: уже заданная переменная окружения ВАЖНЕЕ файла (иначе не переопределить на один
 * запуск), значения не раскрываются в логах, секретов в .env нет - только путь к файлу токена.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

/**
 * Найти файл вверх по дереву от startDir. Не нашли - null.
 *
 * Подъём кончается на корне репозитория (каталог с .git): настройки берутся из своего проекта,
 * а не из соседнего выше по дереву. Иначе .env каталога проектов молча подставлял бы чужой
 * адрес трекера в репозиторий, где «Волну» не разворачивали.
 */
export function findUp(fileName, startDir = process.cwd(), limit = 12) {
  let dir = resolve(startDir);
  for (let i = 0; i < limit; i++) {
    const candidate = join(dir, fileName);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Разобрать текст .env. Поддержано: KEY=value, кавычки, комментарии после значения и на
 * отдельной строке, префикс export. Многострочных значений нет - они нам не нужны.
 */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).replace(/^﻿/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1);
    } else {
      value = stripComment(value).trim();
    }
    out[key] = value;
  }
  return out;
}

/** Комментарий после значения; внутри кавычек # не трогаем. */
function stripComment(s) {
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") quoted = !quoted;
    if (c === "#" && !quoted) return s.slice(0, i);
  }
  return s;
}

/**
 * Загрузить .env рабочего репозитория в process.env (не перетирая заданное) и вернуть
 * итоговый набор переменных. Файла нет - не ошибка: значения могут приходить из окружения.
 */
export function loadEnv({ cwd = process.cwd(), env = process.env, fileName = ".env" } = {}) {
  const path = findUp(fileName, cwd);
  if (!path) return { path: null, loaded: {}, env };
  let loaded = {};
  try {
    loaded = parseEnv(readFileSync(path, "utf8"));
  } catch {
    return { path, loaded: {}, env };
  }
  for (const [key, value] of Object.entries(loaded)) {
    if (env[key] === undefined || env[key] === "") env[key] = value;
  }
  return { path, loaded, env };
}

/** Значение обязательной переменной или понятная ошибка с указанием, что заполнить. */
export function requireEnv(name, env = process.env) {
  const value = env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Не заполнена переменная ${name} - смотри .env рабочего репозитория (шаблон .env.example)`);
  }
  return String(value).trim();
}
