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
