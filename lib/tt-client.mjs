/**
 * Клиент локального трекера task-tracker (MCP по Streamable HTTP) для «Волны». Самодостаточный
 * ESM на global fetch. Основа для bin/volna-tt.mjs. Подвохи - docs/reference/task-tracker-mcp.md.
 *
 * Четыре вещи, на которых обжигаются все:
 *  - сессии у сервера нет: каждый `tools/call` - отдельный POST JSON-RPC, `initialize` не нужен;
 *  - ошибка инструмента приходит с HTTP 200 и `isError: true` - по коду ответа её не видно;
 *  - адрес в сети без хоста не отказывает, а висит: без таймаута клиент ждёт бесконечно;
 *  - id задачи один на весь сервер, а не на проект: `feature-3` чужого проекта занимает номер.
 */

const utf8 = new TextEncoder();

/** Статусы сервера: набор постоянный, колонки доски (`tracker/model.py` сервера). */
export const TT_STATUSES = ["backlog", "todo", "doing", "review", "done"];

/** Вид задачи для флоу -> префикс id, который «Волна» даёт заводимой задаче. */
export const ID_PREFIXES = { bug: "bugfix", task: "feature", story: "feature", research: "research" };

/** Id, заведённый «Волной»: префикс вида, дефис, номер. */
export const PREFIXED_ID = /^(bugfix|feature|research)-(\d+)$/i;

/** Таймаут запроса по умолчанию, мс: дольше висящий сервер считается недоступным. */
export const DEFAULT_TIMEOUT_MS = 5000;

// -- конфигурация -----------------------------------------------------------

/** Конфиг из переменных окружения: адрес MCP и проект обязательны, таймаут - нет. */
export function ttConfigFromEnv(env = process.env) {
  const url = env.TT_MCP_URL;
  const project = env.TT_PROJECT;
  if (!url || !project) {
    const missing = [!url && "TT_MCP_URL", !project && "TT_PROJECT"].filter(Boolean).join(", ");
    throw new Error(`Не заданы переменные task-tracker: ${missing} (см. .env)`);
  }
  const timeout = Number(env.TT_TIMEOUT_MS);
  return { url, project, timeoutMs: timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS };
}

// -- id и вид задачи ----------------------------------------------------------

/** Префикс id по виду задачи; принимает и сам префикс. Неизвестный вид - null. */
export function prefixFor(kind) {
  const k = String(kind ?? "").trim().toLowerCase();
  if (ID_PREFIXES[k]) return ID_PREFIXES[k];
  return Object.values(ID_PREFIXES).includes(k) ? k : null;
}

/** Вид задачи для флоу: по префиксу id, без него - по тегу, иначе task (у сервера типа нет). */
export function taskKind(task) {
  const m = PREFIXED_ID.exec(String(task?.id ?? ""));
  if (m) {
    const prefix = m[1].toLowerCase();
    return prefix === "bugfix" ? "bug" : prefix === "feature" ? "task" : "research";
  }
  const tags = (task?.tags ?? []).map((t) => String(t).toLowerCase());
  if (tags.includes("bug")) return "bug";
  if (tags.includes("research")) return "research";
  return "task";
}

/** Следующий номер: наибольший среди голых номеров и id с префиксом вида, плюс 1. */
export function nextNumber(ids) {
  let max = 0;
  for (const raw of ids) {
    const id = String(raw);
    const m = PREFIXED_ID.exec(id);
    const n = m ? Number(m[2]) : /^\d+$/.test(id) ? Number(id) : 0;
    if (n > max) max = n;
  }
  return max + 1;
}

// -- ответ сервера ------------------------------------------------------------

/** Ошибка трекера: status 0 - сервер не ответил, "tool" - отказ инструмента, иначе код HTTP. */
export class TtError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Тело ответа JSON-RPC: обычный JSON либо поток SSE, где сообщение - в строке `data:`. */
export function parseRpcBody(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (text.startsWith("{")) return JSON.parse(text);
  const data = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  return data.length ? JSON.parse(data[data.length - 1]) : null;
}

/** Результат инструмента: `structuredContent.result`, иначе текст `content` (JSON либо строка). */
export function toolResult(result) {
  if (result?.isError) {
    const text = (result.content ?? []).map((c) => c?.text).filter(Boolean).join(" ").trim();
    throw new TtError(text || "инструмент вернул ошибку без текста", "tool");
  }
  const structured = result?.structuredContent;
  if (structured && typeof structured === "object" && "result" in structured) return structured.result;
  if (structured !== undefined && structured !== null) return structured;
  const text = (result?.content ?? []).map((c) => c?.text ?? "").join("");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// -- клиент -----------------------------------------------------------------

export class TaskTrackerClient {
  #seq = 0;

  /** cfg: { url, project, timeoutMs?, fetchFn? }. */
  constructor(cfg) {
    if (!cfg?.url) throw new Error("Адрес task-tracker не задан (проверь TT_MCP_URL)");
    if (!cfg?.project) throw new Error("Проект task-tracker не задан (проверь TT_PROJECT)");
    this.url = String(cfg.url);
    this.project = cfg.project;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.doFetch = cfg.fetchFn ?? ((url, init) => fetch(url, init));
  }

  /** Вызов инструмента: POST `tools/call`, свой проект - заголовком X-Project. */
  async callTool(name, args = {}) {
    const body = { jsonrpc: "2.0", id: ++this.#seq, method: "tools/call", params: { name, arguments: args } };
    const init = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-Project": this.project,
      },
      body: utf8.encode(JSON.stringify(body)),
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    let res;
    let raw;
    try {
      res = await this.doFetch(this.url, init);
      raw = typeof res.text === "function" ? await res.text() : "";
    } catch (e) {
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      throw new TtError(timedOut
        ? `сервер ${this.url} недоступен: не ответил за ${this.timeoutMs} мс`
        : `сервер ${this.url} недоступен: ${e?.cause?.code ?? e?.message ?? e}`, 0);
    }
    if (!res.ok) throw new TtError(`task-tracker ${name} -> HTTP ${res.status}: ${String(raw).slice(0, 300)}`, res.status);
    let message;
    try {
      message = parseRpcBody(raw);
    } catch {
      throw new TtError(`task-tracker ${name}: ответ не JSON-RPC: ${String(raw).slice(0, 300)}`, res.status);
    }
    if (message?.error) throw new TtError(`task-tracker ${name}: ${message.error.message ?? JSON.stringify(message.error)}`, "rpc");
    return toolResult(message?.result);
  }

  /** Проверка доступа для doctor: не бросает; ok - сервер ответил и знает инструменты. */
  async verifyAccess() {
    try {
      const projects = await this.listProjects();
      return { ok: true, status: 200, projects: Array.isArray(projects) ? projects : [] };
    } catch (e) {
      return { ok: false, status: e?.status ?? 0, projects: [], body: String(e?.message ?? e) };
    }
  }

  async listProjects() {
    return this.callTool("list_projects");
  }

  /** Задачи кратко; без project - свой проект. */
  async listTasks({ project, status, tag } = {}) {
    const args = {};
    if (project) args.project = project;
    if (status) args.status = status;
    if (tag) args.tag = tag;
    return this.callTool("list_tasks", args);
  }

  async getTask(id) {
    return this.callTool("get_task", { task_id: String(id) });
  }

  async createTask({ title, body, status, tags, taskId }) {
    const args = { title };
    if (body) args.body = body;
    if (status) args.status = status;
    if (tags?.length) args.tags = tags;
    if (taskId) args.task_id = taskId;
    return this.callTool("create_task", args);
  }

  /** Переданное поле сервер заменяет целиком. */
  async updateTask(id, fields) {
    return this.callTool("update_task", { task_id: String(id), ...fields });
  }

  async moveTask(id, status) {
    return this.callTool("move_task", { task_id: String(id), status });
  }

  async commentTask(id, text) {
    return this.callTool("comment_task", { task_id: String(id), text });
  }

  /** Id новой задачи вида kind: номер - наибольший по всем проектам сервера плюс 1. */
  async nextId(kind) {
    const prefix = prefixFor(kind);
    if (!prefix) throw new TtError(`вид «${kind}» неизвестен: ${Object.keys(ID_PREFIXES).join(", ")}`, "tool");
    const projects = await this.listProjects();
    const ids = [];
    for (const p of projects ?? []) {
      const tasks = await this.listTasks({ project: p.project });
      for (const t of tasks ?? []) ids.push(t.id);
    }
    return `${prefix}-${nextNumber(ids)}`;
  }
}
