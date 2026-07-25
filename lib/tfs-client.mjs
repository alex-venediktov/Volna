/**
 * Клиент TFS / on-prem Azure DevOps Server (REST `_apis/wit`, api-version 5.0).
 * Самодостаточный ESM: только node:fs и global fetch, никаких зависимостей и сборки.
 * Основа для bin/volna-tfs.mjs (W3). Подвохи API описаны в docs/reference/tfs-rest.md.
 *
 * Три вещи, на которых обжигаются все:
 *  - Auth: Basic от строки ":<PAT>" (пустой логин, PAT как пароль);
 *  - тело запроса слать UTF8-БАЙТАМИ, иначе кириллица бьется и сервер валит TF401319
 *    (это клиентская кодировка, НЕ права и НЕ правила поля);
 *  - System.Parent в обычном ответе пуст - связи читать через $expand=relations.
 */
import { readFileSync, existsSync } from "node:fs";

const utf8 = new TextEncoder();

// -- конфигурация -----------------------------------------------------------

/** Прочитать PAT из файла: срезать BOM (utf-8-sig) и края. Секрет - в файле, не в env. */
export function readPatFile(path, trim = true) {
  if (!existsSync(path)) throw new Error(`Файл PAT не найден: ${path} (см. TFS_PAT_FILE в .env)`);
  let s = readFileSync(path, "utf8");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // BOM (utf-8-sig)
  return trim ? s.trim() : s;
}

/**
 * Собрать конфиг из переменных окружения: TFS_BASE_URL, TFS_PAT_FILE, TFS_PROJECT,
 * TFS_API_VERSION. Значения PAT в env не держим - только путь к файлу.
 */
export function tfsConfigFromEnv(env = process.env) {
  const baseUrl = env.TFS_BASE_URL;
  const patFile = env.TFS_PAT_FILE;
  if (!baseUrl) throw new Error("Не задан TFS_BASE_URL (базовый URL коллекции TFS) - заполни .env");
  if (!patFile) throw new Error("Не задан TFS_PAT_FILE (путь к файлу с PAT) - заполни .env");
  return {
    baseUrl,
    project: env.TFS_PROJECT || undefined,
    pat: readPatFile(patFile),
    apiVersion: env.TFS_API_VERSION || "5.0",
  };
}

// -- клиент -----------------------------------------------------------------

export class TfsClient {
  /** cfg: { baseUrl, project?, pat, apiVersion?, fetchFn? }. fetchFn - инъекция для тестов офлайн. */
  constructor(cfg) {
    if (!cfg?.baseUrl) throw new Error("TFS baseUrl не задан (проверь TFS_BASE_URL)");
    if (!cfg?.pat) throw new Error("TFS PAT пуст (проверь файл из TFS_PAT_FILE)");
    this.base = cfg.baseUrl.replace(/\/+$/, "");
    this.project = cfg.project;
    this.api = cfg.apiVersion ?? "5.0";
    const auth = Buffer.from(`:${cfg.pat}`).toString("base64"); // Basic от ":<PAT>"
    this.headers = { Authorization: `Basic ${auth}` };
    this.doFetch = cfg.fetchFn ?? ((url, init) => fetch(url, init));
  }

  /** URL с api-version. */
  #url(path) {
    const sep = path.includes("?") ? "&" : "?";
    return `${this.base}${path}${sep}api-version=${this.api}`;
  }

  /** Префикс проекта для project-scoped эндпоинтов (wiql, создание, вложения). */
  #scoped() {
    return this.project ? `${this.base}/${this.project}` : this.base;
  }

  async #parse(res, method, url) {
    const raw = await res.text();
    if (!res.ok) {
      const hint = /TF401319/.test(raw) ? " (TF401319 - проверь UTF8-кодировку тела запроса)" : "";
      throw new Error(`TFS ${method} ${url} -> HTTP ${res.status}${hint}: ${raw.slice(0, 500)}`);
    }
    return raw ? JSON.parse(raw) : {};
  }

  async #getJson(path) {
    const url = this.#url(path);
    const res = await this.doFetch(url, { method: "GET", headers: this.headers });
    return this.#parse(res, "GET", url);
  }

  /** Тело - ВСЕГДА UTF8-байтами (иначе TF401319). */
  async #sendJson(method, path, body, contentType) {
    const url = this.#url(path);
    const res = await this.doFetch(url, {
      method,
      headers: { ...this.headers, "Content-Type": contentType },
      body: utf8.encode(JSON.stringify(body)),
    });
    return this.#parse(res, method, url);
  }

  /**
   * Проверка доступа для preflight: не бросает, возвращает статус. Позволяет отличить
   * истекший PAT (401), нехватку прав (403) и сетевую недоступность (status 0).
   */
  async verifyAccess() {
    const url = `${this.base}/_apis/projects?$top=1&api-version=${this.api}`;
    try {
      const res = await this.doFetch(url, { method: "GET", headers: this.headers });
      if (res.ok) return { ok: true, status: res.status };
      const raw = await res.text();
      return { ok: false, status: res.status, message: raw.slice(0, 200) };
    } catch (e) {
      return { ok: false, status: 0, message: e.message };
    }
  }

  // -- чтение ---------------------------------------------------------------

  /** Один work-item; связи (родитель/дети/PR/вложения) - только с expandRelations. */
  async getWorkItem(id, expandRelations = false) {
    const expand = expandRelations ? "?$expand=relations" : "";
    return this.#getJson(`/_apis/wit/workitems/${id}${expand}`);
  }

  /** Пакетное чтение, батчами по 200 (ограничение API). */
  async getWorkItems(ids, expandRelations = false) {
    const out = [];
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const expand = expandRelations ? "&$expand=relations" : "";
      const body = await this.#getJson(`/_apis/wit/workitems?ids=${batch.join(",")}${expand}`);
      out.push(...(body.value ?? []));
    }
    return out;
  }

  /** История/обсуждение: реальная постановка часто лежит здесь, а не в Description. */
  async getUpdates(id) {
    const body = await this.#getJson(`/_apis/wit/workItems/${id}/updates`);
    return body.value ?? [];
  }

  /** WIQL-запрос -> id найденных work-item. Эндпоинт project-scoped. */
  async wiql(query) {
    const url = `${this.#scoped()}/_apis/wit/wiql?api-version=${this.api}`;
    const res = await this.doFetch(url, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: utf8.encode(JSON.stringify({ query })),
    });
    const body = await this.#parse(res, "POST", url);
    return (body.workItems ?? []).map((w) => w.id);
  }

  /** Скачать вложение по его URL (нужен PAT: анонимно TFS отдаст 401). */
  async getAttachmentBytes(attachmentUrl) {
    const url = /api-version=/.test(attachmentUrl)
      ? attachmentUrl
      : `${attachmentUrl}${attachmentUrl.includes("?") ? "&" : "?"}api-version=${this.api}`;
    const res = await this.doFetch(url, { method: "GET", headers: this.headers });
    if (!res.ok) throw new Error(`TFS GET ${url} -> HTTP ${res.status} (скачивание вложения)`);
    return Buffer.from(await res.arrayBuffer());
  }

  // -- запись (внешнее и необратимое: только по подтверждению человека) ------

  /** Загрузить вложение -> { id, url }. Дальше url цепляется связью AttachedFile. */
  async uploadAttachment(fileName, bytes) {
    const url = `${this.#scoped()}/_apis/wit/attachments?fileName=${encodeURIComponent(fileName)}&api-version=${this.api}`;
    const res = await this.doFetch(url, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    const body = await this.#parse(res, "POST", url);
    return { id: String(body.id ?? ""), url: body.url ?? "" };
  }

  /** Создать work-item типа type ("Task", "Bug") из json-patch операций. */
  async createWorkItem(type, ops) {
    const prefix = this.project ? `/${this.project}` : "";
    return this.#sendJson("POST", `${prefix}/_apis/wit/workitems/$${type}`, ops, "application/json-patch+json");
  }

  /** Обновить поля/статус/связи существующего work-item. */
  async updateWorkItem(id, ops) {
    return this.#sendJson("PATCH", `/_apis/wit/workitems/${id}`, ops, "application/json-patch+json");
  }

  // -- составные операции записи --------------------------------------------

  /** Патч-операции из карты полей: { "System.Title": "..." } -> [{op,path,value}]. */
  fieldOps(fields) {
    return Object.entries(fields).map(([ref, value]) => ({ op: "add", path: `/fields/${ref}`, value }));
  }

  /** Создать дочернюю задачу-фикс под багом/стори: поля + связь с родителем. */
  async createChildTask(parentId, fields, type = "Task") {
    const ops = this.fieldOps(fields);
    ops.push({
      op: "add",
      path: "/relations/-",
      value: { rel: REL_PARENT, url: `${this.base}/_apis/wit/workItems/${parentId}` },
    });
    const wi = await this.createWorkItem(type, ops);
    return { id: String(wi.id), url: wi.url ?? "" };
  }

  /** Добавить связь между work-item (по умолчанию Related). */
  async linkWorkItem(id, targetId, rel = "System.LinkTypes.Related") {
    const ops = [{
      op: "add",
      path: "/relations/-",
      value: { rel, url: `${this.base}/_apis/wit/workItems/${targetId}` },
    }];
    const wi = await this.updateWorkItem(id, ops);
    return { id: String(wi.id) };
  }

  /** Комментарий в обсуждение: System.History принимает HTML, не Markdown. */
  async addComment(id, html) {
    const wi = await this.updateWorkItem(id, [{ op: "add", path: "/fields/System.History", value: html }]);
    return { id: String(wi.id) };
  }

  /**
   * Приложить файл к work-item; discussion:true - встроить картинку в обсуждение
   * (комментарий System.History с <img>), а не только приложить файлом.
   */
  async addAttachment(id, fileName, bytes, opts = {}) {
    const att = await this.uploadAttachment(fileName, bytes);
    const ops = [{
      op: "add",
      path: "/relations/-",
      value: { rel: "AttachedFile", url: att.url, attributes: opts.comment ? { comment: opts.comment } : {} },
    }];
    if (opts.discussion) {
      const isImg = /\.(png|jpe?g|gif|webp|bmp)$/i.test(fileName);
      const head = opts.comment ? `${escapeHtml(opts.comment)}<br/>` : "";
      const media = isImg
        ? `<img src="${att.url}" alt="${escapeHtml(fileName)}"/>`
        : `Вложение: ${escapeHtml(fileName)}`;
      ops.push({ op: "add", path: "/fields/System.History", value: head + media });
    }
    const wi = await this.updateWorkItem(id, ops);
    return { id: String(wi.id), url: att.url };
  }

  /** Скачать все вложения work-item; недоступные пропускаются (best-effort). */
  async downloadAttachments(id) {
    const wi = await this.getWorkItem(id, true);
    const rels = (wi.relations ?? []).filter((r) => r.rel === "AttachedFile");
    const out = [];
    for (const r of rels) {
      const name = String(r.attributes?.name ?? `attachment-${out.length + 1}`);
      try {
        out.push({ name, data: await this.getAttachmentBytes(r.url) });
      } catch {
        // недоступное вложение не должно ронять чтение задачи
      }
    }
    return out;
  }
}

// -- связи ------------------------------------------------------------------

const REL_PARENT = "System.LinkTypes.Hierarchy-Reverse";
const REL_CHILD = "System.LinkTypes.Hierarchy-Forward";

function idFromUrl(url) {
  return (url.split("/").pop() ?? "").trim();
}

/** id родителя (US для бага/задачи) из связей $expand=relations. */
export function parentId(wi) {
  const rel = wi.relations?.find((r) => r.rel === REL_PARENT);
  return rel ? idFromUrl(rel.url) : undefined;
}

/** id детей (подзадачи стори) из связей. */
export function childIds(wi) {
  return (wi.relations ?? []).filter((r) => r.rel === REL_CHILD).map((r) => idFromUrl(r.url));
}

/** Ссылки на PR из ArtifactLink-связей (сырые artifact-url, для отображения человеку). */
export function pullRequestLinks(wi) {
  return (wi.relations ?? [])
    .filter((r) => r.rel === "ArtifactLink" && /PullRequestId/i.test(r.url))
    .map((r) => r.url);
}

// -- поля и текст -----------------------------------------------------------

/**
 * Значение по точечному пути ("id" | "fields.System.Title").
 * Имена полей TFS содержат точки, но это ОДИН ключ (fields["System.Title"]), поэтому на
 * каждом уровне сперва пробуем остаток пути целиком, затем спускаемся рекурсией.
 */
export function getByPath(obj, path) {
  if (!path || obj == null || typeof obj !== "object") return undefined;
  if (path in obj) return obj[path];
  const dot = path.indexOf(".");
  if (dot === -1) return undefined;
  const child = obj[path.slice(0, dot)];
  if (child == null || typeof child !== "object") return undefined;
  return getByPath(child, path.slice(dot + 1));
}

/** Часто используемые поля work-item одной пачкой. */
export function summarize(wi) {
  const f = wi.fields ?? {};
  return {
    id: String(wi.id ?? ""),
    title: String(f["System.Title"] ?? ""),
    type: String(f["System.WorkItemType"] ?? ""),
    state: String(f["System.State"] ?? ""),
    area: String(f["System.AreaPath"] ?? ""),
    assignedTo: String(f["System.AssignedTo"]?.displayName ?? f["System.AssignedTo"] ?? ""),
    description: htmlToMarkdown(String(f["System.Description"] ?? "")),
    repro: htmlToMarkdown(String(f["Microsoft.VSTS.TCM.ReproSteps"] ?? "")),
    history: htmlToMarkdown(String(f["System.History"] ?? "")),
    parent: parentId(wi),
    children: childIds(wi),
  };
}

const ENTITIES = {
  "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'",
  "&mdash;": "—", "&ndash;": "–", "&laquo;": "«", "&raquo;": "»", "&hellip;": "…",
};

function decodeEntities(s) {
  return s
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos|mdash|ndash|laquo|raquo|hellip);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, "");
}

/**
 * HTML -> Markdown для чтения моделью: сохраняет ссылки и КАРТИНКИ (ожидаемый и фактический
 * результат в TFS часто именно в картинках), заголовки, списки, code; вырезает разметку.
 * Не строгий парсер - цель убрать шум, а не воспроизвести документ.
 */
export function htmlToMarkdown(html) {
  if (!html || !/[<&]/.test(html)) return (html ?? "").trim();
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<img\b([^>]*)>/gi, (_m, attrs) => {
    const src = /\bsrc="([^"]+)"/i.exec(attrs)?.[1] ?? "";
    const alt = /\balt="([^"]*)"/i.exec(attrs)?.[1] ?? "";
    return src ? `![${alt}](${src})` : "";
  });
  s = s.replace(/<a[^>]*?\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, txt) => `[${stripTags(txt).trim() || href}](${href})`);
  s = s.replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _h, t) => `\n\n## ${stripTags(t).trim()}\n\n`);
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `\n- ${stripTags(t).trim()}`);
  s = s.replace(/<(code|tt)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _c, t) => `\`${stripTags(t).trim()}\``);
  s = s.replace(/<\/(p|div|tr|table|ul|ol|h[1-6]|blockquote)>/gi, "\n\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/td>\s*<td[^>]*>/gi, " | ");
  s = stripTags(s);
  s = decodeEntities(s);
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

/** Экранировать текст для вставки в HTML-поле TFS. */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Markdown -> HTML для записи в многострочные поля TFS (Description, ReproSteps, History):
 * они рендерятся как HTML, и Markdown в них виден как текст. Однострочные поля (заголовок,
 * эстимация) писать простым текстом, без этой функции.
 */
export function markdownToTfsHtml(md) {
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let list = null;   // "ul" | "ol" | null
  let code = false;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const line of lines) {
    const fence = /^\s*```/.test(line);
    if (fence) {
      closeList();
      out.push(code ? "</code></pre>" : "<pre><code>");
      code = !code;
      continue;
    }
    if (code) { out.push(escapeHtml(line)); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 2, 6); // # -> h3: h1/h2 в TFS выглядят огромными
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline((ul ?? ol)[1])}</li>`);
      continue;
    }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    out.push(`<p>${inline(line.trim())}</p>`);
  }
  if (code) out.push("</code></pre>");
  closeList();
  return out.join("");
}

/** Инлайн-разметка внутри строки: код, жирный, курсив, ссылки. Экранирование - первым делом. */
function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|\s)\*([^*]+)\*/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}
