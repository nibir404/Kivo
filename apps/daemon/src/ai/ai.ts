import { configure, GROQ_DEFAULTS, type ProviderConfig } from "@kivo/ai/client"

/**
 * The daemon's AI providers, from its environment (.env). Keys stay in this process: they're
 * removed from every child process Kivo starts (see SECRET_ENV) and never sent to the browser.
 * The client itself (streaming, failover, rate limits) is @kivo/ai, shared with the browser.
 */

const env = process.env
const list = (v: string | undefined, fallback: string[]) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : fallback)

/** Env vars holding provider secrets — stripped from every child process Kivo starts. */
export const SECRET_ENV = ["GROQ_API_KEY", "PUKU_API_KEY", "OPENAI_COMPAT_API_KEY"]

export const PROVIDERS: ProviderConfig[] = [
  {
    ...GROQ_DEFAULTS,
    baseUrl: env.GROQ_BASE_URL ?? GROQ_DEFAULTS.baseUrl,
    key: env.GROQ_API_KEY,
    models: list([env.GROQ_MODEL, env.GROQ_FALLBACK_MODELS].filter(Boolean).join(",") || undefined, GROQ_DEFAULTS.models),
    tokenBudget: Number(env.GROQ_TPM ?? GROQ_DEFAULTS.tokenBudget),
  },
  {
    id: "puku",
    label: "Puku",
    baseUrl: env.PUKU_BASE_URL ?? "https://api.puku.sh/v1",
    key: env.PUKU_API_KEY,
    authHeader: env.PUKU_AUTH_HEADER ?? "authorization",
    models: list(env.PUKU_MODELS, ["puku-default", "puku-fast"]),
    reasoningEffort: false,
    jsonMode: env.PUKU_JSON_MODE === "1",
    tokenBudget: Number(env.PUKU_TPM ?? 32000),
  },
  {
    id: "custom",
    label: env.OPENAI_COMPAT_LABEL ?? "OpenAI-compatible",
    baseUrl: env.OPENAI_COMPAT_BASE_URL ?? "",
    key: env.OPENAI_COMPAT_API_KEY,
    models: list(env.OPENAI_COMPAT_MODELS, []),
    reasoningEffort: false,
    jsonMode: env.OPENAI_COMPAT_JSON_MODE !== "0",
    tokenBudget: Number(env.OPENAI_COMPAT_TPM ?? 32000),
  },
]

configure(PROVIDERS, { active: env.KIVO_PROVIDER ?? "groq", crossProvider: env.KIVO_CROSS_PROVIDER_FAILOVER !== "0" })

export * from "@kivo/ai/client"
