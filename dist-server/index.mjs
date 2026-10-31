// server/env.ts
import fs from "node:fs";
import path from "node:path";
var file = path.resolve(process.cwd(), ".env");
if (fs.existsSync(file)) {
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    if (key && value && process.env[key] === void 0) process.env[key] = value;
  }
  console.log("Loaded settings from .env");
}

// server/index.ts
import http from "node:http";
import fs3 from "node:fs";
import path3 from "node:path";
import crypto2 from "node:crypto";
import zlib2 from "node:zlib";

// server/ai.ts
var env = (k) => (process.env[k] || "").trim();
async function listOpenAiModels(p) {
  const res = await fetch(`${p.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${p.apiKey}` },
    signal: AbortSignal.timeout(15e3)
  });
  if (!res.ok) throw new Error(`${p.name} /models -> ${res.status}`);
  const data = await res.json();
  return (data?.data || []).map((m) => String(m.id));
}
function rankByPatterns(ids, patterns, exclude) {
  const out = [];
  for (const pat of patterns) {
    for (const id of ids.filter((i) => pat.test(i) && !exclude.test(i)).sort().reverse()) {
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}
async function discoverGemini(p) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(p.apiKey)}`,
    { signal: AbortSignal.timeout(15e3) }
  );
  if (!res.ok) throw new Error(`gemini models -> ${res.status} ${await res.text().catch(() => "")}`);
  const data = await res.json();
  const ids = (data?.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => String(m.name).replace(/^models\//, ""));
  const exclude = /(image|tts|audio|live|embed|vision|learnlm|gemma|robotics|computer|native|exp-\d|customtools)/i;
  const ranked = rankByPatterns(
    ids,
    [/^gemini-[\d.]+-flash$/i, /^gemini-flash-latest$/i, /^gemini-[\d.]+-flash-lite$/i, /^gemini-flash-lite-latest$/i, /flash/i],
    exclude
  );
  return ranked.length ? ranked : ["gemini-flash-latest", "gemini-2.5-flash"];
}
async function discoverGroq(p) {
  const ids = await listOpenAiModels(p);
  const ranked = rankByPatterns(
    ids,
    [/llama-3\.3-70b/i, /gpt-oss-120b/i, /llama-4/i, /qwen/i, /gpt-oss/i, /llama/i],
    /(guard|whisper|tts|playai|compound|prompt)/i
  );
  return ranked.length ? ranked : ["llama-3.3-70b-versatile"];
}
async function discoverOpenRouter(p) {
  const ids = await listOpenAiModels(p);
  const free = ids.filter((i) => i.endsWith(":free"));
  const ranked = rankByPatterns(free, [/llama-3\.3-70b/i, /deepseek/i, /qwen/i, /gemini/i, /llama/i, /./], /(vision|vl-)/i);
  return ranked.length ? ranked : ["meta-llama/llama-3.3-70b-instruct:free"];
}
function buildProviders() {
  const list = [];
  const add = (p) => list.push({ ...p, modelIndex: 0, cooldownUntil: 0 });
  if (env("GEMINI_API_KEY")) {
    add({
      name: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: env("GEMINI_API_KEY"),
      fixedModel: env("GEMINI_MODEL") || null,
      discover: discoverGemini,
      jsonMode: true
    });
  }
  if (env("GROQ_API_KEY")) {
    add({
      name: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: env("GROQ_API_KEY"),
      fixedModel: env("GROQ_MODEL") || null,
      discover: discoverGroq,
      jsonMode: true
    });
  }
  if (env("OPENROUTER_API_KEY")) {
    add({
      name: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: env("OPENROUTER_API_KEY"),
      fixedModel: env("OPENROUTER_MODEL") || null,
      discover: discoverOpenRouter,
      jsonMode: false
    });
  }
  if (env("HF_TOKEN")) {
    add({
      name: "huggingface",
      baseUrl: "https://router.huggingface.co/v1",
      apiKey: env("HF_TOKEN"),
      fixedModel: env("HF_MODEL") || "meta-llama/Llama-3.3-70B-Instruct",
      discover: async () => ["meta-llama/Llama-3.3-70B-Instruct"],
      jsonMode: false
    });
  }
  if (env("AI_BASE_URL") && env("AI_MODEL")) {
    add({
      name: "custom",
      baseUrl: env("AI_BASE_URL").replace(/\/+$/, ""),
      apiKey: env("AI_API_KEY"),
      fixedModel: env("AI_MODEL"),
      discover: async () => [env("AI_MODEL")],
      jsonMode: false
    });
  }
  return list;
}
var providers = null;
function getProviders() {
  if (!providers) providers = buildProviders();
  return providers;
}
function aiProviderNames() {
  return getProviders().map((p) => p.name);
}
function aiConfigured() {
  return getProviders().length > 0;
}
async function ensureModels(p) {
  if (p.models && p.models.length) return p.models;
  if (p.fixedModel) {
    p.models = [p.fixedModel];
    return p.models;
  }
  try {
    p.models = (await p.discover(p)).slice(0, 6);
  } catch (e) {
    console.warn(`[ai] model discovery failed for ${p.name}: ${e?.message}`);
    p.models = [];
  }
  return p.models;
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var AiError = class extends Error {
};
async function chat(messages, opts = {}) {
  const list = getProviders();
  if (!list.length) {
    throw new AiError(
      "No AI key configured. Add GEMINI_API_KEY (free at aistudio.google.com, no card) or GROQ_API_KEY (free at console.groq.com) in Railway \u2192 Variables."
    );
  }
  const errors = [];
  const COOLDOWN_MS = Number(env("AI_COOLDOWN_MS") || 15e3);
  const deadline = Date.now() + Number(env("AI_MAX_WAIT_MS") || 18e4);
  for (let pass = 0; pass < 8 && Date.now() < deadline; pass++) {
    if (pass > 0) {
      const now = Date.now();
      const soonest = Math.min(...list.map((p) => Math.max(p.cooldownUntil, now)));
      const wait = Math.min(Math.max(soonest - now, Math.min(5e3, COOLDOWN_MS)), 6e4, Math.max(deadline - now, 0));
      if (wait > 0) await sleep(wait);
    }
    for (const p of list) {
      if (p.cooldownUntil > Date.now()) continue;
      const models = await ensureModels(p);
      if (!models.length) {
        errors.push(`${p.name}: no usable model`);
        continue;
      }
      for (let attempt = 0; attempt < models.length; attempt++) {
        const model = models[(p.modelIndex + attempt) % models.length];
        try {
          const body = {
            model,
            messages,
            temperature: opts.temperature ?? 0.3,
            max_tokens: opts.maxTokens ?? 4e3
          };
          if (opts.json && p.jsonMode) body.response_format = { type: "json_object" };
          const headers = { "Content-Type": "application/json" };
          if (p.apiKey) headers.Authorization = `Bearer ${p.apiKey}`;
          if (p.name === "openrouter") {
            headers["HTTP-Referer"] = env("APP_URL") || "https://railway.app";
            headers["X-Title"] = "SafeCart Kids Investor Agent";
          }
          const res = await fetch(`${p.baseUrl}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(12e4)
          });
          if (res.status === 429 || res.status === 503 || res.status === 529) {
            const retryAfter = Number(res.headers.get("retry-after")) || 0;
            const txt = await res.text().catch(() => "");
            errors.push(`${p.name}/${model}: ${res.status} ${res.status === 429 ? "rate limited" : "busy"}`);
            if (res.status !== 429) {
              if (attempt === models.length - 1) p.cooldownUntil = Date.now() + COOLDOWN_MS;
              continue;
            }
            const daily = /per.?day|daily|PerDay|RPD|TPD/i.test(txt) && !/per.?minute|PerMinute|RPM|TPM/i.test(txt);
            if (daily) {
              p.modelIndex = (p.modelIndex + 1) % models.length;
              if (attempt === models.length - 1) p.cooldownUntil = Date.now() + 10 * 6e4;
              continue;
            }
            p.cooldownUntil = Date.now() + Math.min(Math.max(retryAfter * 1e3, COOLDOWN_MS), 6e4);
            break;
          }
          if (res.status === 404 || res.status === 400) {
            const txt = await res.text().catch(() => "");
            if (res.status === 400 && opts.json && p.jsonMode && /response_format|json/i.test(txt)) {
              p.jsonMode = false;
              attempt--;
              continue;
            }
            errors.push(`${p.name}/${model}: ${res.status} ${txt.slice(0, 160)}`);
            continue;
          }
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            errors.push(`${p.name}/${model}: ${res.status} ${txt.slice(0, 160)}`);
            if (res.status === 401 || res.status === 403) break;
            continue;
          }
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content ?? "";
          if (!text.trim()) {
            errors.push(`${p.name}/${model}: empty response`);
            continue;
          }
          p.modelIndex = (p.modelIndex + attempt) % models.length;
          return { text, provider: p.name, model };
        } catch (e) {
          errors.push(`${p.name}/${model}: ${e?.name === "TimeoutError" ? "timeout" : e?.message}`);
        }
      }
    }
  }
  throw new AiError(`All AI providers failed: ${errors.slice(-6).join(" | ")}`);
}
function extractJson(text) {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  t = t.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(t);
  } catch {
  }
  const firstObj = t.indexOf("{");
  const firstArr = t.indexOf("[");
  const start = firstArr !== -1 && (firstObj === -1 || firstArr < firstObj) ? firstArr : firstObj;
  if (start === -1) throw new AiError("AI did not return JSON");
  const open = t[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        const slice = t.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return JSON.parse(slice.replace(/,\s*([}\]])/g, "$1"));
        }
      }
    }
  }
  throw new AiError("AI returned truncated JSON");
}
async function chatJson(system, user, maxTokens = 4e3) {
  const messages = [
    { role: "system", content: `${system}

Respond with ONE valid JSON object only. No markdown, no commentary.` },
    { role: "user", content: user }
  ];
  const first = await chat(messages, { json: true, maxTokens });
  try {
    return extractJson(first.text);
  } catch {
    const second = await chat(
      [
        ...messages,
        { role: "assistant", content: first.text.slice(0, 2e3) },
        { role: "user", content: "That was not valid JSON. Reply again with ONLY the complete, valid JSON object." }
      ],
      { json: true, maxTokens, temperature: 0.1 }
    );
    return extractJson(second.text);
  }
}

// server/search.ts
var env2 = (k) => (process.env[k] || "").trim();
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
function searchProviderNames() {
  const out = [];
  if (env2("TAVILY_API_KEY")) out.push("tavily");
  if (env2("SERPER_API_KEY")) out.push("serper");
  if (env2("DISABLE_DUCKDUCKGO") !== "true") out.push("duckduckgo");
  return out;
}
var disabledUntil = {};
function decodeEntities(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
function splitSiteOperator(q) {
  const m = q.match(/site:(\S+)/i);
  if (!m) return { query: q };
  return { query: q.replace(m[0], "").trim(), domain: m[1] };
}
async function tavily(query, max, page = 1) {
  if (page > 1) return [];
  const { query: q, domain } = splitSiteOperator(query);
  const body = { query: domain ? `${q} ${domain.includes("linkedin") ? "LinkedIn" : ""}`.trim() : q, max_results: Math.min(max, 20), search_depth: "basic" };
  if (domain) body.include_domains = [domain.replace(/\/.*$/, "")];
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env2("TAVILY_API_KEY")}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25e3)
  });
  if (!res.ok) throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const data = await res.json();
  let results = (data?.results || []).map((r) => ({
    title: String(r.title || ""),
    url: String(r.url || ""),
    snippet: String(r.content || "").slice(0, 600),
    engine: "tavily"
  }));
  if (domain && domain.includes("/")) {
    const path4 = domain.slice(domain.indexOf("/"));
    results = results.filter((r) => r.url.includes(path4));
  }
  return results;
}
async function serper(query, max, page = 1) {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": env2("SERPER_API_KEY") },
    body: JSON.stringify(page > 1 ? { q: query, num: Math.min(max, 20), page } : { q: query, num: Math.min(max, 20) }),
    signal: AbortSignal.timeout(2e4)
  });
  if (!res.ok) throw new Error(`serper ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const data = await res.json();
  return (data?.organic || []).map((r) => ({
    title: String(r.title || ""),
    url: String(r.link || ""),
    snippet: String(r.snippet || ""),
    engine: "serper"
  }));
}
function parseDuckDuckGoHtml(html) {
  const out = [];
  const blocks = html.split(/class="result results_links|class="result results_links_deep|class="result /).slice(1);
  for (const b of blocks) {
    const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let href = a[1].replace(/&amp;/g, "&");
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith("//")) href = "https:" + href;
    if (!/^https?:\/\//.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue;
    const sn = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    out.push({ title: decodeEntities(a[2]), url: href, snippet: sn ? decodeEntities(sn[1]) : "", engine: "duckduckgo" });
  }
  return out;
}
async function duckduckgo(query, max, page = 1) {
  if (page > 1) return [];
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, Accept: "text/html" },
    body: new URLSearchParams({ q: query, kl: "us-en" }).toString(),
    signal: AbortSignal.timeout(2e4)
  });
  if (!res.ok) throw new Error(`duckduckgo ${res.status}`);
  const html = await res.text();
  if (/anomaly-modal|captcha|challenge/i.test(html) && !/result__a/.test(html)) throw new Error("duckduckgo rate-limited (captcha)");
  return parseDuckDuckGoHtml(html).slice(0, max);
}
var engines = { tavily, serper, duckduckgo };
async function webSearch(query, max = 10, page = 1) {
  const errors = [];
  for (const name of searchProviderNames()) {
    if ((disabledUntil[name] || 0) > Date.now()) continue;
    try {
      const results = (await engines[name](query, max, page)).filter((r) => r.url);
      if (results.length) return { results, engine: name, errors };
      errors.push(`${name}: 0 results`);
    } catch (e) {
      const msg = String(e?.message || e);
      errors.push(`${name}: ${msg}`);
      if (/\b(401|402|403|432|433)\b|credits|quota|limit/i.test(msg)) disabledUntil[name] = Date.now() + 36e5;
      else if (/captcha|rate/i.test(msg)) disabledUntil[name] = Date.now() + 6e5;
    }
  }
  return { results: [], engine: "none", errors };
}
function normalizeLinkedInUrl(url) {
  const m = url.match(/linkedin\.com\/(in|company|pub)\/([^/?#]+)/i);
  if (!m) return "";
  return `https://www.linkedin.com/${m[1].toLowerCase()}/${decodeURIComponent(m[2])}`;
}
function isLinkedInProfile(url) {
  return /linkedin\.com\/(in|pub)\//i.test(url);
}

// server/gmail.ts
import zlib from "node:zlib";
var env3 = (k) => (process.env[k] || "").trim();
var secret = () => env3("GMAIL_SCRIPT_SECRET").replace(/^['"]+|['"]+$/g, "").trim();
function isSetupError(msg) {
  return /wrong secret|set secret|old version|unknown action|web page instead|not set up|not reachable|authoriz|permission/i.test(msg);
}
function explain(msg) {
  if (/Wrong secret/i.test(msg))
    return "Gmail helper: Wrong secret \u2014 GMAIL_SCRIPT_SECRET on your server is not exactly the same as the SECRET line in your Google script. Copy the same password into both (no spaces, no quotes), then Deploy \u2192 Manage deployments \u2192 Edit \u2192 New version in the script.";
  if (/Set SECRET/i.test(msg)) return "Gmail helper: the script still has CHANGE-ME on its SECRET line \u2014 put your password there, Save, and deploy a New version.";
  return msg;
}
function gmailConfigured() {
  return /^https:\/\/script\.google\.com\/.+\/exec$/.test(env3("GMAIL_SCRIPT_URL")) && !!env3("GMAIL_SCRIPT_SECRET");
}
async function call(payload, timeoutMs = 6e4) {
  if (!gmailConfigured()) throw new Error("Gmail helper not set up (GMAIL_SCRIPT_URL / GMAIL_SCRIPT_SECRET).");
  const res = await fetch(env3("GMAIL_SCRIPT_URL"), {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ ...payload, secret: secret() }),
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      /<html|<!doctype/i.test(text) ? 'Gmail helper returned a web page instead of data \u2014 redeploy it with "Who has access: Anyone".' : `Gmail helper error ${res.status}`
    );
  }
  if (!data.ok) throw new Error(explain(`Gmail helper: ${data.error || "failed"}`));
  return data;
}
async function gmailSend(to, subject, body, opts = {}) {
  try {
    const r = await call({ action: "send", to, subject, body, replyTo: opts.replyTo, fromName: opts.fromName, label: opts.label });
    return { ok: true, threadId: r.threadId, remaining: r.remaining };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
async function gmailCheck(emails, days = 60, tags = {}) {
  const r = await call({ action: "check", emails, days, tags }, 12e4);
  return { replies: r.replies || [], accepted: r.accepted || [], remaining: r.remaining };
}
async function gmailQuota() {
  try {
    return (await call({ action: "quota" }, 2e4)).remaining;
  } catch {
    return void 0;
  }
}
async function gmailSheet(title, tabs) {
  try {
    const r = await call({ action: "sheet", title, tabs, tab: tabs[0]?.name, headers: tabs[0]?.headers, rows: tabs[0]?.rows }, 18e4);
    return { url: r.url, rows: r.rows, tabs: r.tabs || 1 };
  } catch (e) {
    const msg = String(e?.message || e);
    if (/Unknown action/i.test(msg))
      throw new Error("your Gmail helper script is an old version. Paste the new google-apps-script/Code.gs on script.google.com, put your SECRET back, Save, then Deploy \u2192 Manage deployments \u2192 Edit \u2192 New version \u2192 Deploy.");
    if (/permission|authoriz|scopes|SpreadsheetApp|not have access/i.test(msg))
      throw new Error("the Gmail helper script needs permission to create Google Sheets. On script.google.com choose doGet \u2192 \u25B6 Run \u2192 Allow, then Deploy \u2192 Manage deployments \u2192 Edit \u2192 New version \u2192 Deploy.");
    if (/web page instead of data/i.test(msg)) throw new Error('the Gmail helper is not reachable \u2014 in its deployment, "Who has access" must be "Anyone".');
    throw new Error(msg.replace(/^Gmail helper:\s*/, ""));
  }
}
async function gmailTest() {
  if (!gmailConfigured()) return { ok: false, message: "GMAIL_SCRIPT_URL and/or GMAIL_SCRIPT_SECRET are missing in your server variables." };
  try {
    const r = await call({ action: "quota" }, 2e4);
    const v = Number(r.version || 1);
    scriptVersion = v;
    if (v < 5)
      return { ok: false, version: v, message: `Connected and the password is right, but the script is an old version (v${v}). Paste the new Code.gs, put your SECRET back, Save, run doGet \u2192 Allow, then Deploy \u2192 Manage deployments \u2192 Edit \u2192 New version.` };
    return { ok: true, version: v, message: `Connected \u2014 password correct, script up to date (v${v}). Gmail can still send ${r.remaining} emails today.` };
  } catch (e) {
    const msg = String(e?.message || e);
    if (/Wrong secret/i.test(msg))
      return {
        ok: false,
        message: `Wrong secret. The password on this server has ${secret().length} characters. Open your GMAIL_SCRIPT_URL in a browser: it shows "passwordLength" and "version" of the LIVE script. If the version is missing or below 5, the link runs an old copy \u2014 deploy a New version (or put the newest deployment's URL in GMAIL_SCRIPT_URL). If the lengths differ, the passwords differ.`
      };
    return { ok: false, message: msg };
  }
}
var scriptVersion = 0;
async function driveSave(name, content) {
  try {
    if (!scriptVersion) {
      try {
        scriptVersion = Number((await call({ action: "quota" }, 2e4)).version || 1);
      } catch {
        scriptVersion = 0;
      }
    }
    if (scriptVersion >= 5) {
      await call({ action: "saveData", name, encoding: "gzip-base64", content: zlib.gzipSync(content, { level: 9 }).toString("base64") }, 12e4);
      return;
    }
    await call({ action: "saveData", name, content }, 12e4);
  } catch (e) {
    if (/Unknown action/i.test(String(e?.message))) throw new Error("Gmail helper script is an old version \u2014 paste the new Code.gs and deploy a new version.");
    throw e;
  }
}
async function driveLoad(name) {
  try {
    const r = await call({ action: "loadData", name }, 12e4);
    return { exists: !!r.exists, content: r.content };
  } catch (e) {
    if (/Unknown action/i.test(String(e?.message))) throw new Error("Gmail helper script is an old version \u2014 paste the new Code.gs and deploy a new version.");
    throw e;
  }
}

// server/email.ts
var env4 = (k) => (process.env[k] || "").trim();
function emailProvider() {
  if (gmailConfigured()) return "gmail";
  return env4("BREVO_API_KEY") && env4("SENDER_EMAIL") ? "brevo" : "none";
}
async function sendEmail(to, subject, body, replyTo, fromName, label) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { ok: false, error: "Invalid recipient email" };
  if (emailProvider() === "gmail") {
    const r = await gmailSend(to, subject, body, { replyTo, fromName, label });
    return r.ok ? { ok: true, id: r.threadId } : { ok: false, error: r.error };
  }
  if (emailProvider() !== "brevo") return { ok: false, error: "No email sender set up (add the Gmail helper script, or BREVO_API_KEY + SENDER_EMAIL)." };
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "api-key": env4("BREVO_API_KEY") },
    body: JSON.stringify({
      sender: { email: env4("SENDER_EMAIL"), name: fromName || env4("SENDER_NAME") || void 0 },
      to: [{ email: to }],
      replyTo: replyTo ? { email: replyTo } : void 0,
      subject,
      textContent: body
    }),
    signal: AbortSignal.timeout(2e4)
  });
  const txt = await res.text();
  if (!res.ok) return { ok: false, error: `Brevo ${res.status}: ${txt.slice(0, 200)}` };
  try {
    return { ok: true, id: JSON.parse(txt).messageId };
  } catch {
    return { ok: true };
  }
}

// server/store.ts
import crypto from "node:crypto";
import fs2 from "node:fs";
import path2 from "node:path";
var DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path2.resolve(process.cwd(), "data");
var FILE = path2.join(DATA_DIR, "crm.json");
var cache = null;
var writeTimer = null;
var BACKUP_NAME = "crm.json";
var BACKUP_EVERY_MS = () => Number(process.env.DRIVE_BACKUP_EVERY_MS || 6e5);
var lastBackupHash = "";
var backupTimer = null;
var backupBlocked = false;
var lastBackupAt = "";
var lastBackupError = "";
function backupEnabled() {
  const want = process.env.DRIVE_BACKUP ? /^(1|true|yes|on)$/i.test(process.env.DRIVE_BACKUP) : Boolean(process.env.RENDER);
  return want && gmailConfigured();
}
function storageInfo() {
  const drive = backupEnabled();
  return {
    path: drive ? `Google Drive backup (folder "SafeCart Agent Data")${lastBackupAt ? ` \xB7 last saved ${lastBackupAt.slice(11, 16)} UTC` : ""}${backupBlocked ? " \xB7 WAITING to read the backup" : ""}${lastBackupError ? ` \xB7 last error: ${lastBackupError.slice(0, 80)}` : ""}` : FILE,
    persistent: drive ? !backupBlocked : Boolean(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH) || !(process.env.RAILWAY_ENVIRONMENT || process.env.RENDER)
  };
}
function hasData(st) {
  return !!st && (st.investors?.length > 0 || !!st.startup || !!st.settings);
}
function mergeBackup(b) {
  const st = loadState();
  for (const k of ["startup", "settings", "campaign", "automation"]) if (!st[k] || k === "automation" && !Object.keys(st.automation || {}).length) st[k] = b[k];
  st.usedQueries = [.../* @__PURE__ */ new Set([...b.usedQueries || [], ...st.usedQueries || []])].slice(-3e3);
  st.deletedIds = [.../* @__PURE__ */ new Set([...b.deletedIds || [], ...st.deletedIds || []])].slice(-5e3);
  mergeInvestors(b.investors || []);
}
async function readBackup() {
  const r = await driveLoad(BACKUP_NAME);
  if (!r.exists || !r.content) return "none";
  const b = JSON.parse(r.content);
  if (!Array.isArray(b.investors)) b.investors = [];
  const local = loadState();
  if (!hasData(local)) {
    cache = b;
    loadState();
    flush();
    return "restored";
  }
  mergeBackup(b);
  lastBackupHash = contentHash(b);
  return "kept-local";
}
async function restoreFromBackup() {
  if (!backupEnabled()) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await readBackup();
      console.log(`[store] Google Drive backup: ${r === "restored" ? `restored ${loadState().investors.length} contacts` : r === "none" ? "none yet \u2014 a new one will be made" : "merged with the data on disk"}`);
      backupBlocked = false;
      return;
    } catch (e) {
      lastBackupError = String(e?.message || e);
      console.error(`[store] could not read the Google Drive backup (try ${attempt}/3): ${lastBackupError}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 5e3));
    }
  }
  backupBlocked = true;
  const retry = setInterval(async () => {
    try {
      await readBackup();
      backupBlocked = false;
      lastBackupError = "";
      clearInterval(retry);
      console.log("[store] Google Drive backup read \u2014 backups are on again.");
      scheduleBackup();
    } catch (e) {
      lastBackupError = String(e?.message || e);
    }
  }, 12e4);
  retry.unref();
}
function contentHash(st) {
  const auto = { ...st.automation || {} };
  delete auto.lastRunAt;
  delete auto.lastCheckAt;
  const { updatedAt: _u, ...rest } = st;
  return crypto.createHash("sha1").update(JSON.stringify({ ...rest, automation: auto })).digest("hex");
}
async function backupNow() {
  if (!backupEnabled() || backupBlocked || !cache) return;
  if (backupTimer) {
    clearTimeout(backupTimer);
    backupTimer = null;
  }
  try {
    const body = JSON.stringify(cache);
    const hash = contentHash(cache);
    if (hash === lastBackupHash) return;
    await driveSave(BACKUP_NAME, body);
    lastBackupHash = hash;
    lastBackupAt = (/* @__PURE__ */ new Date()).toISOString();
    lastBackupError = "";
  } catch (e) {
    lastBackupError = String(e?.message || e);
    console.error("[store] Google Drive backup failed:", lastBackupError);
    scheduleBackup();
  }
}
function scheduleBackup() {
  if (!backupEnabled() || backupBlocked || backupTimer) return;
  backupTimer = setTimeout(() => {
    backupTimer = null;
    void backupNow();
  }, BACKUP_EVERY_MS());
  backupTimer.unref?.();
}
async function shutdownSave() {
  flushNow();
  if (backupEnabled() && (backupTimer || !lastBackupAt)) await Promise.race([backupNow(), new Promise((r) => setTimeout(r, 8e3))]);
}
function loadState() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs2.readFileSync(FILE, "utf8"));
  } catch {
    cache = { startup: null, investors: [], settings: null, updatedAt: "" };
  }
  if (!Array.isArray(cache.investors)) cache.investors = [];
  if (!Array.isArray(cache.usedQueries)) cache.usedQueries = [];
  if (!Array.isArray(cache.deletedIds)) cache.deletedIds = [];
  if (!cache.automation) cache.automation = {};
  return cache;
}
function flush() {
  try {
    fs2.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + ".tmp";
    fs2.writeFileSync(tmp, JSON.stringify(cache));
    fs2.renameSync(tmp, FILE);
  } catch (e) {
    console.error("[store] write failed:", e?.message);
  }
  scheduleBackup();
}
function scheduleFlush() {
  cache.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 300);
}
var time = (x) => Date.parse(x?.updatedAt || x?.createdAt || "") || 0;
function mergeInvestors(incoming, deletedIds = []) {
  const st = loadState();
  if (deletedIds.length) {
    const del = new Set(deletedIds);
    st.investors = st.investors.filter((i) => !del.has(i.id));
    st.deletedIds = [.../* @__PURE__ */ new Set([...st.deletedIds || [], ...deletedIds])].slice(-5e3);
  }
  const deleted = new Set(st.deletedIds || []);
  const byId = new Map(st.investors.map((i) => [i.id, i]));
  for (const inv of incoming || []) {
    if (!inv?.id || deleted.has(inv.id)) continue;
    const cur = byId.get(inv.id);
    if (!cur || time(inv) >= time(cur)) byId.set(inv.id, inv);
  }
  st.investors = [...byId.values()].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  scheduleFlush();
}
function updateInvestor(id, fn) {
  const st = loadState();
  const idx = st.investors.findIndex((i) => i.id === id);
  if (idx === -1) return null;
  const next = { ...fn(st.investors[idx]), updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  st.investors[idx] = next;
  scheduleFlush();
  return next;
}
function clearInvestors() {
  const st = loadState();
  st.deletedIds = [.../* @__PURE__ */ new Set([...st.deletedIds || [], ...st.investors.map((i) => i.id)])].slice(-5e3);
  st.investors = [];
  scheduleFlush();
}
function saveState(patch) {
  const cur = loadState();
  for (const k of Object.keys(patch)) {
    if (patch[k] !== void 0 && k !== "investors") cur[k] = patch[k];
  }
  if (patch.investors !== void 0) cur.investors = patch.investors;
  scheduleFlush();
  return cur;
}
function flushNow() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (cache) flush();
}

// src/data/audience.ts
var audienceOf = (x) => x?.audience === "experts" ? "experts" : "investors";
var AUDIENCE_TEXT = {
  investors: {
    menu: "Investors",
    /** Gmail label put on the email thread (sent + replies) */
    label: "Investor",
    one: "investor",
    many: "investors",
    One: "Investor",
    Many: "Investors",
    find: "Find investors",
    // fit-score bars
    fit: { thesis: "Thesis", stage: "Stage", sector: "Sector", check: "Check size", synergy: "Synergy" },
    // profile fields
    field: { check: "Check size", portfolio: "Portfolio", thesis: "Thesis", stage: "Stage", why: "Why they may invest" }
  },
  experts: {
    menu: "Fundraising experts",
    label: "Fundraising Expert",
    one: "expert",
    many: "experts",
    One: "Expert",
    Many: "Experts",
    find: "Find experts",
    fit: { thesis: "Specialty", stage: "Stage fit", sector: "Sector experience", check: "Cost fit", synergy: "Track record" },
    field: { check: "Fees", portfolio: "Past clients", thesis: "Services", stage: "Stages they help", why: "Why they could help" }
  }
};
var EXPERT_TYPES = [
  "Fundraising Consultant",
  "Fundraising Advisor",
  "Pitch Deck Consultant",
  "Fractional CFO",
  "Startup Lawyer",
  "Investment Banker",
  "Startup Advisor"
];
var EXPERT_ROLES = [
  "fundraising consultant",
  "fundraising advisor",
  "capital raising advisor",
  "startup fundraising consultant",
  "investor relations consultant",
  "capital raising consultant",
  "fundraising partner"
];
var LAWYER = /\b(attorneys?|lawyers?|law (firm|group|office|offices|partners)|llp|esq\.?|paralegal)\b/i;
var NOT_FUNDRAISING_EXPERT = /\b(legal|counsel|cpa|accountants?|accounting|bookkeep\w*|tax (advisor|services)|marketing agency|digital agency|seo|web design|graphic design|pitch deck design\w*|deck designer|presentation design\w*|recruit\w*|staffing|insurance|realtor|mortgage)\b/i;
var FUNDRAISING_WORDS = /\b(fundrais\w*|capital[- ]rais\w*|raise[sd]? capital|raising capital|investor relations|investor introductions?|angel investors?|venture capital|pre-seed|seed round|series a)\b/i;
function isNotFundraisingExpert(x) {
  const text = `${x.title || ""} ${x.firm || ""} ${x.name || ""}`;
  if (x.investorType === "Startup Lawyer" || LAWYER.test(text)) return true;
  return NOT_FUNDRAISING_EXPERT.test(text) && !FUNDRAISING_WORDS.test(`${x.title || ""} ${x.firm || ""}`);
}
function looksLikeFundraiser(x) {
  return FUNDRAISING_WORDS.test(`${x.title || ""} ${x.firm || ""} ${x.thesis || ""} ${x.feeModel || ""}`);
}
function expertQueries(kw, city) {
  const k = kw.length ? kw : ["consumer apps", "fintech", "edtech"];
  const pick = (i) => k[i % k.length];
  const linkedin = EXPERT_ROLES.map((r, i) => `site:linkedin.com/in "${r}" ${i % 2 ? "pre-seed" : "startups"}`);
  const place = city || "United States";
  const web = [
    "startup fundraising consultant pre-seed seed round",
    `fundraising consultant for startups ${pick(0)}`,
    "fundraising advisor helps startups raise seed round investor network",
    `capital raising advisor startups ${place}`,
    "fundraising consultant angel investor network startups",
    // experts who publish a way to email them (they sell a service, so many do)
    '"fundraising consultant" "contact" email startups',
    '"book a call" fundraising advisor startups',
    `fundraising advisor consumer apps ${pick(1)} startups`,
    "top fundraising consultants for startups",
    // paid from results, not upfront
    '"success fee" fundraising consultant startups',
    "commission based fundraising consultant pre-seed startups",
    '"no retainer" startup fundraising advisor',
    '"success-based" capital raising advisor seed round'
  ];
  return { linkedin, web };
}

// src/data/geo.ts
var US_STATES = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  DC: "District of Columbia"
};
var STATE_NAMES = Object.values(US_STATES);
function targetGeo(location) {
  const loc = (location || "").trim();
  const parts = loc.split(",").map((x) => x.trim()).filter(Boolean);
  const city = parts[0] || "";
  let state = "";
  for (const p of parts.slice(1)) {
    const up = p.replace(/\./g, "").toUpperCase();
    if (US_STATES[up]) state = US_STATES[up];
    const named = STATE_NAMES.find((n) => n.toLowerCase() === p.toLowerCase());
    if (named) state = named;
  }
  const saysUS = /\b(usa|u\.s\.a?\.?|united states|america)\b/i.test(loc);
  if (state || saysUS || !loc) return { country: "United States", isUS: true, state, city };
  return { country: parts[parts.length - 1] || "United States", isUS: false, state: "", city };
}
function geoRule(g) {
  return `LOCATION RULE: only include people / firms based in the ${g.country}${g.state ? ` (people in ${g.state} are a bonus)` : ""}. Skip anyone the evidence shows is based in another country. If the location is unknown, keep them only if nothing suggests they are outside the ${g.country}.`;
}
var US_HINT = new RegExp(`\\b(usa|united states|u\\.s\\.|america|${STATE_NAMES.join("|")})\\b`, "i");
function withGeo(q, g) {
  if (g.isUS) {
    if (US_HINT.test(q)) return q;
    return /site:linkedin\.com/i.test(q) ? `${q} United States` : `${q} USA`;
  }
  return q.toLowerCase().includes(g.country.toLowerCase()) ? q : `${q} "${g.country}"`;
}
var NON_US = /\b(united kingdom|uk|england|london|scotland|ireland|dublin|canada|toronto|vancouver|montreal|india|bangalore|bengaluru|mumbai|delhi|pakistan|karachi|lahore|uae|dubai|abu dhabi|saudi|riyadh|qatar|israel|tel aviv|germany|berlin|munich|france|paris|netherlands|amsterdam|spain|madrid|barcelona|italy|milan|sweden|stockholm|switzerland|zurich|singapore|australia|sydney|melbourne|new zealand|nigeria|lagos|kenya|nairobi|south africa|egypt|cairo|brazil|são paulo|sao paulo|mexico|argentina|chile|colombia|japan|tokyo|china|beijing|shanghai|hong kong|korea|seoul|indonesia|jakarta|philippines|vietnam|turkey|istanbul|poland|ukraine|portugal|lisbon|denmark|norway|finland|belgium|austria|estonia)\b/i;
function outsideTarget(text, g) {
  const t = (text || "").trim();
  if (!t) return false;
  if (g.isUS) return !US_HINT.test(t) && NON_US.test(t);
  return !t.toLowerCase().includes(g.country.toLowerCase()) && (US_HINT.test(t) || NON_US.test(t));
}

// src/data/filters.ts
function excludedReason(inv, geo = targetGeo("")) {
  if (inv.upfrontFee === "yes") return "asks for money upfront";
  if ((inv.tags || []).includes("Outside target country") || outsideTarget(`${inv.country || ""} ${inv.location || ""}`, geo)) return `outside the ${geo.country}`;
  if (audienceOf(inv) === "experts") {
    if (isNotFundraisingExpert(inv)) return "not a fundraising expert";
    if ((inv.tags || []).includes("Not a fundraising expert") && !looksLikeFundraiser(inv)) return "not a fundraising expert";
  }
  return "";
}

// src/data/queries.ts
var NOISE = /^(success[- ]?fee( model)?|success[- ]based( compensation)?|commission( based)?|commission[- ]only|no retainer|no upfront fees?|performance[- ]based|performance compensation|equity( only| compensation)?|coppa|deal flow|intro(duction)?s? to investors|investor introductions|angel syndicate|book a (call|discovery call)|schedule a (call|meeting)|contact( me| us)?|email( us)?|reach out|get in touch|let's talk|linkedin|blog post|case studies?|list of .*|directory of .*|top .*|community of .*)$/i;
var PLACE = /^(usa|united states|america|arizona|phoenix|scottsdale|chandler|tempe|mesa|tucson|dallas|austin|houston|texas|atlanta|georgia|new york|nyc|san francisco|bay area|silicon valley|los angeles|california|boston|seattle|chicago|miami|florida|denver|colorado|salt lake city|utah|san diego|washington|dc|nashville|raleigh|philadelphia|minneapolis|portland|las vegas|charlotte|detroit|pittsburgh|columbus|baltimore|new jersey)$/i;
function simplifyQuery(q) {
  const site = (q.match(/site:\S+/i) || [""])[0];
  const allQuoted = [...q.matchAll(/"([^"]+)"/g)].map((m) => m[1].trim()).filter(Boolean);
  const loose = allQuoted.filter((p) => p.split(/\s+/).length >= 4).flatMap((p) => p.replace(/^(list|directory|community) of\s+/i, "").replace(/^top\s+/i, "").split(/\s+/));
  const quoted = allQuoted.filter((p) => p.split(/\s+/).length < 4);
  const rest = [...loose, ...q.replace(/site:\S+/gi, " ").replace(/"[^"]*"/g, " ").replace(/\b(OR|AND)\b/g, " ").split(/\s+/)].filter(Boolean);
  const useful = quoted.filter((p) => !NOISE.test(p));
  const places2 = useful.filter((p) => PLACE.test(p));
  const topics = useful.filter((p) => !PLACE.test(p));
  const restPlaces = rest.filter((w) => PLACE.test(w));
  const restWords = rest.filter((w) => !PLACE.test(w) && !NOISE.test(w) && w.length > 1);
  const parts = [];
  if (site) parts.push(site);
  if (topics[0]) parts.push(`"${topics[0]}"`);
  const place = places2[0] || restPlaces[0] || "";
  if (site) {
    if (place) parts.push(`"${place}"`);
    else if (topics[1]) parts.push(`"${topics[1]}"`);
  } else {
    if (!place && topics[1]) parts.push(`"${topics[1]}"`);
    parts.push(...restWords.filter((w) => !/^(fee|fees|success|commission|retainer|coppa)$/i.test(w)).slice(0, topics[0] ? 3 : 6));
    if (place) parts.push(place);
  }
  const out = parts.join(" ").replace(/\s+/g, " ").trim();
  return out.replace(/^site:\S+$/i, "") || q.trim();
}
var INVESTOR_ROLES = ["angel investor", "pre-seed investor", "seed investor", "early stage investor", "venture partner", "angel investor consumer"];
var EXPERT_ROLES2 = ["fundraising consultant", "fundraising advisor", "capital raising advisor", "startup fundraising consultant", "investor relations consultant", "fundraising partner"];
function places(homeCity, homeState) {
  const hubs = ["Phoenix", "Scottsdale", "Arizona", "New York", "San Francisco", "Los Angeles", "Austin", "Dallas", "Houston", "Boston", "Seattle", "Chicago", "Miami", "Denver", "Atlanta", "Salt Lake City", "San Diego", "Nashville", "Raleigh", "Philadelphia", "Minneapolis", "Washington DC"];
  return [...new Set([homeState, "Phoenix", homeCity, ...hubs].filter(Boolean))];
}
function comboQueries(audience, used, count, homeCity = "", homeState = "") {
  const roles = audience === "experts" ? EXPERT_ROLES2 : INVESTOR_ROLES;
  const out = [];
  for (const p of places(homeCity, homeState)) {
    for (const r of roles) {
      for (const q of [`site:linkedin.com/in "${r}" "${p}"`, `"${r}" ${p} startups`]) {
        if (!used.has(`${q}|1`.toLowerCase()) && !out.includes(q)) out.push(q);
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}

// src/data/emailTemplates.ts
var TEMPLATE_V = 3;
var EXPERT_TERMS = {
  successFee: "5%",
  equity: "Up to 0.5%"
};
var INVESTOR_SUBJECT = "SafeCartKids \u2014 building the next Amazon for families";
var INVESTOR_EMAIL = `{greeting}
Would you like to be part of what could become the next $10 billion family-focused e-commerce company (the next Amazon)?
What if the next major breakthrough in e-commerce was a platform that empowers children to shop safely while protecting them and their families through a trusted, AI-powered online experience?
I'm the founder of SafeCartKids, an AI-powered e-commerce platform built specifically for children and families.
Today, parents face a growing challenge: children are increasingly exposed to inappropriate products, content, and online experiences through traditional shopping platforms. SafeCartKids addresses this problem by combining AI-powered content filtering, parental controls, and educational engagement into a single child-safe ecosystem.
Our vision is to become the trusted digital commerce ecosystem for families worldwide, creating both meaningful social impact and significant commercial opportunity.
{personal}I'm currently speaking with a select group of investors and strategic partners who are interested in backing technologies that solve real-world problems while addressing large, underserved markets.
Would you be open to a brief 15-minute conversation to explore whether SafeCartKids aligns with your investment interests?
{booking}
Best regards,
Mohammad Hanafi
Founder, SafeCartKids`;
var INVESTOR_FOLLOW_UPS = [
  {
    day: 4,
    subject: "Re: SafeCartKids \u2014 building the next Amazon for families",
    body: `{greeting}
I wanted to follow up on my note about SafeCartKids, the AI-powered, child-safe e-commerce platform for families.
We're speaking with a small group of pre-seed investors, and I'd value your perspective.
Would you be open to a brief 15-minute conversation?
{booking}
Best regards,
Mohammad Hanafi
Founder, SafeCartKids`
  },
  {
    day: 10,
    subject: "Re: SafeCartKids \u2014 building the next Amazon for families",
    body: `{greeting}
One more thought on SafeCartKids: parents want control over what their children see and buy online, and today's platforms weren't built for that. We're building the trusted commerce ecosystem for families.
If it fits your investment interests, I'd be glad to share more in a quick 15-minute call.
{booking}
Best regards,
Mohammad Hanafi
Founder, SafeCartKids`
  },
  {
    day: 21,
    subject: "Re: SafeCartKids \u2014 building the next Amazon for families",
    body: `{greeting}
I don't want to fill your inbox, so this will be my last note for now.
If SafeCartKids could align with your investment interests in the future, I'd be happy to reconnect at any time.
Thank you for your time and consideration.
Best regards,
Mohammad Hanafi
Founder, SafeCartKids`
  }
];
var EXPERT_SUBJECT = "Fundraising Partnership Opportunity \u2014 SafeCartKids";
var EXPERT_EMAIL = `{greeting}
I'm Mohammad Hanafi, founder of SafeCartKids, an AI-powered e-commerce platform designed to make online shopping safer for children while giving parents control over purchasing decisions.
{personal}We are seeking an experienced fundraising professional to help us secure pre-seed investment and build relationships with qualified angel investors, venture capital firms, and strategic partners.
We offer a performance-based compensation structure:
{successFee} success fee on qualifying investment funds successfully secured and received by the company through your efforts.
No upfront fees, retainers, or advance payments.
{equity} equity as an additional incentive, subject to agreed fundraising milestones, continued contribution, and formal documentation.
We are looking for someone with a verifiable track record in early-stage startup fundraising, strong investor relationships, and a long-term interest in helping build a potentially significant family-focused technology company.
If you have relevant experience and are interested in a results-based partnership, please share your fundraising track record, examples of successful raises, and proposed approach.
Let's explore whether we can build a successful partnership.
Mohammad Hanafi
Founder, SafeCartKids`;
var EXPERT_FOLLOW_UPS = [
  {
    day: 4,
    subject: "Re: Fundraising Partnership Opportunity \u2014 SafeCartKids",
    body: `{greeting}
I wanted to follow up on my note about a results-based fundraising partnership with SafeCartKids: a {successFee} success fee on funds secured and received, with no upfront fees, retainers, or advance payments.
If this interests you, please share your fundraising track record and proposed approach.
Mohammad Hanafi
Founder, SafeCartKids`
  },
  {
    day: 10,
    subject: "Re: Fundraising Partnership Opportunity \u2014 SafeCartKids",
    body: `{greeting}
We're preparing our pre-seed round and want to work with someone who has strong relationships with angel investors and venture capital firms.
If you'd like to explore a performance-based partnership, I'd be glad to share more about SafeCartKids.
Mohammad Hanafi
Founder, SafeCartKids`
  },
  {
    day: 21,
    subject: "Re: Fundraising Partnership Opportunity \u2014 SafeCartKids",
    body: `{greeting}
This will be my last note for now. If a results-based fundraising partnership with SafeCartKids interests you in the future, I'd be happy to reconnect.
Let's explore whether we can build a successful partnership.
Mohammad Hanafi
Founder, SafeCartKids`
  }
];
var NOT_A_PERSON = /\b(capital|ventures?|partners|fund|group|angels?|llc|inc|advisors?|consulting|network|club|firm|team|associates|attorneys?|law)\b/i;
function greetingFor(name, firm) {
  const n = (name || "").replace(/[,|(–—-].*$/, "").replace(/^(dr|mr|mrs|ms|miss|prof|professor|sir)\.?\s+/i, "").trim();
  const parts = n.split(/\s+/).filter(Boolean);
  const looksLikePerson = parts.length >= 2 && parts.length <= 4 && !NOT_A_PERSON.test(n) && n.toLowerCase() !== (firm || "").trim().toLowerCase();
  if (!looksLikePerson) return "Hello,";
  const first = parts[0].replace(/[^A-Za-zÀ-ÿ'-]/g, "");
  return first.length >= 2 ? `Hi ${first},` : "Hello,";
}
function cleanPersonalLine(line) {
  let t = (line || "").replace(/\s+/g, " ").trim().replace(/^["'“]+|["'”]+$/g, "");
  if (!t || t.length < 15) return "";
  if (/[\[\]{}<>]|lorem|placeholder|\bN\/A\b|unknown/i.test(t)) return "";
  if (t.length > 260) t = t.slice(0, 260).replace(/\s+\S*$/, "") + "\u2026";
  if (!/[.!?…]$/.test(t)) t += ".";
  return t;
}
function bookingLine(link) {
  const l = (link || "").trim();
  return /^https?:\/\/\S+$/i.test(l) ? `If so, you can schedule a time that works best for you here:
${l}` : "If so, just reply to this email with a time that works best for you.";
}
function fill(text, v) {
  return text.replace(/\{(\w+)\}/g, (_m, k) => k in v ? v[k] : `{${k}}`);
}
function buildEmails(audience, person, personalLine, bookingLink) {
  const personal = cleanPersonalLine(personalLine);
  const v = {
    greeting: greetingFor(person.name, person.firm),
    personal: personal ? `${personal}
` : "",
    booking: bookingLine(bookingLink),
    successFee: EXPERT_TERMS.successFee,
    equity: EXPERT_TERMS.equity
  };
  const exp = audience === "experts";
  const first = {
    stepNumber: 1,
    dayDelay: 0,
    stepName: "Intro",
    subject: exp ? EXPERT_SUBJECT : INVESTOR_SUBJECT,
    body: fill(exp ? EXPERT_EMAIL : INVESTOR_EMAIL, v),
    rationale: personal ? `Personal line: ${personal}` : "No specific detail found \u2014 sent without a personal line."
  };
  const follow = (exp ? EXPERT_FOLLOW_UPS : INVESTOR_FOLLOW_UPS).map((f, k) => ({
    stepNumber: k + 2,
    dayDelay: f.day,
    stepName: ["Follow-up", "Value add", "Close the loop"][k],
    subject: f.subject,
    body: fill(f.body, v),
    rationale: "Template follow-up"
  }));
  return [first, ...follow];
}
function buildLinkedIn(audience, person, bookingLink) {
  const g = greetingFor(person.name, person.firm).replace(/,$/, "");
  if (audience === "experts") {
    return {
      note: `${g} \u2014 I'm Mohammad Hanafi, founder of SafeCartKids (AI-powered, child-safe e-commerce). We're looking for a fundraising partner on a performance basis: ${EXPERT_TERMS.successFee} success fee, no upfront fees. Would love to connect.`.slice(0, 280),
      message: `${g}, thanks for connecting! We're seeking an experienced fundraising professional to help SafeCartKids secure pre-seed investment. We offer a ${EXPERT_TERMS.successFee} success fee on funds secured and received, no upfront fees or retainers, and ${EXPERT_TERMS.equity.toLowerCase()} equity subject to milestones. If you're interested, could you share your fundraising track record and proposed approach?`
    };
  }
  const book = bookingLine(bookingLink).replace(/^If so, /, "");
  return {
    note: `${g} \u2014 I'm Mohammad Hanafi, founder of SafeCartKids, an AI-powered e-commerce platform built for children and families (the next Amazon for families). I'd love to connect.`.slice(0, 280),
    message: `${g}, thanks for connecting! SafeCartKids is an AI-powered, child-safe e-commerce platform for families. I'm speaking with a select group of investors \u2014 would you be open to a brief 15-minute conversation? ${book.charAt(0).toUpperCase()}${book.slice(1)}`
  };
}

// server/reader.ts
var UA2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
var BLOCKED_HOSTS = /(^|\.)linkedin\.com$|(^|\.)facebook\.com$|(^|\.)instagram\.com$|(^|\.)x\.com$|(^|\.)twitter\.com$/i;
function canFetch(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    if (BLOCKED_HOSTS.test(u.hostname)) return false;
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$)/i.test(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}
function decode(s) {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"').replace(/&mdash;/g, "\u2014").replace(/&ndash;/g, "\u2013").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
var EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
var JUNK_EMAIL = /(\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg|example\.com|sentry|wixpress|domain\.com|email\.com|yourname|@2x)/i;
function decodeCloudflareEmails(html) {
  const out = [];
  const hexes = [
    ...[...html.matchAll(/data-cfemail=["']([0-9a-f]{4,})["']/gi)].map((m) => m[1]),
    ...[...html.matchAll(/email-protection#([0-9a-f]{4,})/gi)].map((m) => m[1])
  ];
  for (const hex of hexes) {
    try {
      const key = parseInt(hex.slice(0, 2), 16);
      let e = "";
      for (let i = 2; i < hex.length; i += 2) e += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
      if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) out.push(e);
    } catch {
    }
  }
  return out;
}
function unObfuscate(text) {
  return text.replace(/\s*[\[(<{]\s*at\s*[\])>}]\s*/gi, "@").replace(/\s*[\[(<{]\s*dot\s*[\])>}]\s*/gi, ".").replace(/\b([a-z0-9._%+-]+)\s+at\s+([a-z0-9-]+)\s+dot\s+([a-z]{2,})\b/gi, "$1@$2.$3");
}
function extractPhones(text) {
  const out = [];
  const re = /(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})(?!\d)/g;
  let m;
  while ((m = re.exec(text)) && out.length < 10) {
    const before = text[m.index - 1] || " ";
    if (/[\d\/A-Za-z]/.test(before)) continue;
    const raw = m[0];
    if (!/[\s.()+-]/.test(raw) && !/tel:[^\d]*$/i.test(text.slice(Math.max(0, m.index - 6), m.index))) continue;
    if (m[2] === "555" && /^01\d\d$/.test(m[3])) continue;
    out.push(`(${m[1]}) ${m[2]}-${m[3]}`);
  }
  return [...new Set(out)];
}
function extractEmails(text) {
  const found = (unObfuscate(text).match(EMAIL_RE) || []).map((e) => e.toLowerCase().replace(/\.$/, ""));
  return [...new Set(found.filter((e) => !JUNK_EMAIL.test(e)))].slice(0, 10);
}
function htmlToContent(html, url) {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim());
  const description = decode(
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)?.[1] || ""
  );
  const links = [];
  const linkRe = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) && links.length < 300) {
    try {
      const href = new URL(decode(m[1]), url).toString();
      const text = decode(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      links.push({ href, text: text.slice(0, 80) });
    } catch {
    }
  }
  const mailtos = [...html.matchAll(/mailto:([^"'?\s>]+)/gi)].map((x) => decodeURIComponent(x[1]));
  let body = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<svg[\s\S]*?<\/svg>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/section|\/article)[^>]*>/gi, "\n").replace(/<li[^>]*>/gi, "\n\u2022 ").replace(/<h(\d)[^>]*>/gi, "\n\n").replace(/<[^>]+>/g, " ");
  body = decode(body).replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
  const hidden = decodeCloudflareEmails(html);
  const tels = [...html.matchAll(/href=["']tel:([^"']+)["']/gi)].map((x) => "tel:" + decodeURIComponent(x[1]));
  return { url, title, description, text: body, emails: extractEmails([...mailtos, ...hidden].join(" ") + " " + body), phones: extractPhones(tels.join(" ") + " " + body), links };
}
async function viaJina(url) {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { Accept: "text/plain", "X-Return-Format": "markdown" },
    signal: AbortSignal.timeout(3e4)
  });
  if (!res.ok) throw new Error(`jina ${res.status}`);
  const md = await res.text();
  const title = md.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || "";
  const links = [...md.matchAll(/\[([^\]]{1,80})\]\((https?:\/\/[^)\s]+)\)/g)].slice(0, 300).map((x) => ({ text: x[1], href: x[2] }));
  return { url, title, description: "", text: md, emails: extractEmails(md), phones: extractPhones(md), links, via: "jina" };
}
async function readPage(url, maxChars = 12e3) {
  if (!canFetch(url)) return { url, title: "", description: "", text: "", emails: [], links: [], via: "failed", error: "not fetchable" };
  let direct = null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA2, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(15e3)
    });
    const type = res.headers.get("content-type") || "";
    if (res.ok && /html|text/i.test(type)) {
      const html = (await res.text()).slice(0, 15e5);
      direct = { ...htmlToContent(html, res.url || url), via: "direct" };
    }
  } catch {
  }
  if (!direct || direct.text.length < 400) {
    try {
      const j = await viaJina(url);
      if (j.text.length > (direct?.text.length || 0)) direct = j;
    } catch (e) {
      if (!direct) return { url, title: "", description: "", text: "", emails: [], links: [], via: "failed", error: e?.message };
    }
  }
  direct.text = direct.text.slice(0, maxChars);
  return direct;
}
function pickUsefulSubpages(page, max = 3) {
  let host = "";
  try {
    host = new URL(page.url).hostname.replace(/^www\./, "");
  } catch {
    return [];
  }
  const kinds = [
    ["contact", /contact|get-in-touch|reach-us|pitch|submit|apply/],
    ["team", /team|people|partners|about|who-we-are/],
    ["portfolio", /portfolio|companies|investments/],
    ["thesis", /thesis|focus|approach|what-we-invest|philosophy/]
  ];
  const own = page.links.filter((l) => {
    try {
      return new URL(l.href).hostname.replace(/^www\./, "") === host;
    } catch {
      return false;
    }
  });
  const seen = /* @__PURE__ */ new Set([page.url.replace(/\/$/, "")]);
  const out = [];
  for (const [, re] of kinds) {
    if (out.length >= max) break;
    const hit = own.find((l) => {
      const href = l.href.split("#")[0].replace(/\/$/, "");
      return re.test(`${href} ${l.text}`.toLowerCase()) && !seen.has(href);
    });
    if (hit) {
      const href = hit.href.split("#")[0].replace(/\/$/, "");
      seen.add(href);
      out.push(href);
    }
  }
  return out;
}

// server/agent.ts
var arr = (x, max = 20) => (Array.isArray(x) ? x : typeof x === "string" && x ? [x] : []).map((v) => typeof v === "string" ? v : v?.name || JSON.stringify(v)).map((v) => v.trim()).filter(Boolean).slice(0, max);
var str = (x, max = 2e3) => typeof x === "string" ? x.trim().slice(0, max) : x == null ? "" : String(x).slice(0, max);
var clamp = (n, lo = 0, hi = 100) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
};
var today = () => (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
var uid = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
var normKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
var INVESTOR_TYPES = ["Angel", "VC Fund", "Micro-VC", "Family Office", "Angel Group", "Accelerator", "Corporate VC", "Other", ...EXPERT_TYPES];
var isExp = (a) => a === "experts";
var expType = (t, exp) => exp && !EXPERT_TYPES.includes(t) && t !== "Accelerator" ? "Other" : t;
var typeList = (a) => isExp(a) ? "Fundraising Consultant | Fundraising Advisor | Investment Banker | Other" : "Angel | VC Fund | Micro-VC | Family Office | Angel Group | Accelerator | Corporate VC | Other";
var STAGES = ["Pre-seed", "Seed", "Series A", "Growth", "All Stages", "Unknown"];
var asType = (t) => INVESTOR_TYPES.find((x) => x.toLowerCase() === String(t || "").toLowerCase()) || "Other";
var asStage = (s) => {
  const v = String(s || "").toLowerCase();
  if (/pre.?seed/.test(v)) return "Pre-seed";
  if (/^seed|seed/.test(v)) return "Seed";
  if (/series a/.test(v)) return "Series A";
  if (/growth|series [b-z]|late/.test(v)) return "Growth";
  if (/all|multi|any/.test(v)) return "All Stages";
  return STAGES.find((x) => x.toLowerCase() === v) || "Unknown";
};
var NON_FIRM_HOSTS = [
  "linkedin.com",
  "crunchbase.com",
  "pitchbook.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "wikipedia.org",
  "bloomberg.com",
  "medium.com",
  "youtube.com",
  "instagram.com",
  "wellfound.com",
  "angel.co",
  "signal.nfx.com",
  "tracxn.com",
  "cbinsights.com",
  "dealroom.co",
  "forbes.com",
  "techcrunch.com",
  "businessinsider.com",
  "reddit.com",
  "quora.com",
  "github.com",
  "zoominfo.com",
  "rocketreach.co",
  "apollo.io",
  "openvc.app",
  "f6s.com",
  "eu-startups.com",
  "google.com",
  "substack.com",
  "prnewswire.com",
  "businesswire.com",
  "globenewswire.com",
  "yahoo.com",
  "axios.com",
  "inc.com",
  "entrepreneur.com",
  "fastcompany.com"
];
function isNonFirmUrl(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return NON_FIRM_HOSTS.some((d) => h === d || h.endsWith("." + d));
  } catch {
    return true;
  }
}
function startupBrief(s) {
  const lines = [
    `Name: ${s.name}`,
    s.website ? `Website: ${s.website}` : "",
    `One-liner: ${s.oneLiner}`,
    `Category: ${s.category}`,
    `Stage: ${s.stage}`,
    s.targetRaise ? `Raising: ${s.targetRaise}` : "Raise amount: not specified (do NOT invent one)",
    s.checkSizeMin || s.checkSizeMax ? `Desired check size: ${s.checkSizeMin} - ${s.checkSizeMax}` : "",
    `Location: ${s.location}`,
    `Problem: ${s.problem}`,
    `Solution / edge: ${s.secretSauce}`,
    s.keyFeatures?.length ? `Key features: ${s.keyFeatures.join("; ")}` : "",
    s.tractionHighlights?.length ? `Facts / traction (ONLY these are true): ${s.tractionHighlights.join("; ")}` : "Traction: none provided (do NOT invent any)",
    `Ideal investors: ${s.idealInvestorTraits}`,
    s.productDescription ? `AI product summary: ${s.productDescription}` : "",
    s.targetCustomers?.length ? `Buyers: ${s.targetCustomers.join("; ")}` : "",
    s.endUsers?.length ? `End users: ${s.endUsers.join("; ")}` : "",
    s.businessModel ? `Business model (analysis): ${s.businessModel}` : "",
    s.differentiation?.length ? `Differentiation: ${s.differentiation.join("; ")}` : "",
    s.competitors?.length ? `Comparable companies: ${s.competitors.join("; ")}` : "",
    s.investorKeywords?.length ? `Investor keywords: ${s.investorKeywords.join(", ")}` : "",
    s.extraContext ? `Extra context from founder: ${s.extraContext.slice(0, 2500)}` : ""
  ];
  return lines.filter(Boolean).join("\n");
}
var NO_UPFRONT_RULE = `MONEY RULE: we do NOT work with anyone who asks the founder to pay before anything happens \u2014 retainers, monthly fees, application / pitch / membership / listing fees, "due diligence" fees, paid programs or paid investor-matching. Investors who invest, and experts paid only from results (success fee / commission on money actually raised), are fine.`;
var HONESTY_RULES = `Honesty rules (very important):
- Never invent traction, revenue, users, pilots, partnerships, quotes or metrics. Only use facts given to you.
- Never invent investors, people, emails, portfolio companies or URLs. If something is unknown, use "" or [].
- It is fine to give clearly-labelled analysis/opinion (e.g. likely business model), but not fake facts.`;
async function analyzeProduct(s, settings) {
  let siteText = "";
  if (s.website && canFetch(s.website)) {
    const home = await readPage(s.website, 8e3);
    siteText = home.text ? `HOMEPAGE (${home.url}) title="${home.title}" desc="${home.description}"
${home.text}` : "";
    for (const sub of pickUsefulSubpages(home, 2).filter((u) => !/portfolio/.test(u))) {
      const p = await readPage(sub, 3e3);
      if (p.text) siteText += `

PAGE ${p.url}
${p.text}`;
    }
  }
  const tg = targetGeo(s.location);
  const geo = `ONLY the ${tg.country}${tg.state ? ` (extra weight on ${tg.state})` : ""} \u2014 every query must aim at the ${tg.country}`;
  const local = settings?.includeLocalAngelGroups !== false;
  const out = await chatJson(
    `You are a senior venture analyst preparing a startup for an investor search. Today is ${today()}.
${HONESTY_RULES}`,
    `Analyse this product so an AI agent can find the RIGHT investors for it.

STARTUP PROFILE (from the founder):
${startupBrief(s)}

${siteText ? `WEBSITE TEXT (scraped just now):
${siteText.slice(0, 9e3)}` : "Website could not be read; rely on the profile."}

Geography focus for investors: ${geo}. ${local ? `Also include searches for local angel groups / investors near ${s.location}.` : ""}

Return JSON:
{
  "productDescription": "3-4 sentence plain-English description",
  "targetCustomers": ["who pays"],
  "endUsers": ["who uses it"],
  "businessModel": "most likely model(s), labelled as analysis if not stated",
  "marketDescription": "market + why now, 2-3 sentences, no made-up numbers",
  "competitors": ["real comparable companies / adjacent players investors know (e.g. kids fintech, kid-safe platforms)"],
  "differentiation": ["..."],
  "fundingUse": ["likely uses of a pre-seed/seed round"],
  "risksInvestorsWillAsk": ["tough questions investors will ask"],
  "investorKeywords": ["10-15 short theme keywords investors use, e.g. family tech, kids fintech, edtech, child safety"],
  "investorTypesToTarget": ["e.g. Angel", "Micro-VC", "Angel Group", "Family Office", "Corporate VC"],
  "linkedinSearchQueries": ["6 Google queries that find PUBLIC LinkedIn profiles of relevant investors. Each MUST start with site:linkedin.com/in and use quoted phrases, e.g. site:linkedin.com/in \\"angel investor\\" \\"family tech\\""],
  "webSearchQueries": ["8 web queries that find specific relevant funds/angels/angel groups and lists of investors in comparable startups, e.g. \\"pre-seed venture fund\\" kids fintech portfolio, investors in Greenlight BusyKid early stage"],
  "confidence": 0-100
}`,
    3500
  );
  return {
    productDescription: str(out.productDescription),
    targetCustomers: arr(out.targetCustomers),
    endUsers: arr(out.endUsers),
    businessModel: str(out.businessModel),
    marketDescription: str(out.marketDescription),
    competitors: arr(out.competitors, 15),
    differentiation: arr(out.differentiation),
    fundingUse: arr(out.fundingUse),
    risksInvestorsWillAsk: arr(out.risksInvestorsWillAsk),
    investorKeywords: arr(out.investorKeywords, 20),
    investorTypesToTarget: arr(out.investorTypesToTarget),
    linkedinSearchQueries: arr(out.linkedinSearchQueries, 10).map((q) => /site:linkedin\.com/i.test(q) ? q : `site:linkedin.com/in ${q}`),
    webSearchQueries: arr(out.webSearchQueries, 12),
    aiConfidence: clamp(out.confidence),
    aiGeneratedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function defaultQueries(s, settings) {
  const g = targetGeo(s.location);
  const q = rawDefaultQueries(s, settings);
  const tidy = (x) => withGeo(simplifyQuery(x), g);
  return { linkedin: [...new Set(q.linkedin.map(tidy))], web: [...new Set(q.web.map(tidy))] };
}
function rawDefaultQueries(s, settings) {
  if (isExp(settings?.audience)) {
    const city = (s.location || "").split(",").slice(0, 2).map((x) => x.trim()).join(" ").trim();
    return expertQueries((s.investorKeywords || []).slice(0, 5), settings?.includeLocalAngelGroups !== false ? city : "");
  }
  const kw = (s.investorKeywords?.length ? s.investorKeywords : ["family tech", "kids fintech", "edtech", "parenting", "child safety"]).slice(0, 6);
  const linkedin = s.linkedinSearchQueries?.length ? s.linkedinSearchQueries : kw.slice(0, 5).map((k) => `site:linkedin.com/in "angel investor" "${k}"`);
  const web = s.webSearchQueries?.length ? [...s.webSearchQueries] : kw.slice(0, 5).map((k) => `pre-seed investors ${k} startups`);
  if (settings?.includeLocalAngelGroups !== false && s.location) {
    const city = s.location.split(",").slice(0, 2).join(" ");
    web.push(`angel investor groups ${city} early stage startups`);
  }
  web.push(...emailFriendlyQueries(kw));
  return { linkedin, web };
}
function emailFriendlyQueries(kw) {
  const k = kw.length ? kw : ["consumer", "family tech"];
  const pick = (i) => k[i % k.length];
  return [
    `"send us your pitch deck" pre-seed fund ${pick(0)}`,
    `"email your deck" seed investors ${pick(1)}`,
    `"pitch@" pre-seed venture fund consumer`,
    `"deals@" seed fund ${pick(2)} startups`,
    `"submit your deck" "email" angel investors ${pick(3)}`,
    `pre-seed fund "we read every email" founders ${pick(0)}`,
    `micro VC "email us" pitch deck consumer apps ${pick(1)}`,
    `angel network "apply" "email" early stage ${pick(2)}`
  ];
}
var noLog = () => {
};
var looksLikeList = (r) => !isLinkedInProfile(r.url) && /(top \d+|\d+ (best|top)|list of|investors (in|for|who)|best .*investors|angel (groups|networks)|directory|vc firms|(best|top) .*(consultants|advisors|experts|coaches|cfos)|consultants (for|who))/i.test(`${r.title} ${r.snippet}`);
async function runSearches(queries, perQuery = 10, log = noLog) {
  const seen = /* @__PURE__ */ new Set();
  const all = [];
  for (const q of queries) {
    const { results, engine, errors } = await webSearch(q, perQuery);
    if (!results.length) {
      log("search", `No results for: ${q}${errors.length ? ` (${errors.join("; ").slice(0, 160)})` : ""}`, "warn");
      continue;
    }
    let added = 0;
    for (const r of results) {
      const key = r.url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(r);
      added++;
    }
    log("search", `${engine}: ${results.length} results (${added} new) \u2014 ${q}`, "info");
  }
  return all;
}
async function extractCandidates(s, results, existing, log = noLog, maxListPages = 3, audience = "investors") {
  const exp = isExp(audience);
  const geo = targetGeo(s.location);
  const listPages = [];
  for (const r of results.filter(looksLikeList).slice(0, maxListPages)) {
    const p = await readPage(r.url, 7e3);
    if (p.text.length > 500 && !/just a moment|attention required|access denied|verify you are human/i.test(p.title)) {
      listPages.push(p);
      log("extract", `Read list page: ${p.title || r.title}`, "info");
    }
  }
  const evidenceBlocks = [
    ...results.map((r, i) => ({ id: `R${i + 1}`, url: r.url, text: `${r.title}
${r.snippet}` })),
    ...listPages.map((p, i) => ({ id: `L${i + 1}`, url: p.url, text: `${p.title}
${p.text}` }))
  ];
  const validUrls = new Set(evidenceBlocks.map((b) => b.url));
  const linkedinByBlock = new Map(results.map((r, i) => [`R${i + 1}`, isLinkedInProfile(r.url) ? normalizeLinkedInUrl(r.url) : ""]));
  const out = [];
  const seen = new Set(existing.map((e) => normKey(e.name) + "|" + normKey(e.firm)));
  const seenNames = new Set(existing.map((e) => normKey(e.name)));
  const batches = [];
  let cur = [];
  let size = 0;
  for (const b of evidenceBlocks) {
    const len = Math.min(b.text.length, 5e3);
    if (size + len > 9e3 && cur.length) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push({ ...b, text: b.text.slice(0, 5e3) });
    size += len;
  }
  if (cur.length) batches.push(cur);
  for (const batch of batches) {
    let parsed;
    for (let tryNo = 0; tryNo < 2 && parsed === void 0; tryNo++) {
      if (tryNo > 0) {
        log("extract", "AI busy \u2014 waiting, then retrying this batch of search results\u2026", "info");
        await new Promise((r) => setTimeout(r, Number(process.env.AGENT_RETRY_WAIT_MS || 6e4)));
      }
      try {
        parsed = await chatJson(
          exp ? `You extract REAL, specific FUNDRAISING EXPERTS from search results \u2014 people or small firms who help startups raise money. ${HONESTY_RULES}
Only include someone if the evidence text itself names them AND shows their job is RAISING MONEY for startups: fundraising consultant / advisor, capital-raising advisor, someone who introduces startups to angel investors and VCs, or a boutique placement agent for early-stage raises.
NEVER include: lawyers, attorneys or law firms (even startup / venture lawyers), accountants / CPAs, pitch-deck designers, financial-model builders, marketing or web agencies, software tools, recruiters, journalists, investors who only invest, generic articles, and the startup itself.
${geoRule(geo)}
${NO_UPFRONT_RULE} Skip anyone whose evidence shows they charge founders upfront.` : `You extract REAL, specific investors from search results for a startup's fundraising. ${HONESTY_RULES}
Only include an investor if the evidence text itself names them AND indicates they invest (angel, VC, partner, fund, angel group, family office, accelerator).
Skip journalists, founders who are not investors, recruiters, generic articles, and the startup itself.
${geoRule(geo)}
${NO_UPFRONT_RULE} Skip anyone whose evidence shows they charge founders upfront (e.g. angel groups with application or pitch fees).`,
          `STARTUP:
${startupBrief(s).slice(0, 1800)}

EVIDENCE (id | url | text):
${batch.map((b) => `[${b.id}] ${b.url}
${b.text}`).join("\n\n---\n\n")}

Return JSON: {"investors":[{
 "name": "person name, or the firm name if no person is named",
 "firm": ${exp ? '"their consultancy / company, or \\"Independent\\""' : '"fund / firm / angel group, or \\"Independent Angel\\""'},
 "title": ${exp ? '"e.g. Fundraising Consultant, Founder, Fractional CFO, Partner"' : '"e.g. Partner, Angel Investor, Managing Director"'},
 "investorType": "${typeList(audience)}",
 "location": "city, state / country if shown in the evidence, else \\"\\"",
 "country": "country they are based in if shown, else \\"\\"",
 "evidenceId": "the [id] where you saw them",
 "websiteUrl": "${exp ? "their own website" : "firm website"} ONLY if it appears in the evidence, else \\"\\"",
 "whyRelevant": "one sentence: ${exp ? "how they could help" : "why they may fit"} ${s.name}, based on the evidence"
}]}`,
          3500
        );
      } catch (e) {
        if (tryNo === 1) log("extract", `AI extraction failed for one batch: ${e?.message?.slice(0, 160)}`, "warn");
      }
    }
    if (parsed === void 0) continue;
    for (const c of Array.isArray(parsed?.investors) ? parsed.investors : []) {
      const name = str(c.name, 120);
      if (!name || name.length < 3) continue;
      if (outsideTarget(`${str(c.country, 80)} ${str(c.location, 120)}`, geo)) continue;
      if (exp && isNotFundraisingExpert({ name, firm: str(c.firm, 120), title: str(c.title, 120) })) continue;
      const firm = str(c.firm, 120) || (exp ? "Independent" : "Independent Angel");
      const key = normKey(name) + "|" + normKey(firm);
      if (seen.has(key) || seenNames.has(normKey(name))) continue;
      const block = batch.find((b) => b.id === str(c.evidenceId).replace(/[\[\]]/g, "")) || batch[0];
      let web = str(c.websiteUrl, 300);
      if (web && !(validUrls.has(web) || /^https?:\/\//.test(web) && !isNonFirmUrl(web))) web = "";
      const res = results.find((r) => r.url === block.url);
      if (!web && res && !isLinkedInProfile(res.url) && !isNonFirmUrl(res.url) && !looksLikeList(res) && block.id.startsWith("R")) web = res.url;
      seen.add(key);
      seenNames.add(normKey(name));
      out.push({
        id: uid("cand"),
        name,
        firm,
        title: str(c.title, 120),
        investorType: expType(asType(c.investorType), exp),
        audience,
        linkedinUrl: linkedinByBlock.get(block.id) || "",
        websiteUrl: web,
        sourceUrl: block.url,
        sourceTitle: block.text.split("\n")[0].slice(0, 160),
        snippet: block.text.split("\n").slice(1).join(" ").slice(0, 400),
        whyRelevant: str(c.whyRelevant, 400),
        location: str(c.location, 120)
      });
    }
  }
  log("extract", `AI identified ${out.length} new ${exp ? "fundraising experts" : "investor candidates"}`, out.length ? "success" : "warn");
  return out;
}
async function discoverCandidates(s, queries, existing, log = noLog, audience = "investors") {
  const rawResults = await runSearches(queries, 10, log);
  if (!rawResults.length) return { candidates: [], rawResults };
  const candidates = await extractCandidates(s, rawResults, existing, log, 3, audience);
  return { candidates, rawResults };
}
async function findLinkedInProfile(name, firm) {
  const q = `site:linkedin.com/in "${name}"${firm && !/independent/i.test(firm) ? ` ${firm}` : ""}`;
  const { results } = await webSearch(q, 6);
  const last = name.trim().split(/\s+/).pop()?.toLowerCase() || "";
  const hit = results.find((r) => isLinkedInProfile(r.url) && (r.title.toLowerCase().includes(last) || r.url.toLowerCase().includes(last)));
  return hit ? normalizeLinkedInUrl(hit.url) : "";
}
async function findFirmWebsite(firm, name, exp = false) {
  const q = exp ? /^independent$/i.test(firm) || !firm ? `"${name}" fundraising consultant startups` : `"${firm}" startup fundraising services` : /independent|angel$/i.test(firm) ? `"${name}" angel investor portfolio` : `"${firm}" venture investor portfolio`;
  const { results } = await webSearch(q, 8);
  const base = exp && (/^independent$/i.test(firm) || !firm) ? name : firm;
  const token = normKey(base.replace(/\b(the|capital|ventures?|partners|fund|vc|group|angels?|llc|inc|advisors?|consulting|consultants?)\b/gi, "")).slice(0, 6);
  const host = (u) => {
    try {
      return normKey(new URL(u).hostname);
    } catch {
      return "";
    }
  };
  const site = token.length >= 3 ? results.find((r) => !isNonFirmUrl(r.url) && host(r.url).includes(token)) : void 0;
  return { url: site?.url || "", snippets: results };
}
function fitStatus(total) {
  return total >= 75 ? "hot" : total >= 55 ? "warm" : "cold";
}
function normalizeFit(f) {
  const thesisMatch = clamp(f?.thesisMatch);
  const stageMatch = clamp(f?.stageMatch);
  const sectorMatch = clamp(f?.sectorMatch);
  const checkSizeMatch = clamp(f?.checkSizeMatch);
  const synergyMatch = clamp(f?.synergyMatch);
  const computed = Math.round(thesisMatch * 0.3 + stageMatch * 0.2 + sectorMatch * 0.25 + checkSizeMatch * 0.1 + synergyMatch * 0.15);
  const total = f?.total != null ? clamp(f.total) : computed;
  return {
    total,
    thesisMatch,
    stageMatch,
    sectorMatch,
    checkSizeMatch,
    synergyMatch,
    status: fitStatus(total),
    verdict: str(f?.verdict, 400),
    whyInvest: arr(f?.whyInvest, 5),
    hesitations: arr(f?.hesitations, 5),
    keyTalkingPoint: str(f?.keyTalkingPoint, 400)
  };
}
function siteRootOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").split(".").slice(-2).join(".");
  } catch {
    return "";
  }
}
function siteMatchesFirm(root, firm, person) {
  const label = (root.split(".")[0] || "").toLowerCase();
  if (label.length < 3) return false;
  const words = `${firm} ${person}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !/^(capital|ventures?|partners?|fund|group|angels?|investors?|independent|holdings|management|the)$/.test(w));
  const squashed = (firm || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return words.some((w) => label.includes(w)) || squashed.length >= 4 && squashed.includes(label);
}
var EMAIL_SEARCH_V = 2;
var BAD_INBOX = /^(no-?reply|donotreply|privacy|legal|careers?|jobs|recruit|press|media|pr|unsubscribe|abuse|webmaster|billing|accounts?|admin|support|help|security|dpo|gdpr)[@.+-]/;
var GOOD_INBOX = /^(invest|investments|investors|pitch|pitches|deals?|dealflow|deal-flow|founders?|startups?|apply|partners?|team|hello|hi|info|contact|ventures?|office)[@.+-]/;
function bestEmail(list, personName, siteRoot) {
  if (!siteRoot) return "";
  const own = list.filter((e) => {
    const d = e.split("@")[1] || "";
    return (d === siteRoot || d.endsWith("." + siteRoot)) && !BAD_INBOX.test(e);
  });
  if (!own.length) return "";
  const parts = personName.toLowerCase().split(/\s+/).map((x) => x.replace(/[^a-z]/g, "")).filter((x) => x.length > 1);
  const personal = own.find((e) => {
    const local = e.split("@")[0].replace(/[^a-z]/g, "");
    return parts.some((p) => local.includes(p)) || parts.length > 1 && local === parts[0][0] + parts[parts.length - 1];
  });
  if (personal) return personal;
  const ranked = own.filter((e) => GOOD_INBOX.test(e));
  const order = (e) => {
    const k = e.split("@")[0];
    return /invest|pitch|deal|founder|startup|apply/.test(k) ? 0 : /partner|team|ventures/.test(k) ? 1 : 2;
  };
  return ranked.sort((a, b) => order(a) - order(b))[0] || "";
}
var OUTREACH_SPEC = (_s, _settings, audience) => `"personalLine": "ONE sentence (max 35 words) for the email, written as the founder to this person, about a SPECIFIC fact from the evidence \u2014 ${isExp(audience) ? 'e.g. a startup they helped raise, their investor network, or their fundraising focus. Example: "I came across your work helping early-stage consumer startups raise their seed rounds, which is exactly the experience we are looking for."' : 'e.g. a portfolio company, their sector focus or something they said. Example: "I noticed your investment in Greenlight, and I believe SafeCartKids shares the same mission of empowering families."'}. Use ONLY facts from the evidence; if there is nothing specific, return ""."`;
async function researchCandidate(s, c, settings, log = noLog) {
  const who = c.name;
  const audience = c.audience ? audienceOf(c) : audienceOf(settings);
  const exp = isExp(audience);
  const evidence = [];
  const sources = new Set([c.sourceUrl].filter(Boolean));
  evidence.push(`DISCOVERY SOURCE (${c.sourceUrl}): ${c.sourceTitle}
${c.snippet}`);
  let linkedin = c.linkedinUrl;
  if (!linkedin && settings?.lookupLinkedInProfiles !== false && c.investorType !== "Angel Group" && c.name !== c.firm) {
    linkedin = await findLinkedInProfile(c.name, c.firm).catch(() => "");
    if (linkedin) log("research", `Found public LinkedIn profile`, "info", who);
  }
  let website = c.websiteUrl;
  const look = website ? { url: "", snippets: [] } : await findFirmWebsite(c.firm, c.name, exp).catch(() => ({ url: "", snippets: [] }));
  if (!website) website = look.url;
  for (const r of look.snippets.slice(0, 6)) {
    evidence.push(`SEARCH (${r.url}): ${r.title} \u2014 ${r.snippet}`);
  }
  const emails = /* @__PURE__ */ new Set();
  const phones = [];
  let crawl = { title: "", description: "", excerpt: "", url: website };
  if (website && canFetch(website)) {
    const home = await readPage(website, 6e3);
    if (home.text) {
      sources.add(home.url);
      crawl = { title: home.title, description: home.description, excerpt: home.text.slice(0, 1500), url: home.url };
      home.emails.forEach((e) => emails.add(e));
      phones.push(...home.phones || []);
      evidence.push(`WEBSITE ${home.url} \u2014 ${home.title}
${home.description}
${home.text}`);
      const subs = pickUsefulSubpages(home, 3);
      if (!home.emails.length && !subs.some((u) => /contact/i.test(u))) {
        try {
          subs.push(new URL("/contact", home.url).toString());
        } catch {
        }
      }
      for (const sub of subs) {
        const p2 = await readPage(sub, 4e3);
        if (p2.text) {
          sources.add(p2.url);
          p2.emails.forEach((e) => emails.add(e));
          if (/contact/i.test(p2.url)) phones.unshift(...p2.phones || []);
          else phones.push(...p2.phones || []);
          evidence.push(`PAGE ${p2.url}
${p2.text.slice(0, 3e3)}`);
        }
      }
      log("research", `Read ${website.replace(/^https?:\/\//, "").slice(0, 50)} (${home.via})`, "info", who);
    } else {
      log("research", `Could not read ${website}`, "warn", who);
    }
  }
  const root = siteRootOf(website);
  const trustedSite = !!c.websiteUrl || siteMatchesFirm(root, c.firm, c.name);
  const webEmails = /* @__PURE__ */ new Set();
  if (root && trustedSite && ![...emails].some((e) => e.endsWith("@" + root) || e.endsWith("." + root))) {
    const firstLast = c.name.split(/\s+/).filter(Boolean);
    const q = `"@${root}"${firstLast.length > 1 ? ` OR "${firstLast[0]}" "${firstLast[firstLast.length - 1]}" email` : ""}`;
    const { results } = await webSearch(q, 8).catch(() => ({ results: [] }));
    for (const r of results) {
      for (const e of extractEmails(`${r.title} ${r.snippet}`)) {
        if (e.endsWith("@" + root) || e.endsWith("." + root)) {
          webEmails.add(e);
          emails.add(e);
          evidence.push(`SEARCH (${r.url}): ${r.title} \u2014 ${r.snippet}`);
        }
      }
    }
    if (webEmails.size) log("research", `Found a published email on the web for ${root}`, "info", who);
  }
  extractEmails(`${c.sourceTitle || ""} ${c.snippet || ""}`).forEach((e) => emails.add(e));
  const evidenceText = evidence.join("\n\n---\n\n").slice(0, 8e3);
  const emailList = [...emails];
  const out = await chatJson(
    exp ? `You research FUNDRAISING EXPERTS \u2014 people whose job is raising money for startups (fundraising consultants / advisors, capital-raising advisors, investor-introduction partners) \u2014 who could help ${s.name} raise its pre-seed round. Today is ${today()}. ${HONESTY_RULES}` : `You are a VC research analyst + fundraising copywriter for ${s.name}. Today is ${today()}. ${HONESTY_RULES}`,
    `STARTUP:
${startupBrief(s)}

${exp ? "FUNDRAISING EXPERT" : "INVESTOR"} CANDIDATE: ${c.name} \u2014 ${c.title || ""} @ ${c.firm} (${c.investorType})
Why discovered: ${c.whyRelevant}

EVIDENCE COLLECTED FROM THE PUBLIC WEB:
${evidenceText}

Emails found on their site: ${emailList.join(", ") || "none"}
Phones found on their site: ${[...new Set(phones)].slice(0, 4).join(", ") || "none"}

${geoRule(targetGeo(s.location))}
${NO_UPFRONT_RULE}

Return JSON:
{
 "profile": {
   "title": "", "firm": "", "investorType": "${typeList(audience)}",
   "location": "", "stage": "${exp ? "stages they help with: " : ""}Pre-seed | Seed | Series A | Growth | All Stages | Unknown",
   ${exp ? `"checkSizeFormatted": "their fees / pricing ONLY if published (e.g. '$3k/month retainer', 'fixed fee', 'success fee'), else Unknown", "checkSizeMin": 0, "checkSizeMax": 0,
   "industries": ["sectors they work in, FROM EVIDENCE"], "portfolio": ["startups / clients they helped, named IN EVIDENCE"],
   "recentInvestments": [{"name":"client or raise they helped with","year":"","sector":"","note":"amount raised etc. only if in evidence"}],
   "thesis": "the services they offer and how they work, from evidence", "contactRoute": "best legitimate route: e.g. 'Email', 'Book a call on website', 'Contact form', 'LinkedIn connection'",
   "email": "ONLY an email from the list above that belongs to this person/firm, else \\"\\"",` : `"checkSizeFormatted": "e.g. $25k - $100k, or Unknown", "checkSizeMin": number or 0, "checkSizeMax": number or 0,
   "industries": ["focus areas FROM EVIDENCE"], "portfolio": ["portfolio companies named IN EVIDENCE"],
   "recentInvestments": [{"name":"","year":"","sector":"","note":""}],
   "thesis": "their stated thesis, from evidence", "contactRoute": "best legitimate route: e.g. 'Email partner', 'Website pitch form', 'LinkedIn connection', 'Warm intro preferred'",
   "email": "ONLY an email from the list above that belongs to this investor/firm, else \\"\\"",`}
   "twitter": "", "keyQuotes": ["short quotes copied from evidence"],
   "country": "country they are based in, from evidence, else \\"\\"",
   "upfrontFee": "yes | no | unknown \u2014 yes ONLY if evidence shows founders must pay them before anything happens (retainer, monthly fee, application / pitch / membership fee, paid program, due-diligence fee)",
   "feeModel": "${exp ? "how they charge, from evidence (e.g. success fee only, commission on funds raised, retainer + success fee, hourly), else Unknown" : "any fee they charge founders (e.g. pitch fee, membership), else None"}"
 },
 "isRealInvestor": true/false (${exp ? "false if they are a lawyer / law firm, accountant, designer, agency, software tool, or do NOT actually raise money for startups" : "false if evidence suggests this is not an active investor"}),
 "fit": {"thesisMatch":0-100,"stageMatch":0-100,"sectorMatch":0-100,"checkSizeMatch":0-100,"synergyMatch":0-100,"total":0-100,
         "verdict":"one sentence","whyInvest":["3 evidence-based reasons ${exp ? "they could help" : ""}"],"hesitations":["2 honest concerns"],"keyTalkingPoint":"the single best hook for outreach"},
 "researchNotes": "4-6 sentences: who they are, ${exp ? "what fundraising help they offer and for whom" : "what they invest in"}, what you could NOT verify",
 ${OUTREACH_SPEC(s, settings, audience)}
}
${exp ? `Fit fields for an expert: thesisMatch = how much they specialise in startup fundraising; stageMatch = they help pre-seed/seed companies; sectorMatch = experience with consumer / kids / family / fintech / edtech; checkSizeMatch = cost fit: 90+ if paid only from results (success fee / commission on money raised, no upfront cost), 50 if unknown, 20 or less if they need a retainer or any upfront payment; synergyMatch = track record and investor network shown in evidence.
Scoring guide: 80+ = clearly helps early-stage consumer startups raise, with evidence of results; 55-79 = general startup fundraising help; <55 = weak, unclear, late-stage only or big-company only. Be strict when evidence is thin.` : `Scoring guide: 80+ = clear thesis + stage match for a kids/family consumer app; 55-79 = adjacent (consumer, edtech, fintech generalist); <55 = weak/unclear. Be strict when evidence is thin.`}`,
    3500
  );
  const p = out?.profile || {};
  const fit = normalizeFit(out?.fit);
  const pEarly = out?.profile || {};
  const realFundraiser = exp && looksLikeFundraiser({ title: str(pEarly.title, 120) || c.title, firm: str(pEarly.firm, 120) || c.firm, thesis: str(pEarly.thesis, 800), feeModel: str(pEarly.feeModel, 160) });
  if (out?.isRealInvestor === false) {
    if (!realFundraiser) {
      fit.total = Math.min(fit.total, 30);
      fit.status = "cold";
    }
    fit.hesitations = [
      exp ? "Evidence suggests they may not really offer fundraising help \u2014 verify before contacting." : "Evidence suggests this may not be an active investor \u2014 verify before contacting.",
      ...fit.hesitations
    ].slice(0, 5);
  }
  const geo = targetGeo(s.location);
  const country = str(p.country, 80);
  const outside = outsideTarget(`${country} ${str(p.location, 120)}`, geo);
  if (outside) {
    fit.total = Math.min(fit.total, 20);
    fit.status = "cold";
    fit.hesitations = [`Based outside the ${geo.country} (${country || str(p.location, 80)}).`, ...fit.hesitations].slice(0, 5);
  }
  const upfrontFee = /^yes/i.test(str(p.upfrontFee)) ? "yes" : /^no/i.test(str(p.upfrontFee)) ? "no" : "unknown";
  const feeModel = str(p.feeModel, 160);
  const who2 = { name: c.name, firm: str(p.firm, 120) || c.firm, title: str(p.title, 120) || c.title, investorType: str(p.investorType), thesis: str(p.thesis, 800), feeModel: str(p.feeModel, 160) };
  const notExpert = exp && (isNotFundraisingExpert(who2) || out?.isRealInvestor === false && !looksLikeFundraiser(who2));
  if (notExpert) {
    fit.total = Math.min(fit.total, 10);
    fit.status = "cold";
    fit.hesitations = ["Not a fundraising expert (e.g. law firm, accountant, designer or agency) \u2014 filtered out.", ...fit.hesitations].slice(0, 5);
  }
  if (upfrontFee === "yes") {
    fit.total = Math.min(fit.total, 15);
    fit.status = "cold";
    fit.hesitations = [`Asks for money upfront${feeModel ? ` (${feeModel})` : ""} \u2014 filtered out.`, ...fit.hesitations].slice(0, 5);
  }
  const email = str(p.email, 200).toLowerCase();
  const siteRoot = (() => {
    try {
      return new URL(website).hostname.replace(/^www\./, "").split(".").slice(-2).join(".");
    } catch {
      return "";
    }
  })();
  const emailDomain = email.split("@")[1] || "";
  const domainOk = /^(gmail|googlemail|outlook|hotmail|icloud|yahoo|proton|protonmail)\./.test(emailDomain) || !!siteRoot && emailDomain.endsWith(siteRoot);
  const aiPick = email && emailList.includes(email) && domainOk && !(webEmails.has(email) && !emailDomain.endsWith(siteRoot)) ? email : "";
  const verifiedEmail = aiPick || (trustedSite ? bestEmail(emailList, c.name, siteRoot) : "");
  const portfolio = arr(p.portfolio, 25);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const li = buildLinkedIn(audience, { name: c.name, firm: str(p.firm, 120) || c.firm }, settings?.bookingLink);
  return {
    id: uid("inv"),
    emailSearchV: EMAIL_SEARCH_V,
    name: c.name,
    title: str(p.title, 120) || c.title || (exp ? "Fundraising expert" : "Investor"),
    firm: str(p.firm, 120) || c.firm,
    investorType: expType(asType(p.investorType || c.investorType), exp),
    audience,
    website: website || "",
    email: verifiedEmail,
    // a phone only counts if it is on their own website
    phone: trustedSite ? [...new Set(phones)][0] || "" : "",
    linkedin: linkedin || "",
    twitter: str(p.twitter, 80),
    location: str(p.location, 120) || c.location || "",
    country: country || (outside ? "" : geo.country),
    upfrontFee,
    feeModel,
    stage: asStage(p.stage),
    checkSizeFormatted: str(p.checkSizeFormatted, 60) || "Unknown",
    checkSizeMin: Number(p.checkSizeMin) || 0,
    checkSizeMax: Number(p.checkSizeMax) || 0,
    industries: arr(p.industries, 12),
    portfolio,
    recentInvestments: (Array.isArray(p.recentInvestments) ? p.recentInvestments : []).slice(0, 6).map((r) => ({
      name: str(r?.name, 80),
      year: str(r?.year, 10),
      sector: str(r?.sector, 80),
      note: str(r?.note, 200)
    })).filter((r) => r.name),
    thesis: str(p.thesis, 800),
    contactRoute: str(p.contactRoute, 120) || (verifiedEmail ? "Email" : linkedin ? "LinkedIn connection" : "Website"),
    activePartner: c.name,
    fitScore: fit,
    researchNotes: str(out?.researchNotes, 2e3),
    extractedData: {
      rawUrl: crawl.url || c.sourceUrl,
      crawledAt: now,
      pageTitle: crawl.title || c.sourceTitle,
      metaDescription: crawl.description,
      extractedTextExcerpt: crawl.excerpt || c.snippet,
      keyQuotes: arr(p.keyQuotes, 5),
      portfolioFound: portfolio,
      detectedCheckSize: str(p.checkSizeFormatted, 60),
      detectedContactEmail: verifiedEmail
    },
    sourceUrls: [...sources].slice(0, 8),
    linkedinNote: li.note,
    linkedinMessage: li.message,
    outreach: {
      status: fit.status === "hot" ? "hot" : fit.status === "warm" ? "warm" : "researched",
      sequenceGenerated: true,
      sequences: buildEmails(audience, { name: c.name, firm: str(p.firm, 120) || c.firm }, str(out?.personalLine, 400), settings?.bookingLink),
      templateV: TEMPLATE_V,
      sentStepsCount: 0,
      // never auto-email someone who wants money upfront or is outside the target country
      autoPaused: upfrontFee === "yes" || outside || notExpert ? true : void 0
    },
    tags: ["AI researched", c.investorType, linkedin ? "LinkedIn found" : "", upfrontFee === "yes" ? "Asks for upfront fee" : "", outside ? "Outside target country" : "", notExpert ? "Not a fundraising expert" : ""].filter(Boolean),
    researchDepth: "deep",
    createdAt: now,
    updatedAt: now
  };
}
function investorBrief(i) {
  const exp = isExp(i.audience);
  return [
    `Name: ${i.name} \u2014 ${i.title} @ ${i.firm} (${i.investorType || ""})${exp ? " \u2014 FUNDRAISING EXPERT (helps startups raise; not an investor)" : ""}`,
    `Location: ${i.location}`,
    exp ? `Stages they help: ${i.stage}; Fees: ${i.checkSizeFormatted}` : `Stage: ${i.stage}; Check: ${i.checkSizeFormatted}`,
    `Industries: ${i.industries.join(", ")}`,
    `${exp ? "Past clients" : "Portfolio"}: ${i.portfolio.join(", ")}`,
    `${exp ? "Services" : "Thesis"}: ${i.thesis}`,
    i.feeModel ? `How they charge: ${i.feeModel}` : "",
    `Research notes: ${i.researchNotes}`,
    i.extractedData?.extractedTextExcerpt ? `Website excerpt: ${i.extractedData.extractedTextExcerpt.slice(0, 1500)}` : ""
  ].join("\n");
}
async function scoreInvestor(s, i) {
  const out = await chatJson(
    isExp(i.audience) ? `You score how well a FUNDRAISING EXPERT could help ${s.name} raise its round. thesisMatch = fundraising specialty, stageMatch = helps pre-seed/seed, sectorMatch = consumer/kids/fintech/edtech experience, checkSizeMatch = affordable for a pre-seed startup, synergyMatch = track record + investor network. ${HONESTY_RULES}` : `You are a VC analyst scoring investor fit for ${s.name}. ${HONESTY_RULES}`,
    `STARTUP:
${startupBrief(s)}

${isExp(i.audience) ? "FUNDRAISING EXPERT" : "INVESTOR"}:
${investorBrief(i)}

Return JSON: {"fit": {"thesisMatch":0-100,"stageMatch":0-100,"sectorMatch":0-100,"checkSizeMatch":0-100,"synergyMatch":0-100,"total":0-100,"verdict":"","whyInvest":["3"],"hesitations":["2"],"keyTalkingPoint":""}, "researchNotes": "updated 3-5 sentence notes"}
Be strict when information is thin.`,
    2e3
  );
  return { fitScore: normalizeFit(out?.fit), researchNotes: str(out?.researchNotes, 2e3) || i.researchNotes };
}
async function generateOutreach(s, i, settings, opts = {}) {
  const audience = audienceOf(i);
  let personal = "";
  try {
    const out = await chatJson(
      `You write ONE personal sentence for ${s.name}'s outreach email. ${HONESTY_RULES}`,
      `${isExp(audience) ? "FUNDRAISING EXPERT" : "INVESTOR"}:
${investorBrief(i)}
Best hook: ${i.fitScore?.keyTalkingPoint || ""}

Return JSON: {${OUTREACH_SPEC(s, settings, audience)}}`,
      400
    );
    personal = str(out?.personalLine, 400);
  } catch (e) {
    if (opts.requireAI) throw e;
    personal = "";
  }
  const li = buildLinkedIn(audience, { name: i.name, firm: i.firm }, settings?.bookingLink);
  return {
    sequences: buildEmails(audience, { name: i.name, firm: i.firm }, personal, settings?.bookingLink),
    linkedinNote: li.note,
    linkedinMessage: li.message,
    templateV: TEMPLATE_V
  };
}
var jobs = /* @__PURE__ */ new Map();
function getJob(id) {
  return jobs.get(id);
}
function latestJob() {
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}
function cancelJob(id) {
  const j = jobs.get(id);
  if (j && j.status === "running") j.cancel = true;
  return !!j;
}
function startAgentJob(s, settings, existing, opts = {}) {
  for (const [id, j] of jobs) if (j.status !== "running" && Date.now() - Date.parse(j.startedAt) > 6 * 36e5) jobs.delete(id);
  const running2 = [...jobs.values()].find((j) => j.status === "running");
  if (running2) return running2;
  const job = { id: uid("job"), status: "running", startedAt: (/* @__PURE__ */ new Date()).toISOString(), progress: 0, logs: [], investors: [] };
  jobs.set(job.id, job);
  const log = (phase, message, level = "info", investorName) => {
    job.logs.push({ id: uid("log"), timestamp: (/* @__PURE__ */ new Date()).toISOString(), phase, message, level, investorName });
    if (job.logs.length > 600) job.logs.splice(0, job.logs.length - 600);
  };
  (async () => {
    let startup = { ...s };
    try {
      if (opts.refreshProduct || !startup.investorKeywords?.length || !startup.linkedinSearchQueries?.length) {
        log("product", `Phase 1 \u2014 analysing ${startup.name}${startup.website ? ` (reading ${startup.website})` : ""}\u2026`);
        const intel = await analyzeProduct(startup, settings);
        startup = { ...startup, ...intel };
        job.startupUpdate = intel;
        log("product", `Product understood (confidence ${intel.aiConfidence}%). Investor themes: ${(intel.investorKeywords || []).slice(0, 6).join(", ")}`, "success");
      } else {
        log("product", `Using saved product intelligence for ${startup.name}`, "info");
      }
      job.progress = 10;
      if (job.cancel) throw new Error("cancelled");
      const q = defaultQueries(startup, settings);
      const queries = [...q.linkedin.slice(0, 5), ...q.web.slice(0, 6), ...opts.extraQueries || []];
      log("search", `Phase 2 \u2014 running ${queries.length} searches (public LinkedIn profiles + investor websites)\u2026`);
      const { candidates } = await discoverCandidates(
        startup,
        queries,
        existing,
        (ph, m, l, n) => {
          log(ph, m, l, n);
          if (ph === "search") job.progress = Math.min(30, job.progress + 2);
        },
        audienceOf(settings)
      );
      job.progress = 35;
      if (!candidates.length) {
        log("extract", "No new investors found this run. Try again later, add search keys (Tavily/Serper), or edit search queries in the Brain tab.", "warn");
      }
      const target = candidates.slice(0, Math.max(1, settings.leadsPerRun || 10));
      log("research", `Phase 3-5 \u2014 researching, scoring and writing outreach for ${target.length} investors\u2026`);
      let kept = 0;
      const PACE_MS2 = Number(process.env.AGENT_PACE_MS || 8e3);
      const failed = [];
      const runOne = async (c, retry) => {
        log("research", `${retry ? "Retrying" : "Researching"} ${c.name}${c.firm && c.firm !== c.name && !/independent/i.test(c.firm) ? ` (${c.firm})` : ""}\u2026`, "info", c.name);
        try {
          const inv = await researchCandidate(startup, c, settings, log);
          if (inv.fitScore.total < (settings.minFitScoreToKeep ?? 0)) {
            log("score", `Fit ${inv.fitScore.total}/100 \u2014 below your minimum (${settings.minFitScoreToKeep}), skipped`, "warn", c.name);
          } else {
            job.investors.push(inv);
            kept++;
            log("score", `Fit ${inv.fitScore.total}/100 (${inv.fitScore.status.toUpperCase()}) \u2014 ${inv.fitScore.verdict}`, "success", c.name);
            log("outreach", `Drafted 4-step email cadence + LinkedIn note${inv.email ? ` (email found: ${inv.email})` : ""}`, "success", c.name);
          }
        } catch (e) {
          const msg = String(e?.message || e);
          if (/No AI key/i.test(msg)) throw e;
          if (!retry && /AI providers failed|rate limited|busy|timeout/i.test(msg)) {
            failed.push(c);
            log("research", "AI is busy (free limit) \u2014 will retry this investor at the end", "warn", c.name);
          } else {
            log("research", `Failed: ${msg.slice(0, 200)}`, "error", c.name);
          }
        }
      };
      for (let idx = 0; idx < target.length; idx++) {
        if (job.cancel) throw new Error("cancelled");
        await runOne(target[idx], false);
        job.progress = Math.round(35 + (idx + 1) / target.length * 55);
        if (idx < target.length - 1) await new Promise((r) => setTimeout(r, PACE_MS2));
      }
      if (failed.length) {
        log("research", `Waiting 60 seconds, then retrying ${failed.length} investor(s) that hit the free AI limit\u2026`, "info");
        await new Promise((r) => setTimeout(r, Number(process.env.AGENT_RETRY_WAIT_MS || 6e4)));
        for (let idx = 0; idx < failed.length; idx++) {
          if (job.cancel) throw new Error("cancelled");
          await runOne(failed[idx], true);
          job.progress = Math.round(90 + (idx + 1) / failed.length * 9);
          if (idx < failed.length - 1) await new Promise((r) => setTimeout(r, PACE_MS2 * 2));
        }
      }
      job.progress = 100;
      job.status = "done";
      log("crm", `Done \u2014 ${kept} investors added to your CRM.`, "success");
    } catch (e) {
      const msg = String(e?.message || e);
      job.status = msg === "cancelled" ? "cancelled" : "error";
      job.error = msg;
      log("system", msg === "cancelled" ? `Stopped. ${job.investors.length} investors were saved before stopping.` : `Run failed: ${msg}`, msg === "cancelled" ? "warn" : "error");
    } finally {
      job.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
    }
  })();
  return job;
}
async function quickScoreCandidates(s, cands, audience = "investors") {
  const exp = isExp(audience);
  const geo = targetGeo(s.location);
  const out = /* @__PURE__ */ new Map();
  if (!cands.length) return out;
  const res = await chatJson(
    exp ? `You do a FAST first-pass check of FUNDRAISING EXPERTS who could help ${s.name} raise its round. Use only the text given. ${HONESTY_RULES}` : `You are a VC analyst doing a FAST first-pass fit check for ${s.name}. Use only the text given. ${HONESTY_RULES}`,
    `STARTUP:
${startupBrief(s).slice(0, 1500)}

CANDIDATES:
${cands.map((c, i) => `[${i + 1}] ${c.name} \u2014 ${c.title} @ ${c.firm} (${c.investorType}) ${c.location}
Seen: ${c.snippet.slice(0, 300)}
Why found: ${c.whyRelevant}`).join("\n\n")}

Return JSON: {"scores":[{"n":1,"score":0-100,"isInvestor":true/false,"upfrontFee":true/false,"outsideCountry":true/false,"reason":"one short sentence"}]} \u2014 one entry per candidate, same numbers.
"upfrontFee": true ONLY if the text shows they make founders pay before anything happens (retainer, monthly fee, application / pitch / membership fee, paid program). ${NO_UPFRONT_RULE}
"outsideCountry": true ONLY if the text shows they are based outside the ${geo.country}.
${exp ? `"isInvestor" here means: true ONLY if their job is raising money for startups (fundraising consultant / advisor, capital-raising advisor, investor-introduction partner, early-stage placement agent); false for lawyers / law firms, accountants, designers, agencies, software, recruiters and anyone else.
Scoring: 75+ clearly helps early-stage consumer / kids / fintech / edtech startups raise; 50-74 general startup fundraising help; <50 weak, unclear, or only late-stage / big companies. Be strict when the text is thin.` : `Scoring: 75+ clear thesis/stage fit for a kids/family consumer app at pre-seed; 50-74 adjacent (consumer, edtech, fintech, local angel); <50 weak or unclear. Be strict when the text is thin.`}`,
    1500
  );
  for (const r of Array.isArray(res?.scores) ? res.scores : []) {
    const c = cands[Number(r?.n) - 1];
    if (!c) continue;
    out.set(c.id, {
      score: clamp(r.score),
      reason: str(r.reason, 300),
      isInvestor: r.isInvestor !== false,
      upfront: r.upfrontFee === true,
      outside: r.outsideCountry === true || outsideTarget(c.location, geo)
    });
  }
  return out;
}
async function generateSearchQueries(s, settings, used, count = 24) {
  if (isExp(settings.audience)) return generateExpertQueries(s, settings, used, count);
  const res = await chatJson(
    `You plan investor searches for ${s.name}. ${HONESTY_RULES}`,
    `STARTUP:
${startupBrief(s).slice(0, 2e3)}
Geography: ONLY people based in the ${targetGeo(s.location).country}${targetGeo(s.location).state ? ` (extra weight on ${targetGeo(s.location).state})` : ""}. Every query must aim at the ${targetGeo(s.location).country} (name the country, a state or a city).

Queries ALREADY USED (do not repeat or lightly reword them):
${used.slice(-120).join("\n") || "(none)"}

Write ${count} NEW, varied Google queries that surface SPECIFIC investors who could fund this company. Mix:
- about a third that find PUBLIC LinkedIn profiles: must start with site:linkedin.com/in and use quoted phrases (roles like "angel investor", "partner", "principal", "scout"; themes; cities; portfolio companies like Greenlight, GoHenry, BusyKid, Step, Outschool)
- about a third find funds, angel groups and accelerators that PUBLISH an email for pitches (e.g. "send us your pitch deck", "pitch@", "deals@", "email your deck") \u2014 these are the investors we can actually email
- the rest find funds, angel groups, family offices, and "investors in <comparable company>" lists

SEARCH RULES (very important \u2014 long searches find NOBODY):
- Each query is SHORT: at most 2 quoted phrases, 2-7 words in total.
- Never put fees, commission, success fee, retainer, compliance words (COPPA), "contact", "book a call" or "LinkedIn" in a query.
- At most ONE place (a US state or city) per query.
Return JSON: {"queries":["..."]}`,
    1500
  );
  const usedSet = new Set(used.map((q) => q.toLowerCase().trim()));
  return arr(res?.queries, count * 2).map((q) => q.trim()).map((q) => withGeo(simplifyQuery(q), targetGeo(s.location))).filter((q) => q.length > 8 && !usedSet.has(q.toLowerCase())).slice(0, count);
}
async function generateExpertQueries(s, settings, used, count) {
  const res = await chatJson(
    `You plan searches that find FUNDRAISING EXPERTS for ${s.name}. ${HONESTY_RULES}`,
    `STARTUP:
${startupBrief(s).slice(0, 1500)}
Geography: ONLY people based in the ${targetGeo(s.location).country}${targetGeo(s.location).state ? ` (extra weight on ${targetGeo(s.location).state})` : ""}. Every query must aim at the ${targetGeo(s.location).country} (name the country, a state or a city).

Queries ALREADY USED (do not repeat or lightly reword them):
${used.slice(-120).join("\n") || "(none)"}

Write ${count} NEW, varied Google queries that surface SPECIFIC people or small firms who help startups like this raise money: fundraising consultants, fundraising advisors, capital-raising advisors and people who introduce startups to angel investors and VCs. NEVER lawyers / law firms, accountants, pitch-deck designers or agencies. Mix:
- about a third that find PUBLIC LinkedIn profiles: must start with site:linkedin.com/in and use quoted phrases (roles + themes like consumer apps, fintech, edtech, kids, or cities)
- about a third that find experts with their own fundraising / capital-raising advisory website (e.g. "fundraising consultant" Phoenix, "capital raising advisory" startups)
- the rest: lists and directories of such experts, and experts who mention helping companies similar to this one

SEARCH RULES (very important \u2014 long searches find NOBODY):
- Each query is SHORT: at most 2 quoted phrases, 2-7 words in total.
- Never put fees, commission, success fee, retainer, compliance words (COPPA), "contact", "book a call" or "LinkedIn" in a query.
- At most ONE place (a US state or city) per query.
Return JSON: {"queries":["..."]}`,
    1500
  );
  const usedSet = new Set(used.map((q) => q.toLowerCase().trim()));
  return arr(res?.queries, count * 2).map((q) => q.trim()).map((q) => withGeo(simplifyQuery(q), targetGeo(s.location))).filter((q) => q.length > 8 && !usedSet.has(q.toLowerCase())).slice(0, count);
}
function candidateToQuickInvestor(c, score, reason, campaignId) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const status = fitStatus(score);
  const audience = audienceOf(c);
  return {
    id: uid("inv"),
    audience,
    name: c.name,
    title: c.title || (isExp(audience) ? "Fundraising expert" : "Investor"),
    firm: c.firm,
    investorType: c.investorType,
    website: c.websiteUrl || "",
    email: "",
    linkedin: c.linkedinUrl || "",
    location: c.location || "",
    stage: "Unknown",
    checkSizeFormatted: "Unknown",
    checkSizeMin: 0,
    checkSizeMax: 0,
    industries: [],
    portfolio: [],
    recentInvestments: [],
    thesis: "",
    contactRoute: c.linkedinUrl ? "LinkedIn connection" : c.websiteUrl ? "Website" : "Unknown",
    activePartner: c.name,
    fitScore: {
      total: score,
      thesisMatch: score,
      stageMatch: score,
      sectorMatch: score,
      checkSizeMatch: score,
      synergyMatch: score,
      status,
      verdict: `Quick scan: ${reason || c.whyRelevant}`,
      whyInvest: c.whyRelevant ? [c.whyRelevant] : [],
      hesitations: ['Only quick-scanned from search results \u2014 open and click "Research deeply" before contacting.'],
      keyTalkingPoint: ""
    },
    researchNotes: `Found via search: ${c.sourceTitle}. ${c.snippet.slice(0, 300)}`,
    extractedData: {
      rawUrl: c.sourceUrl,
      crawledAt: now,
      pageTitle: c.sourceTitle,
      metaDescription: "",
      extractedTextExcerpt: c.snippet,
      keyQuotes: [],
      portfolioFound: [],
      detectedCheckSize: "",
      detectedContactEmail: ""
    },
    sourceUrls: [c.sourceUrl].filter(Boolean),
    outreach: { status: "discovered", sequenceGenerated: false, sequences: [], sentStepsCount: 0 },
    tags: ["Quick scan", c.investorType],
    researchDepth: "quick",
    quickScore: score,
    campaignId,
    createdAt: now,
    updatedAt: now
  };
}
function investorToCandidate(i) {
  return {
    id: i.id,
    name: i.name,
    firm: i.firm,
    title: i.title,
    investorType: i.investorType || "Other",
    audience: audienceOf(i),
    linkedinUrl: i.linkedin || "",
    websiteUrl: i.website || "",
    sourceUrl: i.sourceUrls?.[0] || i.extractedData?.rawUrl || "",
    sourceTitle: i.extractedData?.pageTitle || "",
    snippet: i.extractedData?.extractedTextExcerpt || i.researchNotes || "",
    whyRelevant: i.fitScore?.whyInvest?.[0] || "",
    location: i.location || ""
  };
}

// server/campaign.ts
var PACE_MS = () => Number(process.env.AGENT_PACE_MS || 8e3);
var sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
var uid2 = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
var pct = (n, d) => `${d ? Math.round(n / d * 100) : 0}%`;
var norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
var worker = null;
function save(c) {
  c.counts = {
    found: c.candidates.length,
    quick: c.candidates.filter((x) => x.stage === "quick" || x.stage === "researched").length,
    researched: c.candidates.filter((x) => x.stage === "researched").length,
    skipped: c.candidates.filter((x) => x.stage === "skipped").length,
    failed: c.candidates.filter((x) => x.stage === "failed").length,
    withEmail: c.candidates.filter((x) => x.stage === "researched" && x.hasEmail).length
  };
  saveState({ campaign: c });
}
function logTo(c) {
  return (phase, message, level = "info", investorName) => {
    c.logs.push({ id: uid2("log"), timestamp: (/* @__PURE__ */ new Date()).toISOString(), phase, message, level, investorName });
    if (c.logs.length > 400) c.logs.splice(0, c.logs.length - 400);
  };
}
function getCampaign() {
  const c = loadState().campaign;
  if (!c) return null;
  return { ...c, candidates: [], spare: void 0 };
}
function startCampaign(startup, settings, opts) {
  const st = loadState();
  const cur = st.campaign;
  if (cur && cur.status === "running" && worker) return cur;
  const audience = audienceOf(settings);
  const leftovers = [...cur?.candidates || [], ...cur?.spare || []].filter((x) => x.stage === "found" && audienceOf(x) === audience).map((x) => ({ ...x, attempts: 0 })).slice(0, 300);
  const c = {
    id: uid2("run"),
    status: "running",
    target: Math.max(5, Math.min(500, Math.round(opts.target || 100))),
    mode: opts.mode === "quick" ? "quick" : "deep",
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    phase: "queries",
    queries: [],
    queryCursor: 0,
    audience,
    candidates: leftovers,
    spare: [...cur?.candidates || [], ...cur?.spare || []].filter((x) => x.stage === "found" && audienceOf(x) !== audience).slice(0, 300),
    logs: []
  };
  c.startup = startup;
  c.settings = settings;
  saveState({ campaign: c, startup, settings });
  ensureWorker();
  return c;
}
function startUpgrade(startup, settings, count) {
  const st = loadState();
  const cur = st.campaign;
  if (cur && cur.status === "running" && worker) return { campaign: cur, available: 0 };
  const byScore = (a, b) => (b.fitScore?.total || 0) - (a.fitScore?.total || 0);
  const audience = audienceOf(settings);
  const geoU = targetGeo(startup.location);
  const mine = st.investors.filter((i) => audienceOf(i) === audience && !excludedReason(i, geoU));
  const quick = mine.filter((i) => i.researchDepth === "quick" && !["passed"].includes(i.outreach?.status)).sort(byScore);
  const recheck = mine.filter((i) => i.researchDepth !== "quick" && !i.email && (i.emailSearchV || 0) < EMAIL_SEARCH_V && !["replied", "meeting", "diligence", "passed"].includes(i.outreach?.status)).sort(byScore);
  const pool = [...quick, ...recheck];
  const n = Math.max(1, Math.min(200, Math.round(count || 20)));
  const picked = pool.slice(0, n);
  if (!picked.length) return { campaign: null, available: 0 };
  const spare = [...cur?.candidates || [], ...cur?.spare || []].filter((x) => x.stage === "found").slice(0, 300);
  const c = {
    id: uid2("run"),
    status: "running",
    target: picked.length,
    mode: "upgrade",
    audience,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    phase: "deep",
    queries: [],
    queryCursor: 0,
    candidates: picked.map((i) => ({
      ...investorToCandidate(i),
      stage: "quick",
      quickScore: i.fitScore?.total || 0,
      investorId: i.id,
      attempts: 0,
      force: i.researchDepth !== "quick"
    })),
    spare,
    logs: []
  };
  c.startup = startup;
  c.settings = settings;
  logTo(c)("research", `Researching ${picked.length} ${AUDIENCE_TEXT[audience].many} you already have (${picked.filter((i) => i.researchDepth === "quick").length} quick-scanned, ${picked.filter((i) => i.researchDepth !== "quick").length} email re-checks). ${pool.length - picked.length} more left after this.`, "success");
  save(c);
  ensureWorker();
  return { campaign: c, available: pool.length };
}
function pauseCampaign() {
  const c = loadState().campaign;
  if (!c || c.status !== "running") return false;
  c.status = "paused";
  logTo(c)("system", "Paused. Click Resume to continue from here.", "warn");
  save(c);
  return true;
}
function resumeCampaign() {
  const c = loadState().campaign;
  if (!c || c.status === "done") return false;
  c.status = "running";
  c.error = void 0;
  logTo(c)("system", "Resumed.", "info");
  save(c);
  ensureWorker();
  return true;
}
function resumeOnBoot() {
  const c = loadState().campaign;
  if (c && c.status === "running") {
    logTo(c)("system", "Server restarted \u2014 continuing the run.", "info");
    save(c);
    ensureWorker();
  }
}
function ensureWorker() {
  if (worker) return;
  worker = runWorker().catch((e) => console.error("[campaign]", e)).finally(() => {
    worker = null;
  });
}
async function runWorker() {
  const st = loadState();
  const c = st.campaign;
  if (!c) return;
  const startup = c.startup || st.startup;
  const settings = c.settings || st.settings || {};
  const audience = audienceOf(c);
  const T = AUDIENCE_TEXT[audience];
  settings.audience = audience;
  const log = logTo(c);
  const alive = () => loadState().campaign?.id === c.id && c.status === "running";
  try {
    if (c.phase === "queries") {
      const used = st.usedQueries || [];
      const usedSet = new Set(used.map((q) => q.toLowerCase()));
      const base = defaultQueries(startup, settings);
      let queries = [...base.linkedin, ...base.web].filter((q) => !usedSet.has(`${q}|1`.toLowerCase()));
      const want = Math.min(60, Math.max(12, Math.ceil(c.target / 4)));
      const g = targetGeo(startup.location);
      queries.push(...comboQueries(audience, /* @__PURE__ */ new Set([...usedSet, ...queries.map((q) => `${q}|1`.toLowerCase())]), Math.max(0, Math.ceil(want * 0.7) - queries.length), g.city, g.state));
      if (queries.length < want) {
        log("search", `Planning ${want - queries.length} new searches so this run finds new ${T.many}\u2026`);
        try {
          const more = await generateSearchQueries(startup, settings, [...used.map((u) => u.split("|")[0]), ...queries], want - queries.length);
          queries.push(...more);
        } catch (e) {
          log("search", `Could not plan extra searches (${String(e?.message).slice(0, 120)}) \u2014 using the saved search plan.`, "warn");
        }
      }
      const plan = queries.map((q) => `${q}|1`).filter((k) => !usedSet.has(k.toLowerCase()));
      for (const q of queries.filter((q2) => /site:linkedin/i.test(q2))) if (!usedSet.has(`${q}|2`.toLowerCase())) plan.push(`${q}|2`);
      c.queries = plan;
      c.queryCursor = 0;
      c.phase = "search";
      log("search", `Run started \u2014 looking for ${T.menu.toLowerCase()}: target ${c.target}, ${plan.length} searches planned.`, "success");
      save(c);
    }
    let replans = 0;
    let zeroStreak = 0;
    let searchesDone = 0;
    let searchesWithResults = 0;
    let fallbacks = 0;
    const zeroPage1 = /* @__PURE__ */ new Set();
    const g2 = targetGeo(startup.location);
    const addCombos = (n) => {
      const usedNow = /* @__PURE__ */ new Set([...(loadState().usedQueries || []).map((u) => u.toLowerCase()), ...c.queries.map((k) => k.toLowerCase())]);
      const more = comboQueries(audience, usedNow, n, g2.city, g2.state);
      c.queries.splice(c.queryCursor, 0, ...more.map((q) => `${q}|1`));
      return more.length;
    };
    while (c.phase === "search" && alive()) {
      if (c.candidates.length >= Math.ceil(c.target * 1.3)) break;
      if (c.queryCursor >= c.queries.length) {
        if (replans >= 2) break;
        replans++;
        if (addCombos(12)) {
          log("search", `Found ${c.candidates.length} so far \u2014 added more simple searches.`, "info");
          continue;
        }
        const used = loadState().usedQueries || [];
        try {
          const more = await generateSearchQueries(startup, settings, used.map((u) => u.split("|")[0]), 15);
          if (!more.length) break;
          c.queries.push(...more.map((q) => `${q}|1`));
          log("search", `Found ${c.candidates.length} so far \u2014 planned ${more.length} more searches.`, "info");
        } catch {
          break;
        }
      }
      while (c.queryCursor < c.queries.length && /\|2$/.test(c.queries[c.queryCursor]) && zeroPage1.has(c.queries[c.queryCursor].replace(/\|2$/, ""))) c.queryCursor++;
      const batch = c.queries.slice(c.queryCursor, c.queryCursor + 4).filter((k) => !(/\|2$/.test(k) && zeroPage1.has(k.replace(/\|2$/, ""))));
      const results = [];
      for (const key of batch) {
        const i = key.lastIndexOf("|");
        const q = key.slice(0, i);
        const page = Number(key.slice(i + 1)) || 1;
        const { results: r, engine, errors } = await webSearch(q, 10, page);
        const s2 = loadState();
        s2.usedQueries = [...s2.usedQueries || [], key].slice(-3e3);
        searchesDone++;
        if (r.length) {
          searchesWithResults++;
          zeroStreak = 0;
          results.push(...r);
          log("search", `${engine}: ${r.length} results \u2014 ${q}${page > 1 ? ` (page ${page})` : ""}`);
        } else {
          log("search", `No results \u2014 ${q}${errors.length ? ` (${errors.join("; ").slice(0, 120)})` : ""}`, "warn");
          zeroStreak++;
          if (page === 1) zeroPage1.add(q);
          if (errors.some((e) => /credits|quota|402|403|432/i.test(e)) && !errors.some((e) => /duckduckgo: 0/.test(e))) {
            log("search", "Search credits look used up \u2014 add another free search key or try again tomorrow.", "warn");
          }
        }
      }
      c.queryCursor += Math.max(1, c.queries.slice(c.queryCursor, c.queryCursor + 4).length);
      if (searchesDone >= 24 && searchesWithResults === 0) {
        log("search", `${searchesDone} searches and not one result \u2014 stopping so no more search credits are used. Check your SERPER_API_KEY and credits at serper.dev (or add TAVILY_API_KEY), then start the run again.`, "error");
        break;
      }
      if (zeroStreak >= 8 && fallbacks < 2) {
        fallbacks++;
        const n = addCombos(16);
        log("search", n ? `${zeroStreak} searches in a row found nothing \u2014 switching to ${n} simpler searches.` : `${zeroStreak} searches in a row found nothing. If this keeps happening, check your Serper key / credits at serper.dev.`, "warn");
        zeroStreak = 0;
      }
      const seenUrl = /* @__PURE__ */ new Set();
      const uniq = results.filter((r) => {
        const k = r.url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
        if (seenUrl.has(k)) return false;
        seenUrl.add(k);
        return true;
      });
      if (uniq.length) {
        const s3 = loadState();
        const existing = [
          ...s3.investors.map((x) => ({ name: x.name, firm: x.firm })),
          ...c.candidates.map((x) => ({ name: x.name, firm: x.firm }))
        ];
        const found = await extractCandidates(startup, uniq, existing, log, 1, audience);
        for (const f of found) c.candidates.push({ ...f, stage: "found", attempts: 0 });
        log("extract", `${c.candidates.length} ${T.many} found so far (target ${c.target}).`, "success");
      }
      save(c);
      await sleep2(Math.min(PACE_MS(), 4e3));
    }
    if (!alive()) return;
    if (c.phase === "search") {
      c.phase = "quick";
      log("extract", `Search finished \u2014 ${c.candidates.length} possible ${T.many}. Quick-scoring them now\u2026`, "success");
      save(c);
    }
    let upfrontSkips = 0;
    let outsideSkips = 0;
    while (c.phase === "quick" && alive()) {
      const added = c.candidates.filter((x) => x.stage === "quick").length;
      if (added >= c.target) {
        const spare = c.candidates.filter((x) => x.stage === "found").length;
        if (spare) log("score", `Target reached \u2014 ${spare} extra people saved for your next run.`, "info");
        break;
      }
      const todo = c.candidates.filter((x) => x.stage === "found").slice(0, Math.min(10, c.target - added));
      if (!todo.length) break;
      try {
        const scores = await quickScoreCandidates(startup, todo, audience);
        const st4 = loadState();
        const minKeep = settings.minFitScoreToKeep ?? 40;
        const toAdd = [];
        for (const cand of todo) {
          const r = scores.get(cand.id);
          if (!r) {
            cand.attempts = (cand.attempts || 0) + 1;
            if (cand.attempts >= 2) cand.stage = "failed";
            continue;
          }
          cand.quickScore = r.score;
          cand.quickReason = r.reason;
          if (!r.isInvestor || r.score < minKeep || r.upfront || r.outside || audience === "experts" && isNotFundraisingExpert(cand)) {
            cand.stage = "skipped";
            if (r.upfront) upfrontSkips++;
            if (r.outside) outsideSkips++;
            continue;
          }
          const dupe = st4.investors.find((x) => norm(x.name) === norm(cand.name) && (norm(x.firm) === norm(cand.firm) || !cand.firm));
          if (dupe) {
            cand.stage = "skipped";
            continue;
          }
          const inv = candidateToQuickInvestor({ ...cand, audience }, r.score, r.reason, c.id);
          cand.investorId = inv.id;
          cand.stage = "quick";
          toAdd.push(inv);
        }
        if (toAdd.length) mergeInvestors(toAdd);
        if (upfrontSkips || outsideSkips) {
          log("score", `Filtered out ${[upfrontSkips ? `${upfrontSkips} asking for money upfront` : "", outsideSkips ? `${outsideSkips} outside the target country` : ""].filter(Boolean).join(" and ")}.`, "info");
          upfrontSkips = 0;
          outsideSkips = 0;
        }
        log("score", `Quick-scored ${todo.length}: ${toAdd.length} added to your list (${c.candidates.filter((x) => x.stage === "quick").length} total this run).`, "success");
      } catch (e) {
        const msg = String(e?.message || e);
        if (/No AI key/i.test(msg)) throw e;
        for (const cand of todo) {
          cand.attempts = (cand.attempts || 0) + 1;
          if (cand.attempts >= 3) cand.stage = "failed";
        }
        log("score", `AI busy (free limit) \u2014 will retry: ${msg.slice(0, 120)}`, "warn");
        await sleep2(3e4);
      }
      save(c);
      await sleep2(PACE_MS());
    }
    if (!alive()) return;
    if (c.phase === "quick") {
      c.phase = c.mode === "deep" ? "deep" : "done";
      for (const cand of c.candidates) if (cand.stage === "quick") cand.attempts = 0;
      save(c);
    }
    if (c.phase === "deep") {
      const upgrade = c.mode === "upgrade";
      const minDeep = upgrade ? 0 : settings.deepResearchMinScore ?? 50;
      const limit = upgrade ? c.target : Math.max(1, settings.deepResearchPerRun ?? 40);
      const priority = (x) => (x.quickScore || 0) + (/@[a-z0-9-]+\.[a-z]{2,}/i.test(`${x.snippet} ${x.sourceTitle}`) ? 25 : 0) + (x.websiteUrl ? 10 : 0) - (!x.websiteUrl && /linkedin\.com\/in/i.test(x.sourceUrl || x.linkedinUrl || "") ? 10 : 0);
      const queue = c.candidates.filter((x) => x.stage === "quick" && (x.quickScore || 0) >= minDeep).sort((a, b) => priority(b) - priority(a)).slice(0, limit);
      if (queue.length && !upgrade) log("research", `Deep research for the top ${queue.length} (score ${minDeep}+). This is the slow part on free AI plans \u2014 leave it running.`);
      for (let pass = 0; pass < 2 && alive(); pass++) {
        for (const cand of queue) {
          if (!alive()) return;
          if (cand.stage !== "quick") continue;
          const st5 = loadState();
          const existing = st5.investors.find((x) => x.id === cand.investorId);
          if (cand.investorId && !existing) {
            cand.stage = "skipped";
            continue;
          }
          if (existing?.researchDepth === "deep" && !cand.force) {
            cand.stage = "researched";
            continue;
          }
          log("research", `Researching ${cand.name}${cand.firm && !/independent/i.test(cand.firm) ? ` (${cand.firm})` : ""}\u2026`, "info", cand.name);
          try {
            const inv = await researchCandidate(startup, { ...cand, audience }, settings, log);
            if (existing) {
              inv.id = existing.id;
              inv.createdAt = existing.createdAt;
              inv.outreach = { ...inv.outreach, ...keepProgress(existing.outreach) };
            }
            inv.quickScore = cand.quickScore;
            inv.campaignId = c.id;
            inv.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
            mergeInvestors([inv]);
            cand.investorId = inv.id;
            cand.stage = "researched";
            cand.hasEmail = !!inv.email;
            log(
              "score",
              excludedReason(inv, g2) ? `Hidden from your list (not deleted): ${excludedReason(inv, g2)}${inv.upfrontFee === "yes" && inv.feeModel ? ` (${inv.feeModel})` : ""}` : `Fit ${inv.fitScore.total}/100 (${inv.fitScore.status.toUpperCase()})${inv.email ? " \xB7 email found" : ""}${inv.phone ? " \xB7 phone found" : ""}`,
              excludedReason(inv, g2) ? "warn" : "success",
              cand.name
            );
            cand.hasPhone = !!inv.phone;
          } catch (e) {
            const msg = String(e?.message || e);
            if (/No AI key/i.test(msg)) throw e;
            cand.attempts = (cand.attempts || 0) + 1;
            if (pass === 1) cand.stage = "failed";
            log("research", pass === 0 ? "AI busy \u2014 will retry at the end" : `Failed: ${msg.slice(0, 140)}`, pass === 0 ? "warn" : "error", cand.name);
          }
          save(c);
          await sleep2(PACE_MS());
        }
        if (pass === 0 && queue.some((x) => x.stage === "quick") && alive()) {
          log("research", "Waiting 60 seconds before retrying the ones that hit the free AI limit\u2026");
          await sleep2(Number(process.env.AGENT_RETRY_WAIT_MS || 6e4));
        }
      }
      c.phase = "done";
    }
    if (alive()) {
      c.phase = "done";
      c.status = "done";
      c.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
      const k = c.counts || {};
      if (c.mode === "upgrade") {
        const done = c.candidates.filter((x) => x.stage === "researched");
        log("crm", `Finished \u2014 researched ${done.length}; ${done.filter((x) => x.hasEmail).length} now have an email. The rest: use LinkedIn or their website's contact form.`, "success");
      } else if (c.candidates.some((x) => x.stage === "researched")) {
        const done = c.candidates.filter((x) => x.stage === "researched");
        log("crm", `Public contact info for ${done.length} deep-researched ${T.many}: email ${pct(done.filter((x) => x.hasEmail).length, done.length)}, phone ${pct(done.filter((x) => x.hasPhone).length, done.length)}. The rest: LinkedIn or their website's contact form.`, "info");
      }
      if (c.mode !== "upgrade") log("crm", `Run finished \u2014 ${c.candidates.filter((x) => x.stage === "quick" || x.stage === "researched").length} ${T.many} added (${c.candidates.filter((x) => x.stage === "researched").length} deeply researched). Start another run to find the next batch.`, "success");
      save(c);
      void k;
    }
  } catch (e) {
    c.status = "error";
    c.error = String(e?.message || e);
    log("system", `Run stopped: ${c.error}`, "error");
    save(c);
  }
}
function keepProgress(o) {
  if (!o) return {};
  const contacted = ["contacted", "replied", "meeting", "diligence", "passed"].includes(o.status);
  const keep = {};
  for (const k of ["linkedinRequestSentAt", "linkedinAcceptedAt", "linkedinMessagedAt", "autoPaused", "responseNotes", "replyDate"]) if (o[k]) keep[k] = o[k];
  if (contacted) Object.assign(keep, { status: o.status, sentStepsCount: o.sentStepsCount, lastContactedDate: o.lastContactedDate, nextFollowUpDate: o.nextFollowUpDate });
  return keep;
}

// server/automation.ts
var tagOf = (i) => `[${AUDIENCE_TEXT[audienceOf(i)].label}]`;
var TICK_MS = () => Number(process.env.AUTOMATION_TICK_MS || 5 * 6e4);
var CHECK_EVERY_MS = () => Number(process.env.AUTOMATION_CHECK_MS || 15 * 6e4);
var MAX_PER_TICK = () => Number(process.env.AUTOMATION_MAX_PER_TICK || 5);
var CLOSED = ["replied", "meeting", "diligence", "passed"];
var EMAIL_RE2 = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
var todayUtc = () => (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
var addDays = (iso, days) => {
  const d = /* @__PURE__ */ new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
var norm2 = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");
var running = false;
var current = Promise.resolve();
var lastGmailRemaining;
function settingsOf(st) {
  const s = st.settings || {};
  return {
    autoEmailEnabled: !!s.autoEmailEnabled,
    autoEmailMinScore: Number.isFinite(s.autoEmailMinScore) ? s.autoEmailMinScore : 50,
    dailyEmailLimit: Math.max(1, Math.min(1500, Number(s.dailyEmailLimit) || 25)),
    emailHoldMinutes: Math.max(0, Number(s.emailHoldMinutes ?? 60)),
    companyAddress: String(s.companyAddress || "").trim(),
    senderName: String(s.senderName || "").trim(),
    senderEmail: String(s.senderEmail || "").trim(),
    geo: targetGeo(st.startup?.location)
  };
}
var excludedFromOutreach = excludedReason;
function note(level, message) {
  const a = loadState().automation;
  a.recent = [...a.recent || [], { at: (/* @__PURE__ */ new Date()).toISOString(), message, level }].slice(-60);
}
function sentToday() {
  const t = todayUtc();
  return (loadState().automation?.sentLog || []).filter((x) => x.at.startsWith(t)).length;
}
function dueStep(inv, cfg, now = Date.now()) {
  const o = inv.outreach;
  if (!inv.email || !EMAIL_RE2.test(inv.email)) return -1;
  if (o.autoPaused || CLOSED.includes(o.status)) return -1;
  if (excludedFromOutreach(inv, cfg.geo)) return -1;
  if (inv.researchDepth === "quick") return -1;
  if (!o.sequences?.length) return -1;
  if ((inv.fitScore?.total ?? 0) < cfg.autoEmailMinScore) return -1;
  const idx = o.sentStepsCount || 0;
  if (idx >= o.sequences.length) return -1;
  if (o.sequences[idx]?.sentAt) return -1;
  if (idx === 0) {
    const readyAt = Date.parse(inv.extractedData?.crawledAt || inv.createdAt) || 0;
    return now - readyAt >= cfg.emailHoldMinutes * 6e4 ? 0 : -1;
  }
  return o.nextFollowUpDate && o.nextFollowUpDate <= todayUtc() ? idx : -1;
}
function withFooter(body, _startupName, cfg, _founderName) {
  const lines = ["", "--"];
  if (cfg.companyAddress) lines.push(cfg.companyAddress);
  lines.push('If you would rather not hear from me again, just reply "no thanks".');
  return `${body.trimEnd()}
${lines.join("\n")}`;
}
async function sendDue() {
  const st = loadState();
  const cfg = settingsOf(st);
  if (!cfg.autoEmailEnabled) return;
  if (emailProvider() === "none") {
    note("warn", "Auto-email is on, but no email sender is set up (add the Gmail helper script).");
    return;
  }
  let budget = Math.min(cfg.dailyEmailLimit - sentToday(), MAX_PER_TICK());
  if (budget <= 0) return;
  const due = st.investors.map((inv) => ({ inv, step: dueStep(inv, cfg) })).filter((x) => x.step >= 0).sort((a, b) => (b.step > 0 ? 1 : 0) - (a.step > 0 ? 1 : 0) || (b.inv.fitScore?.total || 0) - (a.inv.fitScore?.total || 0));
  const startupName = st.startup?.name || "";
  const founderName = st.startup?.founderName || "";
  const replyTo = st.startup?.founderEmail || cfg.senderEmail || void 0;
  for (const { inv: found, step } of due) {
    if (budget <= 0) break;
    let inv = found;
    if ((inv.outreach.templateV || 1) < TEMPLATE_V) {
      try {
        const o = await generateOutreach(st.startup, inv, st.settings);
        if (o.sequences.length) {
          updateInvestor(inv.id, (i) => ({
            ...i,
            linkedinNote: o.linkedinNote || i.linkedinNote,
            linkedinMessage: o.linkedinMessage || i.linkedinMessage,
            outreach: {
              ...i.outreach,
              // keep emails already sent exactly as they were; replace the rest
              sequences: o.sequences.map((ns, k) => i.outreach.sequences[k]?.sentAt ? i.outreach.sequences[k] : ns),
              sequenceGenerated: true,
              templateV: o.templateV
            }
          }));
          inv = loadState().investors.find((x) => x.id === inv.id) || inv;
          note("info", `${tagOf(inv)} Rebuilt the emails for ${inv.name} from the new template before sending.`);
        }
      } catch (e) {
        note("warn", `${tagOf(inv)} Could not rewrite the emails for ${inv.name} yet (${String(e?.message || e).slice(0, 80)}) \u2014 will try again later.`);
        continue;
      }
    }
    const seq = inv.outreach.sequences[step];
    const res = await sendEmail(
      inv.email,
      seq.subject,
      withFooter(seq.body, startupName, cfg, founderName),
      replyTo,
      cfg.senderName || founderName || void 0,
      AUDIENCE_TEXT[audienceOf(inv)].label
    );
    if (!res.ok) {
      const err = res.error || "send failed";
      updateInvestor(inv.id, (i) => ({ ...i, outreach: { ...i.outreach, autoError: err } }));
      note("error", `${tagOf(inv)} Email to ${inv.name} failed: ${err}`);
      if (/daily|limit|quota/i.test(err)) break;
      if (isSetupError(err)) {
        note("error", `Stopped sending until this is fixed: ${err}`);
        break;
      }
      continue;
    }
    budget--;
    const today2 = todayUtc();
    const next = inv.outreach.sequences[step + 1];
    const nextDate = next ? addDays(today2, Math.max(1, (next.dayDelay ?? 0) - (seq.dayDelay ?? 0))) : "";
    updateInvestor(inv.id, (i) => ({
      ...i,
      outreach: {
        ...i.outreach,
        sequences: i.outreach.sequences.map((s, k) => k === step ? { ...s, sentAt: (/* @__PURE__ */ new Date()).toISOString() } : s),
        status: CLOSED.includes(i.outreach.status) ? i.outreach.status : "contacted",
        sentStepsCount: Math.max(i.outreach.sentStepsCount || 0, step + 1),
        lastContactedDate: today2,
        nextFollowUpDate: nextDate,
        autoError: void 0
      }
    }));
    const a = loadState().automation;
    a.sentLog = [...a.sentLog || [], { at: (/* @__PURE__ */ new Date()).toISOString(), investorId: inv.id, step: step + 1 }].slice(-3e3);
    note("success", `${tagOf(inv)} Sent email ${step + 1} to ${inv.name}${inv.firm ? ` (${inv.firm})` : ""}${next ? ` \u2014 next follow-up ${nextDate}` : " \u2014 sequence complete"}`);
    await new Promise((r) => setTimeout(r, 4e3));
  }
}
async function checkInbox(force = false) {
  if (!gmailConfigured()) return;
  const st = loadState();
  const a = st.automation;
  if (!force && a.lastCheckAt && Date.now() - Date.parse(a.lastCheckAt) < CHECK_EVERY_MS()) return;
  a.lastCheckAt = (/* @__PURE__ */ new Date()).toISOString();
  const watching = st.investors.filter(
    (i) => i.email && EMAIL_RE2.test(i.email) && (i.outreach.sentStepsCount > 0 || i.outreach.status === "contacted") && !CLOSED.includes(i.outreach.status)
  );
  const list = watching.slice(0, 400);
  const tags = {};
  for (const i of list) tags[i.email.toLowerCase()] = AUDIENCE_TEXT[audienceOf(i)].label;
  const res = await gmailCheck(list.map((i) => i.email.toLowerCase()), 60, tags);
  lastGmailRemaining = res.remaining;
  for (const r of res.replies) {
    const inv = watching.find((i) => i.email.toLowerCase() === r.email);
    if (!inv) continue;
    const lastSent = Date.parse(inv.outreach.lastContactedDate || "") || 0;
    if (Date.parse(r.date) < lastSent - 864e5) continue;
    updateInvestor(inv.id, (i) => ({
      ...i,
      outreach: {
        ...i.outreach,
        status: "replied",
        replyDate: r.date.slice(0, 10),
        nextFollowUpDate: "",
        responseNotes: `${i.outreach.responseNotes ? i.outreach.responseNotes + "\n" : ""}${tagOf(i)} Reply (${r.date.slice(0, 10)}): ${r.snippet}`.slice(0, 2e3)
      }
    }));
    note("success", `${tagOf(inv)} ${inv.name} replied \u2014 follow-ups stopped. Check your Gmail (tagged "${AUDIENCE_TEXT[audienceOf(inv)].label}").`);
  }
  for (const acc of res.accepted) {
    const key = norm2(acc.name);
    if (!key) continue;
    const inv = loadState().investors.find(
      (i) => !i.outreach.linkedinAcceptedAt && (norm2(i.name) === key || key.length > 6 && norm2(i.name).startsWith(key))
    );
    if (!inv) continue;
    updateInvestor(inv.id, (i) => ({ ...i, outreach: { ...i.outreach, linkedinAcceptedAt: acc.date } }));
    note("success", `${tagOf(inv)} ${inv.name} accepted your LinkedIn invitation \u2014 send them the message from the Outreach tab.`);
  }
}
function tick(forceCheck = false) {
  if (running) return current;
  current = doTick(forceCheck);
  return current;
}
async function upgradeOldEmails(max = Number(process.env.TEMPLATE_UPGRADE_PER_TICK || 8)) {
  const st = loadState();
  const geo = targetGeo(st.startup?.location);
  const todo = st.investors.filter(
    (i) => i.researchDepth !== "quick" && i.outreach?.sequences?.length && (i.outreach.templateV || 1) < TEMPLATE_V && !CLOSED.includes(i.outreach.status) && !excludedReason(i, geo) && (i.outreach.sentStepsCount || 0) < i.outreach.sequences.length
  ).slice(0, max);
  for (const inv of todo) {
    try {
      const o = await generateOutreach(st.startup, inv, st.settings, { requireAI: true });
      if (!o.sequences.length) continue;
      updateInvestor(inv.id, (i) => ({
        ...i,
        linkedinNote: o.linkedinNote || i.linkedinNote,
        linkedinMessage: o.linkedinMessage || i.linkedinMessage,
        outreach: {
          ...i.outreach,
          sequences: o.sequences.map((ns, k) => i.outreach.sequences[k]?.sentAt ? i.outreach.sequences[k] : ns),
          sequenceGenerated: true,
          templateV: o.templateV
        }
      }));
    } catch {
      break;
    }
  }
}
async function doTick(forceCheck) {
  if (running) return;
  running = true;
  const a = loadState().automation;
  try {
    let setupProblem = "";
    await checkInbox(forceCheck).catch((e) => {
      a.lastError = String(e?.message || e);
      if (isSetupError(a.lastError)) setupProblem = a.lastError;
      else note("warn", `Inbox check failed: ${a.lastError}`);
    });
    if (setupProblem) note("error", `Paused sending and reply checks until this is fixed: ${setupProblem}`);
    else await sendDue();
    await upgradeOldEmails();
    a.lastRunAt = (/* @__PURE__ */ new Date()).toISOString();
    if (!forceCheck) a.lastError = a.lastError && /Inbox check failed/.test(a.lastError) ? a.lastError : void 0;
  } catch (e) {
    a.lastError = String(e?.message || e);
    note("error", a.lastError);
  } finally {
    saveState({ automation: a });
    running = false;
  }
}
function startAutomation() {
  setTimeout(() => tick(), 2e4);
  setInterval(() => tick(), TICK_MS());
}
async function runAutomationNow() {
  if (running) await current;
  await tick(true);
  return automationStatus();
}
async function automationStatus() {
  const st = loadState();
  const cfg = settingsOf(st);
  const a = st.automation || {};
  if (gmailConfigured() && lastGmailRemaining === void 0) lastGmailRemaining = await gmailQuota();
  return {
    emailProvider: emailProvider(),
    autoEmailEnabled: cfg.autoEmailEnabled,
    sentToday: sentToday(),
    dailyLimit: cfg.dailyEmailLimit,
    gmailRemaining: lastGmailRemaining,
    queued: st.investors.filter((i) => dueStep(i, cfg) >= 0).length,
    lastRunAt: a.lastRunAt,
    lastCheckAt: a.lastCheckAt,
    lastError: a.lastError,
    recent: [...a.recent || []].reverse().slice(0, 25)
  };
}

// server/index.ts
var PORT = Number(process.env.PORT) || 8080;
var DIST = path3.resolve(process.env.STATIC_DIR || path3.join(process.cwd(), "dist"));
var PASSWORD = (process.env.APP_PASSWORD || "").trim();
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8"
};
var wantsGzip = (req) => /\bgzip\b/.test(String(req?.headers["accept-encoding"] || ""));
function send(res, status, data, req) {
  const body = JSON.stringify(data);
  if (body.length > 1024 && wantsGzip(req)) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
    res.end(zlib2.gzipSync(body));
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}
var gzCache = /* @__PURE__ */ new Map();
async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}
function authorized(req) {
  if (!PASSWORD) return true;
  const given = String(req.headers["x-app-password"] || "");
  const a = Buffer.from(crypto2.createHash("sha256").update(given).digest("hex"));
  const b = Buffer.from(crypto2.createHash("sha256").update(PASSWORD).digest("hex"));
  return crypto2.timingSafeEqual(a, b);
}
function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  let file2 = path3.join(DIST, path3.normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));
  if (!file2.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs3.existsSync(file2) || fs3.statSync(file2).isDirectory()) file2 = path3.join(DIST, "index.html");
  if (!fs3.existsSync(file2)) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Backend is running. Frontend not built yet \u2014 run `npm run build`.");
    return;
  }
  const ext = path3.extname(file2).toLowerCase();
  const cache2 = /\/assets\//.test(file2) ? "public, max-age=31536000, immutable" : "no-cache";
  if (/\.(js|css|html|svg|json|txt|map)$/.test(ext) && wantsGzip(req)) {
    let gz = gzCache.get(file2);
    if (!gz) {
      gz = zlib2.gzipSync(fs3.readFileSync(file2), { level: 9 });
      gzCache.set(file2, gz);
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": cache2, "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
    res.end(gz);
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": cache2 });
  fs3.createReadStream(file2).pipe(res);
}
var routes = [];
function route(method, pathPattern, handler) {
  const keys = [];
  const pattern = new RegExp("^" + pathPattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, pattern, keys, handler });
}
var need = (cond, msg) => {
  if (!cond) throw Object.assign(new Error(msg), { status: 400 });
};
route("GET", "/api/health", () => ({
  ok: true,
  ai: { configured: aiConfigured(), providers: aiProviderNames() },
  search: { providers: searchProviderNames() },
  email: { configured: emailProvider() !== "none", provider: emailProvider() },
  storage: storageInfo(),
  passwordRequired: Boolean(PASSWORD)
}));
route("GET", "/api/state", (body) => {
  const s = loadState();
  if (body.since) {
    if (body.since === s.updatedAt) return { unchanged: true, updatedAt: s.updatedAt };
    const cutoff = (Date.parse(body.since) || 0) - 5 * 6e4;
    return {
      startup: s.startup,
      settings: s.settings,
      updatedAt: s.updatedAt,
      changed: s.investors.filter((i) => (Date.parse(i.updatedAt || i.createdAt) || 0) >= cutoff),
      ids: s.investors.map((i) => i.id)
    };
  }
  return { startup: s.startup, investors: s.investors, settings: s.settings, updatedAt: s.updatedAt };
});
route("PUT", "/api/state", (body) => {
  need(body && typeof body === "object", "body required");
  if (body.clearAll) clearInvestors();
  if (Array.isArray(body.investors) || Array.isArray(body.deletedIds)) {
    mergeInvestors(Array.isArray(body.investors) ? body.investors : [], Array.isArray(body.deletedIds) ? body.deletedIds : []);
  }
  const s = saveState({ startup: body.startup, settings: body.settings });
  return { ok: true, updatedAt: s.updatedAt };
});
route("GET", "/api/campaign", () => ({ campaign: getCampaign() }));
route("POST", "/api/campaign/start", (body) => {
  need(body.startup?.name, "startup required");
  startCampaign(body.startup, body.settings || {}, { target: Number(body.target) || 100, mode: body.mode === "quick" ? "quick" : "deep" });
  return { campaign: getCampaign() };
});
route("POST", "/api/campaign/upgrade", (body) => {
  need(body.startup?.name, "startup required");
  const r = startUpgrade(body.startup, body.settings || {}, Number(body.count) || 20);
  return { campaign: r.campaign ? getCampaign() : null, available: r.available };
});
route("POST", "/api/campaign/pause", () => ({ ok: pauseCampaign(), campaign: getCampaign() }));
route("POST", "/api/campaign/resume", () => ({ ok: resumeCampaign(), campaign: getCampaign() }));
route("POST", "/api/research-investor", async (body) => {
  need(body.startup?.name && body.investor?.id, "startup and investor required");
  const inv = await researchCandidate(body.startup, investorToCandidate(body.investor), body.settings);
  inv.id = body.investor.id;
  inv.createdAt = body.investor.createdAt || inv.createdAt;
  inv.quickScore = body.investor.quickScore;
  inv.campaignId = body.investor.campaignId;
  const o = body.investor.outreach || {};
  const keep = {};
  for (const k of ["linkedinRequestSentAt", "linkedinAcceptedAt", "linkedinMessagedAt", "autoPaused", "responseNotes", "replyDate"]) if (o[k]) keep[k] = o[k];
  if (["contacted", "replied", "meeting", "diligence", "passed"].includes(o.status)) Object.assign(keep, { status: o.status });
  inv.outreach = { ...inv.outreach, ...keep };
  inv.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  mergeInvestors([inv]);
  return { investor: inv };
});
route("GET", "/api/automation/status", async () => await automationStatus());
route("POST", "/api/automation/run", async () => await runAutomationNow());
route("POST", "/api/product/analyze", async (body) => {
  need(body.startup?.name, "startup required");
  return { intel: await analyzeProduct(body.startup, body.settings) };
});
route("POST", "/api/discover", async (body) => {
  need(body.startup?.name, "startup required");
  let queries = Array.isArray(body.queries) ? body.queries.filter((q) => typeof q === "string" && q.trim()) : [];
  if (body.query) {
    const q = String(body.query).trim();
    queries = body.mode === "linkedin" && !/site:/i.test(q) ? [`site:linkedin.com/in ${q}`] : [q];
  }
  if (!queries.length) {
    const d = defaultQueries(body.startup, body.settings);
    queries = body.mode === "linkedin" ? d.linkedin : body.mode === "web" ? d.web : [...d.linkedin.slice(0, 3), ...d.web.slice(0, 3)];
  }
  const logs = [];
  const { candidates, rawResults } = await discoverCandidates(body.startup, queries.slice(0, 10), body.existing || [], (_p, m) => logs.push(m), audienceOf(body.settings));
  return { candidates, resultsSearched: rawResults.length, queries, logs };
});
route("POST", "/api/research", async (body) => {
  need(body.startup?.name && body.candidate?.name, "startup and candidate required");
  return { investor: await researchCandidate(body.startup, body.candidate, body.settings) };
});
route("POST", "/api/score", async (body) => {
  need(body.startup?.name && body.investor?.name, "startup and investor required");
  return await scoreInvestor(body.startup, body.investor);
});
route("POST", "/api/outreach", async (body) => {
  need(body.startup?.name && body.investor?.name, "startup and investor required");
  return await generateOutreach(body.startup, body.investor, body.settings);
});
route("POST", "/api/linkedin/find", async (body) => {
  need(body.name, "name required");
  return { linkedin: await findLinkedInProfile(String(body.name), String(body.firm || "")) };
});
route("POST", "/api/search/raw", async (body) => {
  need(body.query, "query required");
  return await webSearch(String(body.query), Math.min(Number(body.max) || 10, 20));
});
route("POST", "/api/email/send", async (body) => {
  need(body.to && body.subject && body.body, "to, subject and body required");
  return await sendEmail(String(body.to), String(body.subject), String(body.body), body.replyTo, body.fromName, body.label);
});
route("POST", "/api/sheet", async (body) => {
  if (!gmailConfigured()) throw Object.assign(new Error("the Gmail helper script is not connected to this server. Add GMAIL_SCRIPT_URL and GMAIL_SCRIPT_SECRET to your hosting variables (Railway / Render \u2192 Environment) and redeploy."), { status: 400 });
  const st = loadState();
  const first = audienceOf(body);
  const order = first === "experts" ? ["experts", "investors"] : ["investors", "experts"];
  const tabs = [
    ...order.map((aud) => sheetTab(st.investors.filter((i) => audienceOf(i) === aud), aud)),
    sheetTab(st.investors, "all")
    // 3rd tab: everyone together, with a Type column
  ];
  const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const r = await gmailSheet(`${st.startup?.name || "Startup"} \u2014 Investors & Fundraising Experts \u2014 ${date}`, tabs);
  return { url: r.url, rows: r.rows, tabs: r.tabs };
});
route("GET", "/api/gmail/test", async () => await gmailTest());
function sheetTab(list, aud) {
  const both = aud === "all";
  const I = AUDIENCE_TEXT.investors;
  const E = AUDIENCE_TEXT.experts;
  const T = both ? I : AUDIENCE_TEXT[aud];
  const lbl = (inv, exp) => both ? inv === exp ? inv : `${inv} / ${exp}` : aud === "experts" ? exp : inv;
  const geo = targetGeo(loadState().startup?.location);
  const d = (x) => x ? String(x).slice(0, 10) : "";
  const cols = [
    ["Type", (i) => AUDIENCE_TEXT[audienceOf(i)].label],
    ["Name", (i) => i.name],
    ["Title", (i) => i.title],
    [lbl("Firm", "Company"), (i) => i.firm],
    [lbl("Investor type", "Expert type"), (i) => i.investorType || ""],
    ["Filtered out?", (i) => excludedReason(i, geo) || "no"],
    ["Fit score", (i) => i.fitScore?.total ?? ""],
    ["Fit", (i) => i.fitScore?.status || ""],
    ["Verdict", (i) => i.fitScore?.verdict || ""],
    [`${lbl(I.fit.thesis, E.fit.thesis)} match`, (i) => i.fitScore?.thesisMatch ?? ""],
    [`${lbl(I.fit.stage, E.fit.stage)} match`, (i) => i.fitScore?.stageMatch ?? ""],
    [`${lbl(I.fit.sector, E.fit.sector)} match`, (i) => i.fitScore?.sectorMatch ?? ""],
    [`${lbl(I.fit.check, E.fit.check)} match`, (i) => i.fitScore?.checkSizeMatch ?? ""],
    [`${lbl(I.fit.synergy, E.fit.synergy)} match`, (i) => i.fitScore?.synergyMatch ?? ""],
    [lbl(I.field.why, E.field.why), (i) => (i.fitScore?.whyInvest || []).join(" | ")],
    ["Concerns", (i) => (i.fitScore?.hesitations || []).join(" | ")],
    ["Best opening hook", (i) => i.fitScore?.keyTalkingPoint || ""],
    ["Email", (i) => i.email || ""],
    ["Phone", (i) => i.phone || ""],
    ["LinkedIn", (i) => i.linkedin || ""],
    ["Twitter / X", (i) => i.twitter || ""],
    ["Website", (i) => i.website || ""],
    ["Best way to contact", (i) => i.contactRoute || ""],
    ["Location", (i) => i.location || ""],
    ["Country", (i) => i.country || ""],
    [lbl(I.field.stage, E.field.stage), (i) => i.stage || ""],
    [lbl(I.field.check, E.field.check), (i) => i.checkSizeFormatted || ""],
    ["How they charge", (i) => i.feeModel || ""],
    ["Asks for money upfront?", (i) => i.upfrontFee === "yes" ? "YES \u2014 filtered out" : i.upfrontFee || "unknown"],
    ["Industries", (i) => (i.industries || []).join(", ")],
    [lbl(I.field.portfolio, E.field.portfolio), (i) => (i.portfolio || []).join(", ")],
    [lbl("Recent investments", "Raises / clients they helped"), (i) => (i.recentInvestments || []).map((r) => [r.name, r.year, r.sector, r.note].filter(Boolean).join(" \xB7 ")).join(" | ")],
    [lbl(I.field.thesis, E.field.thesis), (i) => i.thesis || ""],
    ["Research notes", (i) => i.researchNotes || ""],
    ["Key quotes", (i) => (i.extractedData?.keyQuotes || []).join(" | ")],
    ["Research", (i) => i.researchDepth === "quick" ? "Quick scan only" : "Deep research"],
    ["Quick-scan score", (i) => i.quickScore ?? ""],
    ["Outreach status", (i) => i.outreach?.status || ""],
    ["Emails sent", (i) => `${i.outreach?.sentStepsCount || 0} of ${i.outreach?.sequences?.length || 0}`],
    ["Auto-email", (i) => i.outreach?.autoPaused ? "paused" : "on"],
    ["Last contacted", (i) => d(i.outreach?.lastContactedDate)],
    ["Next follow-up", (i) => d(i.outreach?.nextFollowUpDate)],
    ["Replied on", (i) => d(i.outreach?.replyDate)],
    ["Reply / meeting notes", (i) => i.outreach?.responseNotes || ""],
    ["LinkedIn request sent", (i) => d(i.outreach?.linkedinRequestSentAt)],
    ["LinkedIn accepted", (i) => d(i.outreach?.linkedinAcceptedAt)],
    ["LinkedIn messaged", (i) => d(i.outreach?.linkedinMessagedAt)],
    ["LinkedIn note", (i) => i.linkedinNote || ""],
    ["LinkedIn message", (i) => i.linkedinMessage || ""]
  ];
  for (let k = 0; k < 4; k++) {
    cols.push([`Email ${k + 1} subject`, (i) => i.outreach?.sequences?.[k]?.subject || ""]);
    cols.push([`Email ${k + 1} (day ${[0, 4, 10, 21][k]})`, (i) => i.outreach?.sequences?.[k]?.body || ""]);
    cols.push([`Email ${k + 1} sent`, (i) => d(i.outreach?.sequences?.[k]?.sentAt)]);
  }
  cols.push(
    ["Website page title", (i) => i.extractedData?.pageTitle || ""],
    ["Sources", (i) => (i.sourceUrls || []).join(" ")],
    ["Tags", (i) => (i.tags || []).join(", ")],
    ["Added on", (i) => d(i.createdAt)],
    ["Updated on", (i) => d(i.updatedAt)]
  );
  const out = (i) => excludedReason(i, geo) ? 1 : 0;
  const sorted = [...list].sort((a, b) => out(a) - out(b) || (b.fitScore?.total || 0) - (a.fitScore?.total || 0));
  void T;
  return { name: both ? "All (Investors + Experts)" : aud === "experts" ? "Fundraising Experts" : "Investors", headers: cols.map((c) => c[0]), rows: sorted.map((i) => cols.map((c) => c[1](i) ?? "")) };
}
route("POST", "/api/agent/run", (body) => {
  need(body.startup?.name, "startup required");
  const job = startAgentJob(body.startup, body.settings || {}, body.existing || [], {
    refreshProduct: Boolean(body.refreshProduct),
    extraQueries: Array.isArray(body.extraQueries) ? body.extraQueries : []
  });
  return { jobId: job.id };
});
route("GET", "/api/agent/jobs/latest", () => ({ job: latestJob() || null }));
route("GET", "/api/agent/jobs/:id", (_b, p) => {
  const job = getJob(p.id);
  if (!job) throw Object.assign(new Error("job not found (server may have restarted)"), { status: 404 });
  return { job };
});
route("POST", "/api/agent/jobs/:id/cancel", (_b, p) => ({ ok: cancelJob(p.id) }));
var server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (!url.startsWith("/api/")) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    serveStatic(req, res);
    return;
  }
  if (url !== "/api/health" && !authorized(req)) {
    send(res, 401, { error: "Password required" });
    return;
  }
  const r = routes.find((x) => x.method === req.method && x.pattern.test(url));
  if (!r) {
    send(res, 404, { error: "Not found" });
    return;
  }
  try {
    const m = url.match(r.pattern);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const body = req.method === "GET" ? Object.fromEntries(new URLSearchParams((req.url || "").split("?")[1] || "")) : await readBody(req);
    const out = await r.handler(body, params);
    send(res, 200, out, req);
  } catch (e) {
    const status = e?.status || 500;
    if (status >= 500) console.error(`[api] ${req.method} ${url}:`, e?.message);
    send(res, status, { error: String(e?.message || e) }, req);
  }
});
server.requestTimeout = 0;
server.headersTimeout = 65e3;
await restoreFromBackup();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`SafeCart Kids Investor Agent on :${PORT}`);
  startAutomation();
  resumeOnBoot();
  console.log(`  AI providers:     ${aiProviderNames().join(", ") || "NONE \u2014 set GEMINI_API_KEY or GROQ_API_KEY"}`);
  console.log(`  Search providers: ${searchProviderNames().join(", ")}`);
  console.log(`  Email:            ${emailProvider()}`);
  console.log(`  Storage:          ${storageInfo().path}`);
  if (!PASSWORD) console.log("  WARNING: APP_PASSWORD not set \u2014 anyone with the URL can use your free AI quota.");
});
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    setTimeout(() => process.exit(0), 12e3).unref();
    await shutdownSave().catch(() => flushNow());
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
