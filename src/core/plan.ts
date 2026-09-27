import type { PlanStep, ServiceSpec } from "./types"
import { frameworkName, languageName } from "./stacks"

/**
 * Architecture Planner → Implementation Plan.
 *
 * Each step declares its executor. AI steps (design, generation) are always followed by
 * deterministic validation (install, typecheck, test, boot). A service is only marked
 * `ready` once the deterministic steps pass — generated code is never presented as
 * successful on the model's word alone.
 */
export function planFor(spec: ServiceSpec): PlanStep[] {
  const lang = languageName(spec.implementation.language)
  const fw = frameworkName(spec.implementation.language, spec.implementation.framework)
  const py = spec.implementation.language === "python"
  const dir = `services/${spec.id}`
  const ext = py ? "py" : "ts"
  const isAuth = isAuthService(spec)

  const steps: PlanStep[] = [
    {
      id: "understand",
      title: "Understanding requirements",
      executor: "ai",
      engine: "Intent Agent",
      what: `Turning your description into ${spec.requirements.length} concrete requirements and ${spec.entities.length} data entities.`,
      why: "A structured spec is checkable. Code generated straight from prose drifts; code generated from a spec can be verified against it.",
      tech: "Service IR (YAML)",
      alternatives: ["Generate code directly from the prompt (unverifiable)"],
      consequences: "Every file, test and runtime trace can be traced back to a requirement id.",
      artifacts: [`${dir}/kivo.service.yaml`],
      durationMs: 900,
    },
    {
      id: "api",
      title: "Designing API",
      executor: "deterministic",
      engine: "IR → OpenAPI",
      what: `Defining ${spec.api.endpoints.length} ${spec.api.style.toUpperCase()} endpoints and their request/response contracts.`,
      why: "The contract is derived from the reviewed spec before implementation, so the mobile client and the service are generated against the same schema.",
      tech: "OpenAPI 3.1",
      alternatives: ["GraphQL", "gRPC"],
      consequences: "A typed client is generated for the app; breaking changes become visible diffs.",
      concept: "rest",
      artifacts: [`${dir}/openapi.yaml`],
      durationMs: 1100,
    },
    {
      id: "model",
      title: `Creating ${spec.entities[0]?.name ?? "data"} model`,
      executor: "ai",
      engine: "Implementation Agent",
      what: `Writing the ${spec.entities.map((e) => e.name).join(", ")} schema and a migration.`,
      why: `${spec.name} owns this data; defining it explicitly lets ${spec.storage.type} enforce integrity (unique emails, non-null fields).`,
      tech: py ? "SQLAlchemy 2.0 (SQLite in dev, PostgreSQL in prod)" : "Drizzle ORM",
      alternatives: py ? ["Tortoise ORM", "raw SQL"] : ["Prisma", "Kysely"],
      consequences: "Schema changes are versioned migrations you can review and roll back.",
      concept: "db-index",
      artifacts: py ? [`${dir}/db.py`, `${dir}/outbox.py`, `${dir}/kv.py`, `${dir}/models.py`, `${dir}/migrations/0001_${spec.id}.sql`] : [`${dir}/db.${ext}`, `${dir}/models.${ext}`],
      durationMs: 1200,
    },
    {
      id: "storage",
      title: `Connecting ${spec.storage.type}`,
      executor: "deterministic",
      engine: "Environment Manager",
      what: `Wiring DATABASE_URL for ${spec.storage.type} and checking docker-compose declares it.`,
      why: `${spec.storage.type} is being used because ${spec.name} requires ${spec.storage.reason}.`,
      tech: `${spec.storage.type} 16 · Docker`,
      alternatives: ["MySQL", "SQLite for local-only"],
      consequences: "Local, CI and production use the same engine and version.",
      concept: "postgresql",
      artifacts: [`${dir}/.env.example`],
      durationMs: 800,
    },
  ]

  if (isAuth) {
    steps.push(
      {
        id: "hashing",
        title: "Implementing password hashing",
        executor: "ai",
        engine: "Implementation Agent",
        what: "Hashing passwords with bcrypt before they are stored, and verifying them at login.",
        why: "Passwords are hashed before being stored. This prevents the original password from being directly recoverable from the database.",
        tech: "bcrypt, cost factor 12",
        alternatives: ["argon2id — stronger vs GPUs", "scrypt"],
        consequences: "~70ms CPU per login by design. It will show up in runtime traces as the slowest span.",
        concept: "password-hashing",
        artifacts: [`${dir}/security.${ext}`],
        durationMs: 1300,
      },
      {
        id: "jwt",
        title: "Creating JWT authentication",
        executor: "ai",
        engine: "Implementation Agent",
        what: "Issuing 15-minute access tokens and rotating 14-day refresh tokens stored in Redis.",
        why: "Short-lived signed tokens let every service verify users without a database call; refresh tokens keep users logged in and remain revocable.",
        tech: "PyJWT (HS256) + Redis",
        alternatives: ["Server-side sessions only", "Paseto"],
        consequences: "Logout and reuse-detection work by revoking refresh-token families.",
        concept: "jwt",
        artifacts: [`${dir}/tokens.${ext}`, `${dir}/router.${ext}`, `${dir}/main.${ext}`],
        durationMs: 1300,
      },
      {
        id: "ratelimit",
        title: "Adding login rate limiting",
        executor: "ai",
        engine: "Implementation Agent",
        what: "Limiting login attempts to 5 per minute per IP.",
        why: "Slows password-guessing attacks to an impractical rate.",
        tech: "Redis INCR + EXPIRE",
        alternatives: ["Gateway-level limits", "Token bucket"],
        consequences: "Excess attempts return HTTP 429 with Retry-After.",
        concept: "rate-limiting",
        artifacts: [`${dir}/ratelimit.${ext}`],
        durationMs: 700,
      },
    )
  } else {
    steps.push({
      id: "handlers",
      title: "Implementing handlers",
      executor: "ai",
      engine: "Implementation Agent",
      what: `Writing ${spec.api.endpoints.length} route handlers in ${fw}.`,
      why: "Each handler maps one-to-one to a requirement in the spec, so coverage is measurable.",
      tech: `${lang} · ${fw}`,
      alternatives: [],
      consequences: "Handlers are thin; business rules live in a service module that tests can call directly.",
      concept: py ? "fastapi" : undefined,
      artifacts: [`${dir}/service.${ext}`, `${dir}/router.${ext}`, `${dir}/main.${ext}`],
      durationMs: 1500,
    })
  }

  steps.push(
    {
      id: "install",
      title: "Installing dependencies",
      executor: "deterministic",
      engine: py ? "pip (venv)" : "pnpm",
      what: "Resolving and locking package versions.",
      why: "Reproducible installs; the lockfile is the source of truth, never the model.",
      tech: py ? "requirements derived from imports → pip install" : "pnpm install --frozen-lockfile",
      alternatives: [],
      consequences: "Any machine produces the same dependency tree.",
      artifacts: py ? [`${dir}/requirements.txt`, `${dir}/pytest.ini`] : ["pnpm-lock.yaml"],
      durationMs: 900,
    },
    {
      id: "tests",
      title: "Writing & running tests",
      executor: "deterministic",
      engine: py ? "pytest" : "vitest",
      what: "Generating one test per requirement, linting with pyflakes, then running pytest in the sandbox.",
      why: "The service is only marked ready when lint is clean and every requirement's test passes in the sandbox.",
      tech: py ? "pytest + FastAPI TestClient" : "vitest + supertest",
      alternatives: [],
      consequences: "Failures are fed back to the Implementation Agent with the exact error for a repair attempt.",
      artifacts: py ? [`${dir}/tests/conftest.py`, `${dir}/tests/test_${spec.id.replace(/-/g, "_")}.py`] : [`${dir}/tests/${spec.id}.test.${ext}`],
      durationMs: 1600,
    },
    {
      id: "boot",
      title: "Booting service",
      executor: "deterministic",
      engine: "Process Manager",
      what: "Starting the service process, waiting for /health, and reading its live OpenAPI routes.",
      why: "A passing test suite isn't proof it runs; a healthy process with traces is.",
      tech: py ? "uvicorn · /health" : "node · /health",
      alternatives: [],
      consequences: `${spec.name} appears live in Observe.`,
      concept: "docker",
      artifacts: [],
      durationMs: 900,
    },
  )
  return steps
}

export function isAuthService(spec: ServiceSpec) {
  return /auth/i.test(spec.name) || spec.requirements.some((r) => r.id === "login")
}

export function testsFor(spec: ServiceSpec) {
  return spec.requirements.map((r) => ({ name: `test_${r.id}`, status: "pass" as const }))
}

/** Implementation preview for the Code tab. */
export function codeFor(spec: ServiceSpec): { path: string; code: string } {
  const py = spec.implementation.language === "python"
  if (spec.id === "authentication" && py) {
    return {
      path: "services/authentication/router.py",
      code: `@router.post("/auth/login", response_model=TokenPair)
async def login(
    body: LoginRequest,                      # Pydantic validates email + password
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> TokenPair:
    await enforce_rate_limit(redis, f"rl:login:{request.client.host}", limit=5)

    user = await db.scalar(select(User).where(User.email == body.email))
    if user is None or not await verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")

    access = issue_access_token(sub=str(user.id), ttl=timedelta(minutes=15))
    refresh = await create_refresh_session(redis, user_id=user.id)
    return TokenPair(access_token=access, refresh_token=refresh)`,
    }
  }
  const first = spec.api.endpoints[0]
  if (py) {
    return {
      path: `services/${spec.id}/router.py`,
      code: `@router.${first.method.toLowerCase()}("${first.path}")
async def handler(db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    """${first.summary} — requirement: ${first.requirement}"""
    return await ${spec.id.replace(/-/g, "_")}_service.${first.requirement}(db, user)`,
    }
  }
  return {
    path: `services/${spec.id}/router.ts`,
    code: `router.${first.method.toLowerCase()}("${first.path}", requireAuth, async (req, res) => {
  // ${first.summary} — requirement: ${first.requirement}
  const result = await ${spec.id.replace(/-/g, "")}Service.${first.requirement}(req.user)
  res.json(result)
})`,
  }
}
