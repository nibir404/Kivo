import type { Detection, Discipline, ProjectAnalysis, TechCategory } from "./types"

/**
 * Project Intelligence — deterministic. No model is involved in detection:
 * rules match manifests, lockfiles and config, then the Project Analysis Agent
 * only *summarizes* the result and proposes a workspace.
 */

export interface RepoFile {
  path: string
  content?: string
  lines?: number
}

interface Rule {
  tech: string
  category: TechCategory
  file: RegExp
  contains?: RegExp
  confidence: number
}

const RULES: Rule[] = [
  { tech: "React Native", category: "Mobile", file: /package\.json$/, contains: /"react-native"/, confidence: 0.99 },
  { tech: "Expo", category: "Mobile", file: /(app\.json|package\.json)$/, contains: /"expo"/, confidence: 0.98 },
  { tech: "React", category: "Frontend", file: /package\.json$/, contains: /"react"/, confidence: 0.95 },
  { tech: "TypeScript", category: "Tooling", file: /tsconfig\.json$/, confidence: 0.99 },
  { tech: "Express", category: "Backend", file: /package\.json$/, contains: /"express"/, confidence: 0.95 },
  { tech: "FastAPI", category: "Backend", file: /(pyproject\.toml|requirements\.txt)$/, contains: /fastapi/i, confidence: 0.99 },
  { tech: "Django", category: "Backend", file: /(pyproject\.toml|requirements\.txt)$/, contains: /django/i, confidence: 0.95 },
  { tech: "SQLAlchemy", category: "Backend", file: /(pyproject\.toml|requirements\.txt)$/, contains: /sqlalchemy/i, confidence: 0.9 },
  { tech: "PostgreSQL", category: "Database", file: /(docker-compose\.ya?ml|\.env\.example)$/, contains: /postgres/i, confidence: 0.97 },
  { tech: "Redis", category: "Cache", file: /(docker-compose\.ya?ml|\.env\.example)$/, contains: /redis/i, confidence: 0.96 },
  { tech: "Docker", category: "Infrastructure", file: /(Dockerfile|docker-compose\.ya?ml)$/, confidence: 0.99 },
  { tech: "Kubernetes", category: "Infrastructure", file: /k8s\/.*\.ya?ml$/, contains: /kind:\s*Deployment/, confidence: 0.9 },
  { tech: "PyTorch", category: "AI / ML", file: /(pyproject\.toml|requirements\.txt)$/, contains: /torch/i, confidence: 0.97 },
  { tech: "CUDA", category: "AI / ML", file: /Dockerfile.*$/, contains: /nvidia\/cuda/i, confidence: 0.85 },
  { tech: "Gymnasium", category: "AI / ML", file: /(pyproject\.toml|requirements\.txt)$/, contains: /gymnasium/i, confidence: 0.95 },
  { tech: "pytest", category: "Testing", file: /(pyproject\.toml|requirements\.txt|pytest\.ini)$/, contains: /pytest/i, confidence: 0.95 },
  { tech: "Jest", category: "Testing", file: /package\.json$/, contains: /"jest"/, confidence: 0.95 },
]

const LANG_BY_EXT: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  py: "Python",
  go: "Go",
  rs: "Rust",
  sql: "SQL",
  yml: "YAML",
  yaml: "YAML",
}

export function analyzeRepository(files: RepoFile[]): ProjectAnalysis {
  const found = new Map<string, Detection>()
  for (const rule of RULES) {
    for (const f of files) {
      if (!rule.file.test(f.path)) continue
      if (rule.contains && !rule.contains.test(f.content ?? "")) continue
      if (!found.has(rule.tech)) {
        found.set(rule.tech, { tech: rule.tech, category: rule.category, evidence: f.path, confidence: rule.confidence })
      }
    }
  }
  // React is implied by React Native; keep the more specific detection only.
  if (found.has("React Native")) found.delete("React")

  const lineCounts = new Map<string, number>()
  for (const f of files) {
    const ext = f.path.split(".").pop() ?? ""
    const lang = LANG_BY_EXT[ext]
    if (lang && lang !== "YAML") lineCounts.set(lang, (lineCounts.get(lang) ?? 0) + (f.lines ?? 20))
  }
  const total = [...lineCounts.values()].reduce((a, b) => a + b, 0) || 1
  const languages = [...lineCounts.entries()]
    .map(([name, n]) => ({ name, share: Math.round((n / total) * 100) }))
    .sort((a, b) => b.share - a.share)

  const detections = [...found.values()]
  const has = (cat: TechCategory) => detections.some((d) => d.category === cat)
  const recommended: Discipline[] = ["software"]
  if (has("AI / ML")) recommended.push(detections.some((d) => d.tech === "Gymnasium") ? "rl" : "ml")
  if (detections.some((d) => d.tech === "Kubernetes")) recommended.push("devops")

  const parts = [
    has("Mobile") ? "Mobile" : has("Frontend") ? "Web" : null,
    has("Backend") ? "Backend" : null,
    has("AI / ML") ? "ML" : null,
  ].filter(Boolean)

  return {
    detections,
    languages,
    recommended,
    summary: parts.join(" + ") || "General",
  }
}

/** The demo repository Kivo opens on first launch. */
export const SAMPLE_REPO: RepoFile[] = [
  { path: "mobile/package.json", content: '{"dependencies":{"react":"19.0.0","react-native":"0.79.0","expo":"~53.0.0"},"devDependencies":{"jest":"^29"}}' },
  { path: "mobile/tsconfig.json" },
  { path: "mobile/app/(tabs)/index.tsx", lines: 180 },
  { path: "mobile/app/(tabs)/profile.tsx", lines: 140 },
  { path: "mobile/lib/api.ts", lines: 90 },
  { path: "backend/pyproject.toml", content: "[project]\ndependencies=['fastapi','uvicorn','sqlalchemy[asyncio]','asyncpg','redis','pydantic>=2']\n[dependency-groups]\ndev=['pytest','httpx']" },
  { path: "backend/app/main.py", lines: 60 },
  { path: "backend/app/users/router.py", lines: 120 },
  { path: "backend/app/users/models.py", lines: 70 },
  { path: "backend/app/notifications/worker.py", lines: 110 },
  { path: "backend/migrations/0001_init.sql", lines: 40 },
  { path: "backend/Dockerfile", content: "FROM python:3.12-slim" },
  { path: "docker-compose.yml", content: "services:\n  api: {}\n  postgres:\n    image: postgres:16\n  redis:\n    image: redis:7" },
  { path: ".env.example", content: "DATABASE_URL=postgresql://…\nREDIS_URL=redis://…" },
]
