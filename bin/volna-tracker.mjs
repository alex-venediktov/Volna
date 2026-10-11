#!/usr/bin/env node
/**
 * Общий CLI трекера для «Волны»: один глагол на все трекеры, шлюз выбирается строкой профиля
 * `трекер` в .volna/project.md. Шлюз - CLI своего трекера (volna-tfs, volna-jira): вызов уходит
 * в его run() как есть, поэтому вывод, --dry-run и коды выхода у них общие.
 *
 * Своего у адаптера три вещи:
 *   - статус по смыслу: `state <id> в-работе | на-проверке | закрыта` - имя статуса в трекере
 *     берётся из секции «## Статусы трекера» .volna/project.md, без строки - умолчание шлюза;
 *     любое другое имя статуса уходит в трекер как есть;
 *   - `capabilities` - что умеет шлюз;
 *   - глагол, которого у шлюза нет, - отказ с кодом 4: этап такой шаг не делает.
 *
 * Использование:
 *   volna-tracker capabilities             шлюз, его глаголы и возможности
 *   volna-tracker <глагол> [аргументы]     глагол шлюза: check, get, query, states, comment,
 *                                          describe, state, create и то, что шлюз умеет сверх них
 *
 * Коды выхода: 0 сделано, 1 отказ, 2 настройка (профиль, переменные), 4 шлюз этого не умеет.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findVolnaDir, readProfile, readSection, isPlaceholder } from "../hooks/lib/volna-state.mjs";

/** Глаголы контракта: их обязан понимать любой шлюз (`docs/research/local-tracker-mcp.md`). */
export const CONTRACT_VERBS = ["check", "get", "query", "states", "comment", "describe", "state", "create"];

/** Статусы по смыслу: слово команды state -> ключ строки секции «Статусы трекера». */
export const STATUS_MEANINGS = { "в-работе": "в работе", "на-проверке": "на проверке", "закрыта": "закрыта" };

/** Заголовок секции .volna/project.md с именами статусов в трекере. */
export const STATUS_SECTION = "Статусы трекера";

/** Код выхода «шлюз этого не умеет»: отсутствующий шаг, а не сбой. */
export const EXIT_UNSUPPORTED = 4;

/** Шлюзы: CLI трекера, глаголы сверх контракта, возможности и умолчания имён статусов. */
export const GATEWAYS = {
  tfs: {
    cli: "./volna-tfs.mjs",
    extraVerbs: ["whoami", "time", "estimate", "fields", "attachments", "link", "tag", "pr", "link-pr", "attach"],
    features: ["parent", "time", "estimate", "pr", "fix-task", "attachments"],
    statuses: { "в работе": "Active", "на проверке": "Resolved", "закрыта": "Closed" },
  },
  jira: {
    cli: "./volna-jira.mjs",
    extraVerbs: ["whoami", "time", "estimate"],
    features: ["parent", "time", "estimate"],
    statuses: {},
  },
};

/** Глаголы шлюза: контракт плюс его собственные. */
export function gatewayVerbs(name) {
  const gw = GATEWAYS[name];
  return gw ? [...CONTRACT_VERBS, ...gw.extraVerbs] : [];
}

/**
 * Шлюз по профилю. Строки «трекер» нет - прежнее поведение «Волны», tfs. Возвращает
 * { name } либо { error } с текстом для человека.
 */
export function resolveGateway(profile) {
  const raw = profile?.["трекер"];
  if (raw === undefined || raw === "") return { name: "tfs" };
  const value = String(raw).trim().toLowerCase();
  if (isPlaceholder(value)) {
    return { error: "строка «трекер» профиля не заполнена (плейсхолдер в .volna/project.md): заполни её - /volna:init" };
  }
  if (value === "нет" || value === "none") {
    return { error: "у проекта нет трекера (трекер: нет): задачи локальные, звать трекер незачем" };
  }
  if (!GATEWAYS[value]) {
    return { error: `шлюза «${value}» нет; есть: ${Object.keys(GATEWAYS).join(", ")}` };
  }
  return { name: value };
}

/**
 * Имя статуса в трекере для слова команды state. Слово не по смыслу - возвращается как есть.
 * Строка секции важнее умолчания шлюза; плейсхолдер в строке - всё равно что строки нет.
 */
export function resolveStatus(word, gatewayName, section = {}) {
  const meaning = STATUS_MEANINGS[String(word).trim().toLowerCase().replace(/\s+/g, "-")];
  if (!meaning) return { name: word };
  const own = section[meaning];
  if (own && !isPlaceholder(own)) return { name: own, meaning };
  const fallback = GATEWAYS[gatewayName]?.statuses?.[meaning];
  if (fallback) return { name: fallback, meaning };
  return {
    meaning,
    error: `имя статуса «${meaning}» для трекера ${gatewayName} не задано: строка «- ${meaning}: <имя>» ` +
      `в секции «## ${STATUS_SECTION}» .volna/project.md; доступные статусы - volna-tracker states <id>`,
  };
}

/**
 * argv команды state с подставленным именем статуса: слова до первого флага - статус. Флаги
 * стоят раньше статуса - заменяется только слово по смыслу целиком, остальное уходит как есть.
 */
export function translateState(argv, gatewayName, section) {
  const firstFlag = argv.findIndex((a, i) => i > 1 && a.startsWith("--"));
  const end = firstFlag < 0 ? argv.length : firstFlag;
  const word = argv.slice(2, end).join(" ");
  if (!argv[1]) return { argv };
  if (!word) {
    const at = argv.findIndex((a, i) => i > 1 && STATUS_MEANINGS[a.toLowerCase()]);
    if (at < 0) return { argv };
    const res = resolveStatus(argv[at], gatewayName, section);
    if (res.error) return { error: res.error };
    return { argv: argv.map((a, i) => (i === at ? res.name : a)), meaning: res.meaning, name: res.name };
  }
  const res = resolveStatus(word, gatewayName, section);
  if (res.error) return { error: res.error };
  return { argv: [argv[0], argv[1], res.name, ...argv.slice(end)], meaning: res.meaning, name: res.name };
}

/** Модуль CLI шлюза; тест подставляет свой загрузчик. */
async function loadGateway(name) {
  return import(GATEWAYS[name].cli);
}

/**
 * Точка входа, пригодная для тестов: deps.profile и deps.statuses подменяют чтение
 * .volna/project.md, deps.loadGateway - модуль шлюза; остальное уходит шлюзу (client, env, log, err).
 */
export async function run(argv, deps = {}) {
  const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  const verb = argv[0];

  if (!verb || verb === "help" || verb === "--help") {
    log(usage());
    return verb ? 0 : 1;
  }

  const volnaDir = deps.profile && deps.statuses ? null : findVolnaDir(deps.cwd ?? process.cwd());
  const profile = deps.profile ?? readProfile(volnaDir);
  const gw = resolveGateway(profile);
  if (gw.error) {
    err(`volna-tracker: ${gw.error}`);
    return 2;
  }
  const verbs = gatewayVerbs(gw.name);

  if (verb === "capabilities") {
    log(`шлюз: ${gw.name}`);
    log(`глаголы: ${verbs.join(" ")}`);
    log(`возможности: ${GATEWAYS[gw.name].features.join(" ") || "-"}`);
    return 0;
  }

  if (!verbs.includes(verb)) {
    err(`volna-tracker: шлюз ${gw.name} не умеет «${verb}» - шаг не выполняется. Умеет: ${verbs.join(" ")}`);
    return EXIT_UNSUPPORTED;
  }

  let forwarded = argv;
  if (verb === "state") {
    const statuses = deps.statuses ?? readSection(volnaDir, STATUS_SECTION);
    const t = translateState(argv, gw.name, statuses);
    if (t.error) {
      err(`volna-tracker: ${t.error}`);
      return 1;
    }
    forwarded = t.argv;
  }

  try {
    const mod = await (deps.loadGateway ?? loadGateway)(gw.name);
    return await mod.run(forwarded, deps);
  } catch (e) {
    err(`volna-tracker: шлюз ${gw.name} не запустился: ${e?.message ?? e}`);
    return 2;
  }
}

function usage() {
  return `volna-tracker - общий CLI трекера для «Волны»; шлюз - строка «трекер» профиля

  capabilities                   шлюз, его глаголы и возможности
  <глагол> [аргументы]           глагол шлюза как есть (check, get, query, states, comment,
                                 describe, state, create и сверх них по capabilities)
  state <id> в-работе|на-проверке|закрыта
                                 статус по смыслу: имя из «## ${STATUS_SECTION}» в .volna/project.md

Коды: 0 сделано, 1 отказ, 2 настройка, 4 шлюз этого не умеет.`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2)));
}
