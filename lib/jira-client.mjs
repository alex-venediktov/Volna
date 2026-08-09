/**
 * Клиент Jira Cloud (REST `/rest/api/2`) для «Волны». Самодостаточный ESM: только node:fs
 * и global fetch. Основа для bin/volna-jira.mjs. Подвохи API - docs/reference/jira-rest.md.
 *
 * Четыре вещи, на которых обжигаются все:
 *  - Auth: Basic от строки "<email>:<api_token>" (у TFS был пустой логин, здесь логин обязателен);
 *  - версия API выбрана намеренно: в v2 описание и тело комментария - СТРОКА wiki-разметки,
 *    в v3 то же поле приходит и принимается документом ADF;
 *  - статус меняется переходом рабочего процесса, а не записью поля, и набор переходов зависит
 *    от текущего статуса;
 *  - поиск живёт по адресу `/search/jql`: прежний `/search` отвечает 410, поля перечисляются
 *    явно, страницы идут курсором `nextPageToken`, а поля `total` в ответе нет.
 */
import { readFileSync, existsSync } from "node:fs";

const utf8 = new TextEncoder();

// -- конфигурация -----------------------------------------------------------

/** Прочитать API-токен из файла: срезать BOM (utf-8-sig) и края. Секрет - в файле, не в env. */
export function readTokenFile(path, trim = true) {
  if (!existsSync(path)) {
    throw new Error(`Файл токена не найден: ${path} (см. JIRA_TOKEN_FILE в .env)`);
  }
  let s = readFileSync(path, "utf8");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return trim ? s.trim() : s;
}

/** Подсказка к ответу сервера: типовые причины отказа Jira называются невнятно. */
export function errorHint(raw, status) {
  const text = String(raw ?? "");
  if (status === 410) {
    return " (410 - адрес выведен из обращения: поиск переехал на /search/jql)";
  }
  if (/is not on the appropriate screen|cannot be set. It is not on the appropriate screen/i.test(text)) {
    return " (поле отсутствует на экране операции: его значение задаётся переходом или экраном" +
      " создания, а не прямой записью)";
  }
  if (/Issue does not exist or you do not have permission to see it/i.test(text)) {
    return " (ключ не найден либо нет прав на проект: проверь ключ и учётную запись токена)";
  }
  if (status === 401) return " (401 - токен истёк или не тот email: Basic собирается из email и токена)";
  if (status === 403) return " (403 - учётной записи не хватает прав на эту операцию)";
  return "";
}

/**
 * Собрать конфиг из переменных окружения: JIRA_BASE_URL, JIRA_EMAIL, JIRA_TOKEN_FILE,
 * JIRA_PROJECT, JIRA_JQL_MINE. Значения токена в env не держим - только путь к файлу.
 */
export function jiraConfigFromEnv(env = process.env) {
  const baseUrl = env.JIRA_BASE_URL;
  const email = env.JIRA_EMAIL;
  const tokenFile = env.JIRA_TOKEN_FILE;
  if (!baseUrl) throw new Error("Не задан JIRA_BASE_URL (адрес экземпляра Jira) - заполни .env");
  if (!email) throw new Error("Не задан JIRA_EMAIL (учётная запись, которой выпущен токен) - заполни .env");
  if (!tokenFile) throw new Error("Не задан JIRA_TOKEN_FILE (путь к файлу с API-токеном) - заполни .env");
  return {
    baseUrl,
    email,
    token: readTokenFile(tokenFile),
    project: env.JIRA_PROJECT || undefined,
    jqlMine: env.JIRA_JQL_MINE || undefined,
  };
}

/** Поля задачи, которых хватает для карточки: список обязателен для /search/jql. */
export const SEARCH_FIELDS = ["summary", "issuetype", "status", "assignee", "parent", "updated"];

// -- клиент -----------------------------------------------------------------

export class JiraClient {
  #user;      // кто мы для трекера: спрашивается один раз за процесс

  /** cfg: { baseUrl, email, token, project?, jqlMine?, fetchFn?, sleepFn?, maxPages? }. */
  constructor(cfg) {
    if (!cfg?.baseUrl) throw new Error("Jira baseUrl не задан (проверь JIRA_BASE_URL)");
    if (!cfg?.email) throw new Error("Jira email не задан (проверь JIRA_EMAIL)");
    if (!cfg?.token) throw new Error("Jira токен пуст (проверь файл из JIRA_TOKEN_FILE)");
    this.base = String(cfg.baseUrl).replace(/\/+$/, "");
    this.email = cfg.email;
    this.project = cfg.project;
    this.jqlMine = cfg.jqlMine;
    this.maxPages = cfg.maxPages ?? 10;
    const auth = Buffer.from(`${cfg.email}:${cfg.token}`).toString("base64");
    this.headers = { Authorization: `Basic ${auth}`, Accept: "application/json" };
    this.doFetch = cfg.fetchFn ?? ((url, init) => fetch(url, init));
    this.sleep = cfg.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Полный адрес запроса: версия API входит в путь, а не в параметры. */
  #url(path, api = "2") {
    return `${this.base}/rest/api/${api}${path}`;
  }

  /**
   * Запрос с соблюдением ограничения частоты: при 429 сервер называет паузу в `Retry-After`,
   * и повтор идёт только после неё.
   */
  async #request(method, path, { body, api = "2", retries = 2 } = {}) {
    const url = this.#url(path, api);
    const init = { method, headers: { ...this.headers } };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = utf8.encode(JSON.stringify(body));
    }
    let res = await this.doFetch(url, init);
    for (let attempt = 0; attempt < retries && res?.status === 429; attempt++) {
      const wait = retryAfterMs(res.headers?.get?.("Retry-After"));
      await this.sleep(wait);
      res = await this.doFetch(url, init);
    }
    const raw = typeof res.text === "function" ? await res.text() : "";
    if (!res.ok) {
      throw new Error(`Jira ${method} ${url} -> HTTP ${res.status}` +
        `${errorHint(raw, res.status)}: ${String(raw).slice(0, 500)}`);
    }
    return raw ? JSON.parse(raw) : {};
  }

  /**
   * Проверка доступа для preflight: не бросает, возвращает статус. Отличает истекший токен (401),
   * нехватку прав (403) и недоступность сети (status 0).
   */
  async verifyAccess() {
    const url = this.#url("/myself");
    try {
      const res = await this.doFetch(url, { method: "GET", headers: this.headers });
      const raw = typeof res.text === "function" ? await res.text() : "";
      let user = null;
      try {
        user = raw ? JSON.parse(raw) : null;
      } catch { /* тело не JSON - для проверки доступа неважно */ }
      return { ok: res.ok, status: res.status, user, body: String(raw).slice(0, 300) };
    } catch (e) {
      return { ok: false, status: 0, user: null, body: String(e?.message ?? e) };
    }
  }

  /**
   * Отказ в доступе одной строкой либо null, если доступ есть. Зовётся на ОТРИЦАТЕЛЬНОМ ответе
   * чтения: сервер маскирует отсутствие доступа под пустую выборку и под «задачи не существует»,
   * и отличить одно от другого можно только отдельной проверкой.
   */
  async accessProblem() {
    const res = await this.verifyAccess();
    if (res.ok) return null;
    if (res.status === 401) return "токен истёк либо не совпадает с учётной записью из JIRA_EMAIL (401)";
    if (res.status === 403) return "учётной записи не хватает прав (403)";
    if (res.status === 0) return `сервер недоступен: ${res.body}`;
    return `отказ ${res.status}`;
  }

  /** Учётная запись токена: на неё запишутся комментарии и списанные часы. */
  async currentUser() {
    this.#user ??= await this.#request("GET", "/myself");
    return this.#user;
  }

  /** Задача целиком: поля, отрисованное описание и обсуждение одним ответом. */
  async getIssue(key, { expandRendered = true } = {}) {
    const expand = expandRendered ? "?expand=renderedFields" : "";
    return this.#request("GET", `/issue/${encodeURIComponent(key)}${expand}`);
  }

  /** Обсуждение задачи: тела комментариев приходят строкой wiki-разметки. */
  async comments(key, { maxResults = 50 } = {}) {
    const q = `?maxResults=${maxResults}&orderBy=created`;
    const data = await this.#request("GET", `/issue/${encodeURIComponent(key)}/comment${q}`);
    return data.comments ?? [];
  }

  /**
   * Поиск по JQL. Страницы идут курсором, число страниц ограничено: сервер иногда отдаёт
   * непустой `nextPageToken` бесконечно, и цикл без предела не заканчивается.
   */
  async searchJql(jql, { fields = SEARCH_FIELDS, maxResults = 50, maxPages = this.maxPages } = {}) {
    const issues = [];
    let token = null;
    let pages = 0;
    let truncated = false;
    while (pages < maxPages) {
      const params = new URLSearchParams({ jql, fields: fields.join(","), maxResults: String(maxResults) });
      if (token) params.set("nextPageToken", token);
      const data = await this.#request("GET", `/search/jql?${params}`);
      const batch = data.issues ?? [];
      issues.push(...batch);
      pages++;
      token = data.nextPageToken ?? null;
      if (data.isLast === true || !token || !batch.length) return { issues, pages, truncated };
    }
    truncated = true;
    return { issues, pages, truncated };
  }

  /** Переходы, доступные из текущего статуса задачи. Имя перехода не равно имени статуса. */
  async transitions(key) {
    const data = await this.#request("GET", `/issue/${encodeURIComponent(key)}/transitions`);
    return data.transitions ?? [];
  }

  /**
   * Перевести задачу переходом рабочего процесса. Имя ищется и среди переходов, и среди
   * целевых статусов; недоступный переход - понятная ошибка со списком доступных.
   */
  async transitionTo(key, wanted) {
    const list = await this.transitions(key);
    const hit = matchTransition(list, wanted);
    if (!hit) {
      const names = list.map((t) => `${t.name} -> ${t.to?.name ?? "?"}`).join(", ") || "нет ни одного";
      throw new Error(`Из текущего статуса задачи ${key} переход "${wanted}" недоступен.` +
        ` Доступные: ${names}`);
    }
    await this.#request("POST", `/issue/${encodeURIComponent(key)}/transitions`,
      { body: { transition: { id: hit.id } } });
    return hit;
  }

  /** Комментарий в обсуждение. Вход - markdown, в трекер уходит wiki-разметка. */
  async addComment(key, markdown) {
    return this.#request("POST", `/issue/${encodeURIComponent(key)}/comment`,
      { body: { body: markdownToJiraWiki(markdown) } });
  }

  /** Описание задачи: дописать абзац либо заменить целиком. */
  async setDescription(key, markdown, { replace = false } = {}) {
    const text = markdownToJiraWiki(markdown);
    let value = text;
    if (!replace) {
      const issue = await this.getIssue(key, { expandRendered: false });
      const current = issue.fields?.description;
      value = current ? `${String(current).replace(/\s+$/, "")}\n\n${text}` : text;
    }
    return this.#request("PUT", `/issue/${encodeURIComponent(key)}`, { body: { fields: { description: value } } });
  }

  /** Оценка и остаток работ: часы записываются полем timetracking, а не worklog. */
  async setEstimate(key, { original, remaining } = {}) {
    const timetracking = {};
    if (original !== undefined && original !== null) timetracking.originalEstimate = formatDuration(original);
    if (remaining !== undefined && remaining !== null) timetracking.remainingEstimate = formatDuration(remaining);
    if (!Object.keys(timetracking).length) throw new Error("Нечего записывать: не задана ни оценка, ни остаток");
    return this.#request("PUT", `/issue/${encodeURIComponent(key)}`, { body: { fields: { timetracking } } });
  }

  /** Списать часы: запись worklog прибавляется к затраченному и уменьшает остаток. */
  async addWorklog(key, hours, { comment, started } = {}) {
    const seconds = Math.round(Number(hours) * 3600);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`Часы должны быть положительным числом: ${hours}`);
    const body = { timeSpentSeconds: seconds };
    if (comment) body.comment = markdownToJiraWiki(comment);
    if (started) body.started = started;
    return this.#request("POST", `/issue/${encodeURIComponent(key)}/worklog`, { body });
  }

  /** Типы задач проекта: имена приходят переведёнными под язык учётной записи. */
  async projectTypes(projectKey = this.project) {
    if (!projectKey) throw new Error("Не задан проект (JIRA_PROJECT либо аргумент команды)");
    const data = await this.#request("GET", `/project/${encodeURIComponent(projectKey)}`);
    return data.issueTypes ?? [];
  }

  /** Статусы рабочего процесса по типам задач проекта. */
  async projectStatuses(projectKey = this.project) {
    if (!projectKey) throw new Error("Не задан проект (JIRA_PROJECT либо аргумент команды)");
    return this.#request("GET", `/project/${encodeURIComponent(projectKey)}/statuses`);
  }
}

/** Пауза до повтора по заголовку `Retry-After`: секунды либо дата. Пусто - десять секунд. */
export function retryAfterMs(value, now = Date.now()) {
  const raw = String(value ?? "").trim();
  if (!raw) return 10000;
  if (/^\d+$/.test(raw)) return Math.min(Number(raw) * 1000, 120000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? 10000 : Math.max(0, Math.min(at - now, 120000));
}

/** Переход по имени: сначала по имени самого перехода, затем по имени целевого статуса. */
export function matchTransition(transitions, wanted) {
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  const target = norm(wanted);
  if (!target) return null;
  return transitions.find((t) => norm(t.name) === target)
    ?? transitions.find((t) => norm(t.to?.name) === target)
    ?? transitions.find((t) => norm(t.name).includes(target) || norm(t.to?.name).includes(target))
    ?? null;
}

/**
 * Вид задачи для ветвления флоу. Опора - признак подзадачи и словарь имён: одно и то же
 * поле приходит то переведённым (`Баг`), то исходным (`Bug`), в зависимости от эндпоинта.
 */
export function issueKind(issueType) {
  const name = String(issueType?.name ?? "").trim().toLowerCase();
  if (/^(баг|дефект|bug|defect)/.test(name)) return "bug";
  if (/^(истори|story|user story)/.test(name)) return "story";
  if (/^(эпик|epic)/.test(name)) return "epic";
  return "task";
}

/** Часы в запись длительности Jira: 1.5 -> "1h 30m", 8 -> "8h". */
export function formatDuration(hours) {
  const total = Math.round(Number(hours) * 60);
  if (!Number.isFinite(total) || total <= 0) throw new Error(`Часы должны быть положительным числом: ${hours}`);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return [h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ");
}

/** Компактная карточка задачи для чтения моделью: поля, постановка, обсуждение, связи. */
export function summarizeIssue(issue, comments = []) {
  const f = issue?.fields ?? {};
  const out = [];
  out.push(`# ${issue?.key ?? "?"} - ${f.summary ?? "(без заголовка)"}`);
  out.push("");
  out.push(`- тип: ${f.issuetype?.name ?? "?"} (вид для флоу: ${issueKind(f.issuetype)})`);
  out.push(`- статус: ${f.status?.name ?? "?"}` +
    (f.status?.statusCategory?.name ? ` (${f.status.statusCategory.name})` : ""));
  out.push(`- исполнитель: ${f.assignee?.displayName ?? "не назначен"}`);
  if (f.parent) out.push(`- родитель: ${f.parent.key} - ${f.parent.fields?.summary ?? ""}`.trimEnd());
  if (f.labels?.length) out.push(`- метки: ${f.labels.join(", ")}`);
  if (f.timetracking && Object.keys(f.timetracking).length) {
    const t = f.timetracking;
    out.push(`- время: оценка ${t.originalEstimate ?? "-"}, затрачено ${t.timeSpent ?? "-"},` +
      ` остаток ${t.remainingEstimate ?? "-"}`);
  }
  const links = (f.issuelinks ?? []).map((l) => {
    const other = l.outwardIssue ?? l.inwardIssue;
    const rel = l.outwardIssue ? l.type?.outward : l.type?.inward;
    return other ? `${rel ?? "связь"}: ${other.key} - ${other.fields?.summary ?? ""}`.trimEnd() : null;
  }).filter(Boolean);
  if (links.length) out.push(`- связи: ${links.join("; ")}`);
  const attachments = (f.attachment ?? []).map((a) => a.filename).filter(Boolean);
  if (attachments.length) out.push(`- вложения: ${attachments.join(", ")}`);
  out.push("");
  out.push("## Постановка");
  out.push("");
  out.push(f.description ? jiraWikiToMarkdown(f.description) : "(описание пустое)");
  if (comments.length) {
    out.push("");
    out.push(`## Обсуждение (${comments.length})`);
    for (const c of comments) {
      out.push("");
      out.push(`**${c.author?.displayName ?? "?"}** (${String(c.created ?? "").slice(0, 16)}):`);
      out.push(jiraWikiToMarkdown(c.body));
    }
  }
  return out.join("\n");
}

// -- разметка ---------------------------------------------------------------

/**
 * Markdown в wiki-разметку Jira: вход «Волны» всегда markdown, а поля v2 принимают строку.
 * Блоки кода переносятся дословно, инлайн-разметка внутри них не трогается.
 */
export function markdownToJiraWiki(md) {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inCode = false;
  let tableHeaderDone = false;
  for (const line of lines) {
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      out.push(inCode ? "{code}" : (fence[1] ? `{code:${fence[1]}}` : "{code}"));
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) {          // разделитель шапки таблицы своей строки не имеет
        tableHeaderDone = true;
        continue;
      }
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => inlineToWiki(c.trim()));
      out.push(tableHeaderDone ? `|${cells.join("|")}|` : `||${cells.join("||")}||`);
      continue;
    }
    tableHeaderDone = false;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`h${heading[1].length}. ${inlineToWiki(heading[2])}`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("----");
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(`bq. ${inlineToWiki(quote[1])}`);
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${"*".repeat(depthOf(bullet[1]))} ${inlineToWiki(bullet[2])}`);
      continue;
    }
    const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      out.push(`${"#".repeat(depthOf(numbered[1]))} ${inlineToWiki(numbered[2])}`);
      continue;
    }
    out.push(inlineToWiki(line));
  }
  return out.join("\n");
}

/** Уровень вложенности списка по отступу: два пробела на уровень. */
function depthOf(indent) {
  return Math.floor(String(indent).replace(/\t/g, "  ").length / 2) + 1;
}

/** Инлайн-разметка одной строки: код, ссылки, начертание. */
function inlineToWiki(s) {
  const code = [];
  let text = String(s ?? "").replace(/`([^`]+)`/g, (_m, body) => {
    code.push(body);
    return `\u0000${code.length - 1}\u0000`;                 // код прячется до конца разбора строки
  });
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) => `!${url}!${alt ? ` ${alt}` : ""}`);
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "[$1|$2]");
  // жирный прячется под свой маркер: в разметке Jira он тоже одинарная звёздочка
  const bold = [];
  const hideBold = (_m, body) => {
    bold.push(body);
    return `\u0001${bold.length - 1}\u0001`;
  };
  text = text.replace(/\*\*([^*]+)\*\*/g, hideBold).replace(/__([^_]+)__/g, hideBold);
  text = text.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, "$1_$2_");
  text = text.replace(/\u0001(\d+)\u0001/g, (_m, i) => `*${bold[Number(i)]}*`);
  text = text.replace(/~~([^~]+)~~/g, "-$1-");
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i) => `{{${code[Number(i)]}}}`);
}

/**
 * Wiki-разметка Jira в markdown: то, что пришло из трекера, показывается человеку и модели
 * в привычном виде.
 */
export function jiraWikiToMarkdown(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inCode = false;
  for (const line of lines) {
    const open = /^\{code(?::([^}]*))?\}\s*$/.exec(line);
    const noformat = /^\{noformat\}\s*$/.test(line);
    if (open || noformat) {
      if (inCode) {
        out.push("```");
        inCode = false;
      } else {
        const lang = open?.[1] ? String(open[1]).split("|")[0] : "";
        out.push(`\`\`\`${lang}`);
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }
    const heading = /^h([1-6])\.\s*(.*)$/.exec(line);
    if (heading) {
      out.push(`${"#".repeat(Number(heading[1]))} ${inlineToMarkdown(heading[2])}`);
      continue;
    }
    const quote = /^bq\.\s*(.*)$/.exec(line);
    if (quote) {
      out.push(`> ${inlineToMarkdown(quote[1])}`);
      continue;
    }
    if (/^-{4,}\s*$/.test(line)) {
      out.push("---");
      continue;
    }
    const table = /^\|\|(.*)\|\|\s*$/.exec(line);
    if (table) {
      const cells = table[1].split("||").map((c) => inlineToMarkdown(c.trim()));
      out.push(`| ${cells.join(" | ")} |`);
      out.push(`|${cells.map(() => "---").join("|")}|`);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => inlineToMarkdown(c.trim()));
      out.push(`| ${cells.join(" | ")} |`);
      continue;
    }
    const bullet = /^(\*+)\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${"  ".repeat(bullet[1].length - 1)}- ${inlineToMarkdown(bullet[2])}`);
      continue;
    }
    const numbered = /^(#+)\s+(.*)$/.exec(line);
    if (numbered) {
      out.push(`${"  ".repeat(numbered[1].length - 1)}1. ${inlineToMarkdown(numbered[2])}`);
      continue;
    }
    out.push(inlineToMarkdown(line));
  }
  return out.join("\n");
}

/** Инлайн-разметка одной строки в обратную сторону. */
function inlineToMarkdown(s) {
  const code = [];
  let text = String(s ?? "").replace(/\{\{([^}]+)\}\}/g, (_m, body) => {
    code.push(body);
    return `\u0000${code.length - 1}\u0000`;
  });
  text = text.replace(/!([^!|\s]+)(?:\|[^!]*)?!/g, "(вложение: $1)");
  text = text.replace(/\[([^\]|]+)\|([^\]]+)\]/g, "[$1]($2)");
  text = text.replace(/\[([a-z]+:\/\/[^\]]+)\]/gi, "<$1>");
  text = text.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, "$1**$2**");
  text = text.replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:!?]|$)/g, "$1*$2*");
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i) => `\`${code[Number(i)]}\``);
}
