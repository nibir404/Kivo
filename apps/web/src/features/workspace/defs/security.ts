import { Bug, Crosshair, FlaskConical, KeyRound, ListChecks, Radar, ShieldAlert, ShieldCheck, Target, Wrench } from "lucide-react"
import { datastores, endpoints, isPublicByDesign, mutating } from "../derive"
import { match, type Tone, type WorkspaceDef, type WsContext } from "../model"

/** Files whose name says which security control they implement. */
const CONTROLS: { re: RegExp; control: string }[] = [
  { re: /ratelimit|rate_limit|throttl/i, control: "Rate limiting" },
  { re: /security\.py|hashing|password/i, control: "Password hashing" },
  { re: /tokens?\.py|jwt/i, control: "Token issuing & verification" },
  { re: /csrf/i, control: "CSRF protection" },
  { re: /cors/i, control: "CORS policy" },
  { re: /audit/i, control: "Audit logging" },
  { re: /\.semgrep|semgrep\.ya?ml/i, control: "Static analysis (Semgrep)" },
  { re: /dependabot\.ya?ml/i, control: "Dependency updates (Dependabot)" },
]

interface Finding {
  id: string
  title: string
  where: string
  severity: "High" | "Medium" | "Low" | "Info"
  fix: string
}

function findings(ctx: WsContext): Finding[] {
  const out: Finding[] = []
  for (const e of endpoints(ctx)) {
    if (!e.auth && mutating(e) && !isPublicByDesign(e.path))
      out.push({ id: `unauth-${e.service.id}-${e.method}-${e.path}`, severity: "High", title: `${e.method} ${e.path} changes data without a session`, where: e.service.name, fix: "Require authentication, or document why it must be public." })
    else if (!e.auth && !mutating(e) && /\{|:id|me\b|user|account|profile/i.test(e.path) && !isPublicByDesign(e.path))
      out.push({ id: `read-${e.service.id}-${e.path}`, severity: "Medium", title: `${e.method} ${e.path} returns per-user data publicly`, where: e.service.name, fix: "Check that it can't be used to enumerate accounts." })
    if (!e.auth && /login|signin|reset|forgot|verify/i.test(e.path) && !ctx.files.some((f) => f.startsWith(`services/${e.service.id}/`) && /ratelimit|throttl/i.test(f)))
      out.push({ id: `brute-${e.service.id}-${e.path}`, severity: "Medium", title: `${e.path} has no rate limiting`, where: e.service.name, fix: "Limit attempts per account and per IP." })
  }
  for (const s of ctx.services) {
    if (s.authentication && /jwt|token/i.test(s.authentication.strategy) && !s.decisions.some((d) => /rotat|revoc|expir/i.test(d.topic + d.choice + d.reason)))
      out.push({ id: `tokens-${s.id}`, severity: "Low", title: "No recorded decision on token expiry or revocation", where: s.name, fix: "Decide token lifetime and how a stolen token is revoked." })
  }
  const envs = match(ctx.files, /(^|\/)\.env(\.example)?$/)
  if (envs.length) out.push({ id: "env-files", severity: "Info", title: `${envs.length} environment template${envs.length > 1 ? "s" : ""} in the repo`, where: envs.join(", "), fix: "Keep real secrets out of git (.env is ignored)." })
  return out
}

const TONE: Record<Finding["severity"], Tone> = { High: "bad", Medium: "warn", Low: "info", Info: "neutral" }

export const security: WorkspaceDef = {
  id: "security",
  label: "Cybersecurity",
  icon: ShieldCheck,
  hue: 25,
  tagline: "What's exposed, what could go wrong, and what's already defended.",
  primaryMode: "Assess",
  notice: "Security work runs only against assets you mark in scope, inside the Kivo sandbox.",
  hero: { title: "What do you want to check?", body: "Ask about a threat, an endpoint or a control. Kivo answers from this project's real attack surface: its endpoints, auth and data stores." },
  placeholder: "e.g. Could someone take over an account through the password-reset flow?",
  examples: [
    { icon: KeyRound, label: "Password reset abuse", text: "Walk through how an attacker could abuse the password-reset flow in this project, and which controls already stop it." },
    { icon: Crosshair, label: "Review public endpoints", text: "Review every endpoint that works without a session. Which ones should be public, and which are risky?" },
    { icon: FlaskConical, label: "Write security tests", text: "Write pytest security tests for the authentication service: brute-force limits, token tampering, and access to other users' data." },
  ],
  looksFor: ["API endpoints of built services (attack surface)", "auth, token and rate-limit modules", ".semgrep.yml, dependabot.yml", ".env files"],
  relevant: (tech, cat) => cat === "Security" || ["FastAPI", "Express", "Django"].includes(tech),
  stats: (ctx) => {
    const eps = endpoints(ctx)
    const f = findings(ctx)
    return [
      { label: "Endpoints", value: String(eps.length) },
      { label: "Public", value: String(eps.filter((e) => !e.auth).length) },
      { label: "High findings", value: String(f.filter((x) => x.severity === "High").length), tone: f.some((x) => x.severity === "High") ? "bad" : "good" },
      { label: "Controls found", value: String(new Set(CONTROLS.filter((c) => ctx.files.some((x) => c.re.test(x))).map((c) => c.control)).size) },
    ]
  },
  sections: [
    {
      id: "scope",
      label: "Scope",
      icon: Target,
      blurb: "Tick the assets you're authorised to test. Nothing outside this list is touched.",
      build: (ctx) => {
        const assets = [...ctx.services.map((s) => ({ id: `svc-${s.id}`, title: s.name, detail: `Service · ${s.api.endpoints.length} endpoints`, group: "Services" })), ...datastores(ctx).map((n) => ({ id: `store-${n.id}`, title: n.label, detail: n.tech, group: "Data stores" }))]
        return { source: "project", count: assets.length, note: "Local sandbox only. Mark an asset in scope before running any test against it.", panels: [{ kind: "checklist", items: assets }] }
      },
    },
    {
      id: "surface",
      label: "Attack surface",
      icon: Radar,
      blurb: "Every endpoint an attacker could reach, and whether it needs a session.",
      build: (ctx) => {
        const eps = endpoints(ctx)
        return {
          source: eps.length ? "project" : "example",
          count: eps.length,
          evidence: ctx.services.map((s) => `services/${s.id}/openapi.yaml`).filter((f) => ctx.files.includes(f)),
          panels: [
            {
              kind: "table",
              columns: [
                { key: "method", label: "Method", mono: true },
                { key: "path", label: "Path", mono: true },
                { key: "service", label: "Service" },
                { key: "auth", label: "Session" },
                { key: "risk", label: "Why it matters" },
              ],
              rows: eps.map((e) => ({
                method: { text: e.method, mono: true },
                path: { text: e.path, mono: true },
                service: e.service.name,
                auth: e.auth ? { text: "Required", tone: "good" } : isPublicByDesign(e.path) ? { text: "Public by design", tone: "info" } : { text: "Public", tone: mutating(e) ? "bad" : "warn" },
                risk: e.auth ? "Check it only returns the caller's own data." : isPublicByDesign(e.path) ? "Needs rate limiting and generic error messages." : mutating(e) ? "Anyone can change data here." : "Anyone can read this.",
              })),
              empty: "Build a service and its endpoints are mapped here automatically.",
            },
          ],
        }
      },
    },
    {
      id: "findings",
      label: "Findings",
      icon: Bug,
      blurb: "Issues found by checking the service specs and files. No traffic was sent.",
      build: (ctx) => {
        const f = findings(ctx)
        const col = (sev: Finding["severity"]) => ({ title: sev, tone: TONE[sev], cards: f.filter((x) => x.severity === sev).map((x) => ({ title: x.title, meta: `${x.where} — ${x.fix}`, tone: TONE[sev] })) })
        return {
          source: "project",
          count: f.length,
          note: "Static review of the IR and file layout. Confirm each finding before acting on it.",
          panels: [{ kind: "board", columns: [col("High"), col("Medium"), col("Low"), col("Info")] }],
        }
      },
    },
    {
      id: "controls",
      label: "Controls",
      icon: ShieldCheck,
      blurb: "Defences already present in the code.",
      build: (ctx) => {
        const rows = CONTROLS.flatMap((c) => match(ctx.files, c.re).map((f) => ({ control: c.control, file: { text: f, mono: true } })))
        const auth = ctx.services.filter((s) => s.authentication).map((s) => ({ control: `Authentication: ${s.authentication!.strategy}`, file: { text: s.name, mono: false } }))
        const all = [...auth, ...rows]
        return {
          source: all.length ? "project" : "example",
          evidence: rows.map((r) => r.file.text),
          count: all.length,
          panels: [{ kind: "table", columns: [{ key: "control", label: "Control" }, { key: "file", label: "Where" }], rows: all, empty: "No security controls recognised yet." }],
        }
      },
    },
    {
      id: "threats",
      label: "Threat model",
      icon: ShieldAlert,
      blurb: "STRIDE, applied to the parts of this system that exist.",
      build: (ctx) => {
        const hasAuth = ctx.services.some((s) => s.authentication)
        const stores = datastores(ctx)
        const items = [
          ...(hasAuth
            ? [
                { id: "s-creds", group: "Spoofing", title: "Stolen or guessed passwords can't be replayed at scale", detail: "Rate limits, lockout, breached-password check." },
                { id: "s-token", group: "Spoofing", title: "Tokens are signed, short-lived and bound to one user" },
              ]
            : []),
          { id: "t-input", group: "Tampering", title: "Every request body is validated against its schema" },
          ...stores.map((n) => ({ id: `t-${n.id}`, group: "Tampering", title: `Only the owning service can write to ${n.label}` })),
          { id: "r-audit", group: "Repudiation", title: "Sign-ins, password changes and deletions are logged with who and when" },
          { id: "i-errors", group: "Information disclosure", title: "Errors don't reveal whether an account exists" },
          { id: "i-logs", group: "Information disclosure", title: "Logs never contain passwords, tokens or full emails" },
          { id: "d-limits", group: "Denial of service", title: "Expensive endpoints have timeouts and request limits" },
          { id: "e-idor", group: "Elevation of privilege", title: "A user can't read or change another user's records by changing an id" },
        ]
        return { source: "project", count: items.length, note: "Tick each threat once a control or test covers it.", panels: [{ kind: "checklist", items }] }
      },
    },
    {
      id: "tests",
      label: "Security tests",
      icon: FlaskConical,
      blurb: "Tests that prove the defences work.",
      setup: "Write security tests for this project's services: authentication bypass, brute force, token tampering and access to other users' data.",
      build: (ctx) => {
        const files = match(ctx.files, /(^|\/)tests?\/.*(test_.*(auth|security|login|token|perm)|.*security.*)\.py$/i)
        return {
          source: files.length ? "project" : "example",
          evidence: files,
          count: files.length,
          note: files.length ? "Run them from the terminal with pytest." : "No security-focused tests yet.",
          panels: [
            {
              kind: "table",
              columns: [
                { key: "suite", label: "Suite" },
                { key: "file", label: "File", mono: true },
              ],
              rows: files.length
                ? files.map((f) => ({ suite: f.split("/")[1] ?? f, file: { text: f, mono: true } }))
                : [
                    { suite: "Brute-force limit", file: "tests/test_auth_limits.py" },
                    { suite: "Token tampering", file: "tests/test_tokens.py" },
                  ],
            },
          ],
        }
      },
    },
    {
      id: "remediation",
      label: "Remediation",
      icon: Wrench,
      blurb: "Fixes, from found to verified.",
      build: (ctx) => {
        const f = findings(ctx).filter((x) => x.severity !== "Info")
        return {
          source: "project",
          count: f.length,
          panels: [
            {
              kind: "board",
              columns: [
                { title: "To fix", tone: "warn", cards: f.map((x) => ({ title: x.fix, meta: x.title, tone: TONE[x.severity] })) },
                { title: "In review", cards: [] },
                { title: "Verified", tone: "good", cards: [] },
              ],
            },
          ],
        }
      },
    },
    {
      id: "hygiene",
      label: "Hygiene",
      icon: ListChecks,
      blurb: "Baseline practices for any codebase.",
      build: () => ({
        source: "guide",
        panels: [
          {
            kind: "checklist",
            items: [
              { id: "deps", title: "Dependencies are pinned and scanned for known vulnerabilities" },
              { id: "secrets", title: "No secrets in git history (scan with gitleaks or trufflehog)" },
              { id: "sast", title: "Static analysis runs on every change" },
              { id: "headers", title: "HTTP responses set security headers (CSP, HSTS, nosniff)" },
              { id: "tls", title: "All traffic between services is encrypted in production" },
              { id: "backups", title: "Backups are encrypted and restores are tested" },
            ],
          },
        ],
      }),
    },
  ],
}
