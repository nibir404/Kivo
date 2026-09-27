/** Language → compatible frameworks. Framework options depend on the selected language. */
export interface LanguageDef {
  id: string
  name: string
  frameworks: { id: string; name: string; note: string; mvp?: boolean }[]
  mvp?: boolean
}

export const LANGUAGES: LanguageDef[] = [
  {
    id: "python",
    name: "Python",
    mvp: true,
    frameworks: [
      { id: "fastapi", name: "FastAPI", note: "Async, typed, OpenAPI out of the box", mvp: true },
      { id: "django", name: "Django", note: "Batteries-included, ORM + admin" },
      { id: "flask", name: "Flask", note: "Minimal, explicit" },
      { id: "core", name: "Core Python", note: "Standard library only" },
    ],
  },
  {
    id: "typescript",
    name: "TypeScript",
    mvp: true,
    frameworks: [
      { id: "node", name: "Node.js", note: "Plain http runtime", mvp: true },
      { id: "express", name: "Express", note: "Ubiquitous middleware model", mvp: true },
      { id: "nestjs", name: "NestJS", note: "Modules, DI, decorators" },
      { id: "hono", name: "Hono", note: "Edge-first, tiny" },
      { id: "bun", name: "Bun", note: "Fast runtime with built-in server" },
    ],
  },
  {
    id: "go",
    name: "Go",
    frameworks: [
      { id: "stdlib", name: "Standard Library", note: "net/http" },
      { id: "gin", name: "Gin", note: "Fast router, large ecosystem" },
      { id: "fiber", name: "Fiber", note: "Express-like API" },
      { id: "echo", name: "Echo", note: "Minimal and extensible" },
      { id: "chi", name: "Chi", note: "Composable, stdlib-compatible" },
    ],
  },
  {
    id: "rust",
    name: "Rust",
    frameworks: [
      { id: "axum", name: "Axum", note: "Tokio + Tower" },
      { id: "actix", name: "Actix Web", note: "Actor-based, very fast" },
    ],
  },
  {
    id: "java",
    name: "Java",
    frameworks: [
      { id: "spring", name: "Spring Boot", note: "Enterprise standard" },
      { id: "quarkus", name: "Quarkus", note: "Cloud-native, fast startup" },
    ],
  },
  {
    id: "kotlin",
    name: "Kotlin",
    frameworks: [
      { id: "ktor", name: "Ktor", note: "Coroutine-native" },
      { id: "spring-kt", name: "Spring Boot", note: "Kotlin DSL" },
    ],
  },
  {
    id: "swift",
    name: "Swift",
    frameworks: [{ id: "vapor", name: "Vapor", note: "Server-side Swift" }],
  },
  {
    id: "dart",
    name: "Dart",
    frameworks: [{ id: "shelf", name: "Shelf", note: "Composable web server" }],
  },
  {
    id: "cpp",
    name: "C++",
    frameworks: [{ id: "drogon", name: "Drogon", note: "Async HTTP framework" }],
  },
]

export const DATABASES = ["PostgreSQL", "MySQL", "SQLite", "MongoDB"]
export const CACHES = ["Redis", "None"]

export function frameworksFor(language: string) {
  return LANGUAGES.find((l) => l.id === language)?.frameworks ?? []
}

export function languageName(id: string) {
  return LANGUAGES.find((l) => l.id === id)?.name ?? id
}

export function frameworkName(language: string, id: string) {
  return frameworksFor(language).find((f) => f.id === id)?.name ?? id
}

// ─── Toolchains ───────────────────────────────────────────────────────────────

/**
 * What each language needs to be built, tested and run. `buildable` means Kivo's daemon has a
 * real, verified pipeline for it (generate → install → lint → test → boot). Every other language
 * can be planned and reviewed, but Kivo will not pretend to build it.
 */
export interface Toolchain {
  ext: string
  install: string
  test: string
  runtime: string
  orm: string
  buildable: boolean
  /** Shell command that runs the service's tests from the workspace root. */
  testCommand?: (serviceId: string) => string
}

export const TOOLCHAINS: Record<string, Toolchain> = {
  python: { ext: "py", install: "pip (venv)", test: "pytest", runtime: "uvicorn", orm: "SQLAlchemy 2.0", buildable: true, testCommand: (id) => `cd services/${id} && pytest -q` },
  typescript: { ext: "ts", install: "pnpm", test: "vitest", runtime: "node", orm: "Drizzle ORM", buildable: false },
  go: { ext: "go", install: "go mod", test: "go test", runtime: "go run", orm: "sqlc", buildable: false },
  rust: { ext: "rs", install: "cargo", test: "cargo test", runtime: "cargo run", orm: "sqlx", buildable: false },
  java: { ext: "java", install: "Maven", test: "JUnit 5", runtime: "Spring Boot", orm: "Spring Data JPA", buildable: false },
  kotlin: { ext: "kt", install: "Gradle", test: "JUnit 5", runtime: "JVM", orm: "Exposed", buildable: false },
  swift: { ext: "swift", install: "SwiftPM", test: "XCTest", runtime: "swift run", orm: "Fluent", buildable: false },
  dart: { ext: "dart", install: "pub", test: "dart test", runtime: "dart run", orm: "drift", buildable: false },
  cpp: { ext: "cpp", install: "CMake", test: "GoogleTest", runtime: "native binary", orm: "sqlite_orm", buildable: false },
}

export function toolchainFor(language: string): Toolchain {
  return TOOLCHAINS[language] ?? { ext: "txt", install: "—", test: "—", runtime: "—", orm: "—", buildable: false }
}

export const BUILDABLE_LANGUAGES = LANGUAGES.filter((l) => toolchainFor(l.id).buildable)

// ─── Language detection ───────────────────────────────────────────────────────

/**
 * Deterministic: when a description names a language or framework ("…using Java", "in Spring
 * Boot"), that choice wins over the stack picker. Returns null when nothing is named.
 * Ambiguous words ("go", "express", "node") only count in an explicit phrase.
 */
const MENTIONS: { re: RegExp; language: string; framework?: string }[] = [
  { re: /\bspring[\s-]?boot\b|\bspring\b/i, language: "java", framework: "spring" },
  { re: /\bquarkus\b/i, language: "java", framework: "quarkus" },
  { re: /\bktor\b/i, language: "kotlin", framework: "ktor" },
  { re: /\bkotlin\b/i, language: "kotlin" },
  { re: /\bjava\b(?!\s*script)/i, language: "java" },
  { re: /\bfastapi\b/i, language: "python", framework: "fastapi" },
  { re: /\bdjango\b/i, language: "python", framework: "django" },
  { re: /\bflask\b/i, language: "python", framework: "flask" },
  { re: /\bpython\b/i, language: "python" },
  { re: /\bnest\.?js\b/i, language: "typescript", framework: "nestjs" },
  { re: /\bexpress(\.js|js)\b|\b(with|using|in) express\b/i, language: "typescript", framework: "express" },
  { re: /\bhono\b/i, language: "typescript", framework: "hono" },
  { re: /\bnode\.?js\b/i, language: "typescript", framework: "node" },
  { re: /\btypescript\b|\bjavascript\b/i, language: "typescript" },
  { re: /\bgin\b(?= (framework|router|server))|\b(with|using) gin\b/i, language: "go", framework: "gin" },
  { re: /\bgolang\b|\b(in|using|with|written in) go\b/i, language: "go" },
  { re: /\baxum\b/i, language: "rust", framework: "axum" },
  { re: /\bactix\b/i, language: "rust", framework: "actix" },
  { re: /\brust\b/i, language: "rust" },
  { re: /\bvapor\b/i, language: "swift", framework: "vapor" },
  { re: /\bswift\b/i, language: "swift" },
  { re: /\bdart\b/i, language: "dart" },
  { re: /\bc\+\+|\bcpp\b/i, language: "cpp" },
]

export function detectStack(text: string): { language: string; framework: string } | null {
  const hit = MENTIONS.find((m) => m.re.test(text))
  if (!hit) return null
  const framework = hit.framework ?? LANGUAGES.find((l) => l.id === hit.language)?.frameworks[0]?.id ?? ""
  return { language: hit.language, framework }
}
