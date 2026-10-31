/**
 * AI layer — talks to FREE hosted LLM APIs (no local install, no credit card).
 *
 * Every provider below exposes an OpenAI-compatible /chat/completions endpoint,
 * so one small client handles all of them. Add whichever keys you have as
 * Railway variables; the agent uses them in this order and automatically
 * falls back to the next one when a free quota / rate limit is hit.
 *
 *   GEMINI_API_KEY      Google AI Studio  (free tier, no card)   ← recommended
 *   GROQ_API_KEY        console.groq.com  (free tier, no card)
 *   OPENROUTER_API_KEY  openrouter.ai     (free ":free" models, no card)
 *   HF_TOKEN            huggingface.co    (small free monthly credit)
 *   AI_BASE_URL + AI_API_KEY + AI_MODEL   any other OpenAI-compatible API
 *
 * Optional model overrides: GEMINI_MODEL, GROQ_MODEL, OPENROUTER_MODEL, HF_MODEL.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface Provider {
  name: string;
  baseUrl: string;
  apiKey: string;
  /** Explicit model from env, or null to auto-discover. */
  fixedModel: string | null;
  discover: (p: Provider) => Promise<string[]>;
  jsonMode: boolean;
  models?: string[];
  modelIndex: number;
  cooldownUntil: number;
}

const env = (k: string) => (process.env[k] || '').trim();

async function listOpenAiModels(p: Provider): Promise<string[]> {
  const res = await fetch(`${p.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${p.apiKey}` },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`${p.name} /models -> ${res.status}`);
  const data: any = await res.json();
  return (data?.data || []).map((m: any) => String(m.id));
}

function rankByPatterns(ids: string[], patterns: RegExp[], exclude: RegExp): string[] {
  const out: string[] = [];
  for (const pat of patterns) {
    for (const id of ids.filter(i => pat.test(i) && !exclude.test(i)).sort().reverse()) {
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

async function discoverGemini(p: Provider): Promise<string[]> {
  // Native model list tells us which models support generateContent.
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(p.apiKey)}`,
    { signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error(`gemini models -> ${res.status} ${await res.text().catch(() => '')}`);
  const data: any = await res.json();
  const ids: string[] = (data?.models || [])
    .filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m: any) => String(m.name).replace(/^models\//, ''));
  const exclude = /(image|tts|audio|live|embed|vision|learnlm|gemma|robotics|computer|native|exp-\d|customtools)/i;
  // Flash models are on the free tier; Pro usually is not.
  const ranked = rankByPatterns(
    ids,
    [/^gemini-[\d.]+-flash$/i, /^gemini-flash-latest$/i, /^gemini-[\d.]+-flash-lite$/i, /^gemini-flash-lite-latest$/i, /flash/i],
    exclude
  );
  return ranked.length ? ranked : ['gemini-flash-latest', 'gemini-2.5-flash'];
}

async function discoverGroq(p: Provider): Promise<string[]> {
  const ids = await listOpenAiModels(p);
  const ranked = rankByPatterns(
    ids,
    [/llama-3\.3-70b/i, /gpt-oss-120b/i, /llama-4/i, /qwen/i, /gpt-oss/i, /llama/i],
    /(guard|whisper|tts|playai|compound|prompt)/i
  );
  return ranked.length ? ranked : ['llama-3.3-70b-versatile'];
}

async function discoverOpenRouter(p: Provider): Promise<string[]> {
  const ids = await listOpenAiModels(p);
  const free = ids.filter(i => i.endsWith(':free'));
  const ranked = rankByPatterns(free, [/llama-3\.3-70b/i, /deepseek/i, /qwen/i, /gemini/i, /llama/i, /./], /(vision|vl-)/i);
  return ranked.length ? ranked : ['meta-llama/llama-3.3-70b-instruct:free'];
}

function buildProviders(): Provider[] {
  const list: Provider[] = [];
  const add = (p: Omit<Provider, 'modelIndex' | 'cooldownUntil'>) => list.push({ ...p, modelIndex: 0, cooldownUntil: 0 });

  if (env('GEMINI_API_KEY')) {
    add({
      name: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: env('GEMINI_API_KEY'),
      fixedModel: env('GEMINI_MODEL') || null,
      discover: discoverGemini,
      jsonMode: true
    });
  }
  if (env('GROQ_API_KEY')) {
    add({
      name: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: env('GROQ_API_KEY'),
      fixedModel: env('GROQ_MODEL') || null,
      discover: discoverGroq,
      jsonMode: true
    });
  }
  if (env('OPENROUTER_API_KEY')) {
    add({
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: env('OPENROUTER_API_KEY'),
      fixedModel: env('OPENROUTER_MODEL') || null,
      discover: discoverOpenRouter,
      jsonMode: false
    });
  }
  if (env('HF_TOKEN')) {
    add({
      name: 'huggingface',
      baseUrl: 'https://router.huggingface.co/v1',
      apiKey: env('HF_TOKEN'),
      fixedModel: env('HF_MODEL') || 'meta-llama/Llama-3.3-70B-Instruct',
      discover: async () => ['meta-llama/Llama-3.3-70B-Instruct'],
      jsonMode: false
    });
  }
  if (env('AI_BASE_URL') && env('AI_MODEL')) {
    add({
      name: 'custom',
      baseUrl: env('AI_BASE_URL').replace(/\/+$/, ''),
      apiKey: env('AI_API_KEY'),
      fixedModel: env('AI_MODEL'),
      discover: async () => [env('AI_MODEL')],
      jsonMode: false
    });
  }
  return list;
}

let providers: Provider[] | null = null;
function getProviders(): Provider[] {
  if (!providers) providers = buildProviders();
  return providers;
}

export function aiProviderNames(): string[] {
  return getProviders().map(p => p.name);
}

export function aiConfigured(): boolean {
  return getProviders().length > 0;
}

async function ensureModels(p: Provider): Promise<string[]> {
  if (p.models && p.models.length) return p.models;
  if (p.fixedModel) {
    p.models = [p.fixedModel];
    return p.models;
  }
  try {
    p.models = (await p.discover(p)).slice(0, 6);
  } catch (e: any) {
    console.warn(`[ai] model discovery failed for ${p.name}: ${e?.message}`);
    p.models = [];
  }
  return p.models;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class AiError extends Error {}

/** Low-level call. Returns the raw text of the first choice. */
export async function chat(
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: number; maxTokens?: number } = {}
): Promise<{ text: string; provider: string; model: string }> {
  const list = getProviders();
  if (!list.length) {
    throw new AiError(
      'No AI key configured. Add GEMINI_API_KEY (free at aistudio.google.com, no card) or GROQ_API_KEY (free at console.groq.com) in Railway → Variables.'
    );
  }

  const errors: string[] = [];
  // Free tiers hit per-minute limits often. Instead of giving up after one round,
  // keep cycling providers for up to ~3 minutes, waiting for the earliest cool-down.
  const COOLDOWN_MS = Number(env('AI_COOLDOWN_MS') || 15000);
  const deadline = Date.now() + Number(env('AI_MAX_WAIT_MS') || 180000);
  for (let pass = 0; pass < 8 && Date.now() < deadline; pass++) {
    if (pass > 0) {
      const now = Date.now();
      const soonest = Math.min(...list.map(p => Math.max(p.cooldownUntil, now)));
      const wait = Math.min(Math.max(soonest - now, Math.min(5000, COOLDOWN_MS)), 60000, Math.max(deadline - now, 0));
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
          const body: any = {
            model,
            messages,
            temperature: opts.temperature ?? 0.3,
            max_tokens: opts.maxTokens ?? 4000
          };
          if (opts.json && p.jsonMode) body.response_format = { type: 'json_object' };
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (p.apiKey) headers.Authorization = `Bearer ${p.apiKey}`;
          if (p.name === 'openrouter') {
            headers['HTTP-Referer'] = env('APP_URL') || 'https://railway.app';
            headers['X-Title'] = 'SafeCart Kids Investor Agent';
          }
          const res = await fetch(`${p.baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120000)
          });
          if (res.status === 429 || res.status === 503 || res.status === 529) {
            const retryAfter = Number(res.headers.get('retry-after')) || 0;
            const txt = await res.text().catch(() => '');
            errors.push(`${p.name}/${model}: ${res.status} ${res.status === 429 ? 'rate limited' : 'busy'}`);
            // server busy (503/529) → just try this provider's next model
            if (res.status !== 429) {
              if (attempt === models.length - 1) p.cooldownUntil = Date.now() + COOLDOWN_MS;
              continue;
            }
            // daily quota exhausted → move to the next model; per-minute → short cool-down
            const daily = /per.?day|daily|PerDay|RPD|TPD/i.test(txt) && !/per.?minute|PerMinute|RPM|TPM/i.test(txt);
            if (daily) {
              p.modelIndex = (p.modelIndex + 1) % models.length;
              if (attempt === models.length - 1) p.cooldownUntil = Date.now() + 10 * 60000;
              continue;
            }
            p.cooldownUntil = Date.now() + Math.min(Math.max(retryAfter * 1000, COOLDOWN_MS), 60000);
            break; // go to next provider
          }
          if (res.status === 404 || res.status === 400) {
            const txt = await res.text().catch(() => '');
            // model unknown / json mode unsupported → try next model, or retry without json mode
            if (res.status === 400 && opts.json && p.jsonMode && /response_format|json/i.test(txt)) {
              p.jsonMode = false;
              attempt--;
              continue;
            }
            errors.push(`${p.name}/${model}: ${res.status} ${txt.slice(0, 160)}`);
            continue;
          }
          if (!res.ok) {
            const txt = await res.text().catch(() => '');
            errors.push(`${p.name}/${model}: ${res.status} ${txt.slice(0, 160)}`);
            if (res.status === 401 || res.status === 403) break; // bad key → next provider
            continue;
          }
          const data: any = await res.json();
          const text: string = data?.choices?.[0]?.message?.content ?? '';
          if (!text.trim()) {
            errors.push(`${p.name}/${model}: empty response`);
            continue;
          }
          p.modelIndex = (p.modelIndex + attempt) % models.length; // stick with what works
          return { text, provider: p.name, model };
        } catch (e: any) {
          errors.push(`${p.name}/${model}: ${e?.name === 'TimeoutError' ? 'timeout' : e?.message}`);
        }
      }
    }
  }
  throw new AiError(`All AI providers failed: ${errors.slice(-6).join(' | ')}`);
}

/** Pull the first JSON object/array out of a model reply (handles ```json fences and chatter). */
export function extractJson<T = any>(text: string): T {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  t = t.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const firstObj = t.indexOf('{');
  const firstArr = t.indexOf('[');
  const start = firstArr !== -1 && (firstObj === -1 || firstArr < firstObj) ? firstArr : firstObj;
  if (start === -1) throw new AiError('AI did not return JSON');
  const open = t[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
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
          // tolerate trailing commas
          return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
        }
      }
    }
  }
  throw new AiError('AI returned truncated JSON');
}

/** Ask for JSON and parse it; one automatic retry with a stricter reminder. */
export async function chatJson<T = any>(system: string, user: string, maxTokens = 4000): Promise<T> {
  const messages: ChatMessage[] = [
    { role: 'system', content: `${system}\n\nRespond with ONE valid JSON object only. No markdown, no commentary.` },
    { role: 'user', content: user }
  ];
  const first = await chat(messages, { json: true, maxTokens });
  try {
    return extractJson<T>(first.text);
  } catch {
    const second = await chat(
      [
        ...messages,
        { role: 'assistant', content: first.text.slice(0, 2000) },
        { role: 'user', content: 'That was not valid JSON. Reply again with ONLY the complete, valid JSON object.' }
      ],
      { json: true, maxTokens, temperature: 0.1 }
    );
    return extractJson<T>(second.text);
  }
}
