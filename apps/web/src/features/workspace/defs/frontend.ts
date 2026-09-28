import { Accessibility, Component, Gauge, LayoutTemplate, Palette, Plug, Rocket, Route, Smartphone } from "lucide-react"
import { endpoints, hasTech } from "../derive"
import { base, curve, match, type WorkspaceDef, type WsContext } from "../model"

const SCREEN = /(^|\/)(app|pages|screens|routes|views)\/.*\.(tsx|jsx|vue|svelte|dart)$/
const COMPONENT = /(^|\/)(components|ui|widgets)\/.*\.(tsx|jsx|vue|svelte|dart)$/
const CLIENT = /(^|\/)(lib|api|services|clients?)\/[^/]*\.(ts|js|dart)$/
const TOKENS = /(tailwind\.config\.\w+|theme\.(ts|js|json)|tokens?\.(json|ts|css)|design-tokens)/

/** Expo Router / Next.js / SvelteKit style: app/(tabs)/profile.tsx → /profile */
function routeOf(file: string) {
  const rel = file.replace(/^.*?(?:^|\/)(?:app|pages|screens|routes|views)\//, "")
  const segs = rel
    .replace(/\.(tsx|jsx|vue|svelte|dart)$/, "")
    .split("/")
    .filter((s) => !/^\(.*\)$/.test(s) && s !== "index" && s !== "page" && s !== "+page" && !s.startsWith("_"))
    .map((s) => s.replace(/^\[(.+)\]$/, ":$1"))
  return "/" + segs.join("/")
}

const isLayout = (f: string) => /(^|\/)(_layout|layout|\+layout|_app|_document)\.\w+$/.test(f)

function platformOf(ctx: WsContext, file: string) {
  const root = file.split("/")[0]
  const native = ctx.analysis.detections.some((d) => (d.tech === "React Native" || d.tech === "Expo" || d.tech === "Flutter") && d.evidence.startsWith(root + "/"))
  return native ? "iOS · Android" : "Web"
}

export const frontend: WorkspaceDef = {
  id: "frontend",
  label: "Web & Mobile",
  icon: Smartphone,
  hue: 300,
  tagline: "Screens, components and the experience people actually touch.",
  primaryMode: "Design",
  hero: { title: "What should people be able to do?", body: "Describe a screen or a flow. Kivo plans it against your routes, components and the APIs your backend already exposes." },
  placeholder: "e.g. A settings screen where people can change their email and turn notifications on or off",
  examples: [
    { icon: LayoutTemplate, label: "Settings screen", text: "Design a settings screen for the mobile app: change email, change password, and toggle push notifications. Use the endpoints the backend already has." },
    { icon: Route, label: "Onboarding flow", text: "Plan a three-step onboarding flow for new users: welcome, create account, enable notifications." },
    { icon: Accessibility, label: "Accessibility audit", text: "Review the app's screens for accessibility: labels for screen readers, touch target sizes, colour contrast and dynamic type." },
  ],
  looksFor: ["app/, pages/, screens/ (routes)", "components/", "package.json with React, React Native, Expo, Next.js, Vue or Svelte", "pubspec.yaml (Flutter)", "tailwind.config.*, theme or token files"],
  relevant: (_t, cat) => cat === "Frontend" || cat === "Mobile",
  stats: (ctx) => {
    const screens = match(ctx.files, SCREEN).filter((f) => !isLayout(f))
    const platforms = new Set(screens.map((f) => platformOf(ctx, f)))
    return [
      { label: "Screens", value: String(screens.length) },
      { label: "Components", value: String(match(ctx.files, COMPONENT).length) },
      { label: "Platforms", value: [...platforms].join(", ") || "—" },
      { label: "API endpoints available", value: String(endpoints(ctx).length) },
    ]
  },
  sections: [
    {
      id: "screens",
      label: "Screens",
      icon: LayoutTemplate,
      blurb: "Every screen in the app, with the route that reaches it.",
      setup: "Plan the first screens for this app: which screens it needs, their routes, and what each one shows.",
      build: (ctx) => {
        const files = match(ctx.files, SCREEN)
        const screens = files.filter((f) => !isLayout(f))
        if (!screens.length)
          return {
            source: "example",
            note: "No route files (app/, pages/, screens/) in this project yet.",
            panels: [
              {
                kind: "table",
                columns: [
                  { key: "screen", label: "Screen" },
                  { key: "route", label: "Route", mono: true },
                  { key: "platform", label: "Platform" },
                ],
                rows: [
                  { screen: "Home", route: "/", platform: "Web" },
                  { screen: "Sign in", route: "/sign-in", platform: "Web" },
                  { screen: "Settings", route: "/settings", platform: "Web" },
                ],
              },
            ],
          }
        return {
          source: "project",
          evidence: files,
          count: screens.length,
          panels: [
            {
              kind: "table",
              columns: [
                { key: "screen", label: "Screen" },
                { key: "route", label: "Route", mono: true },
                { key: "platform", label: "Platform" },
                { key: "file", label: "File", mono: true },
              ],
              rows: screens.map((f) => {
                const r = routeOf(f)
                const name = r === "/" ? "Home" : r.split("/").pop()!.replace(/^:/, "").replace(/[-_]/g, " ")
                return { screen: name.charAt(0).toUpperCase() + name.slice(1), route: r, platform: platformOf(ctx, f), file: { text: f, mono: true } }
              }),
            },
          ],
        }
      },
    },
    {
      id: "components",
      label: "Components",
      icon: Component,
      blurb: "Reusable building blocks shared between screens.",
      setup: "Suggest a small component library for this app (buttons, inputs, list rows, empty states) based on its existing screens.",
      build: (ctx) => {
        const files = match(ctx.files, COMPONENT)
        if (!files.length)
          return {
            source: "example",
            note: "No components/ folder yet — screens hold all of their own UI. Shared pieces usually start with buttons, inputs and list rows.",
            panels: [
              {
                kind: "table",
                columns: [
                  { key: "name", label: "Component" },
                  { key: "used", label: "Used by", align: "right" },
                  { key: "variants", label: "Variants" },
                ],
                rows: [
                  { name: "Button", used: 12, variants: "primary · secondary · ghost" },
                  { name: "TextField", used: 7, variants: "default · error" },
                  { name: "ListRow", used: 5, variants: "plain · chevron · toggle" },
                  { name: "EmptyState", used: 3, variants: "—" },
                ],
              },
            ],
          }
        return {
          source: "project",
          evidence: files,
          count: files.length,
          panels: [
            {
              kind: "table",
              columns: [
                { key: "name", label: "Component" },
                { key: "file", label: "File", mono: true },
              ],
              rows: files.map((f) => ({ name: base(f).replace(/\.\w+$/, ""), file: { text: f, mono: true } })),
            },
          ],
        }
      },
    },
    {
      id: "api",
      label: "API usage",
      icon: Plug,
      blurb: "What the UI can call: client code and the backend endpoints it talks to.",
      build: (ctx) => {
        const clients = match(ctx.files, CLIENT).filter((f) => /api|client|http|fetch/i.test(base(f)))
        const eps = endpoints(ctx)
        return {
          source: eps.length || clients.length ? "project" : "example",
          evidence: [...clients, ...ctx.services.map((s) => `services/${s.id}/openapi.yaml`).filter((f) => ctx.files.includes(f))],
          count: eps.length,
          note: clients.length ? `Client code: ${clients.join(", ")}` : "No API client module found yet.",
          panels: [
            {
              kind: "table",
              columns: [
                { key: "method", label: "Method", mono: true },
                { key: "path", label: "Path", mono: true },
                { key: "summary", label: "What it does" },
                { key: "service", label: "Service" },
                { key: "auth", label: "Session" },
              ],
              rows: eps.map((e) => ({
                method: { text: e.method, mono: true },
                path: { text: e.path, mono: true },
                summary: e.summary,
                service: e.service.name,
                auth: e.auth ? { text: "Required", tone: "info" } : { text: "Public", tone: "neutral" },
              })),
              empty: "Build a service in the Software workspace and its endpoints appear here.",
            },
          ],
        }
      },
    },
    {
      id: "tokens",
      label: "Design tokens",
      icon: Palette,
      blurb: "Colours, type, spacing and radius — the values every screen should share.",
      setup: "Propose a design-token set for this app (colour roles, type scale, spacing, radius) and where to define it.",
      build: (ctx) => {
        const files = match(ctx.files, TOKENS)
        const rows = [
          { token: "color.primary", value: { text: "#2a78d6", mono: true }, role: "Buttons, links, focus" },
          { token: "color.surface", value: { text: "#ffffff / #151515", mono: true }, role: "Screen background" },
          { token: "space.4", value: { text: "16px", mono: true }, role: "Default gap and padding" },
          { token: "radius.md", value: { text: "10px", mono: true }, role: "Cards and inputs" },
          { token: "font.body", value: { text: "16 / 24", mono: true }, role: "Body text size / line height" },
        ]
        return files.length
          ? { source: "project", evidence: files, count: files.length, note: "Token files found — open them in Code to edit.", panels: [{ kind: "table", columns: [{ key: "file", label: "Token source", mono: true }], rows: files.map((f) => ({ file: { text: f, mono: true } })) }] }
          : { source: "example", note: "No theme or token file yet — values are probably hard-coded in each screen.", panels: [{ kind: "table", columns: [{ key: "token", label: "Token", mono: true }, { key: "value", label: "Value" }, { key: "role", label: "Used for" }], rows }] }
      },
    },
    {
      id: "a11y",
      label: "Accessibility",
      icon: Accessibility,
      blurb: "Checks every screen should pass. Tick them off as you verify them.",
      build: () => ({
        source: "guide",
        panels: [
          {
            kind: "checklist",
            items: [
              { id: "labels", group: "Screen readers", title: "Every control has an accessible label", detail: "accessibilityLabel on icons-only buttons; alt text on images." },
              { id: "order", group: "Screen readers", title: "Focus order follows the visual order" },
              { id: "announce", group: "Screen readers", title: "Errors and loading states are announced" },
              { id: "contrast", group: "Vision", title: "Text contrast is at least 4.5:1 (3:1 for large text)" },
              { id: "dyntype", group: "Vision", title: "Layouts survive the largest dynamic-type setting" },
              { id: "color", group: "Vision", title: "Nothing is communicated by colour alone" },
              { id: "targets", group: "Motor", title: "Touch targets are at least 44 × 44 pt" },
              { id: "motion", group: "Motor", title: "Animations respect Reduce Motion" },
            ],
          },
        ],
      }),
    },
    {
      id: "perf",
      label: "Performance",
      icon: Gauge,
      blurb: "How fast screens load and respond.",
      setup: "Add performance monitoring to this app: which metrics to capture (startup time, frame drops, Web Vitals) and how.",
      build: (ctx) => {
        const native = hasTech(ctx, "React Native", "Expo", "Flutter")
        return {
          source: "example",
          note: "No performance data is collected yet. Example numbers show what you'd track.",
          panels: [
            {
              kind: "metrics",
              tiles: native
                ? [
                    { label: "Cold start (p75)", value: "1.8 s", tone: "good" },
                    { label: "JS frame drops", value: "2.1 %", tone: "good" },
                    { label: "Bundle size", value: "3.4 MB", tone: "warn", hint: "over the 3 MB budget" },
                  ]
                : [
                    { label: "LCP (p75)", value: "2.1 s", tone: "good" },
                    { label: "INP (p75)", value: "180 ms", tone: "good" },
                    { label: "CLS (p75)", value: "0.12", tone: "warn", hint: "needs improvement above 0.1" },
                  ],
              charts: [{ title: native ? "Cold start by release" : "Largest Contentful Paint by day", unit: "s", x: native ? "release" : "day", series: [{ name: "p75", points: curve("fe-perf", 14, 2.8, 1.8, 0.06) }], target: { value: 2.5, label: "Good ≤ 2.5 s" } }],
            },
          ],
        }
      },
    },
    {
      id: "releases",
      label: "Builds & releases",
      icon: Rocket,
      blurb: "The platforms this UI ships to and how each is built.",
      build: (ctx) => {
        const rows = ctx.analysis.detections
          .filter((d) => d.category === "Frontend" || d.category === "Mobile")
          .flatMap((d) =>
            d.tech === "Expo" || d.tech === "React Native" || d.tech === "Flutter"
              ? [
                  { target: "iOS", toolchain: d.tech === "Flutter" ? "flutter build ipa" : "eas build -p ios", from: { text: d.evidence, mono: true } },
                  { target: "Android", toolchain: d.tech === "Flutter" ? "flutter build appbundle" : "eas build -p android", from: { text: d.evidence, mono: true } },
                ]
              : d.tech === "Tailwind CSS"
                ? []
                : [{ target: "Web", toolchain: d.tech === "Next.js" ? "next build" : "vite build", from: { text: d.evidence, mono: true } }],
          )
        const unique = rows.filter((r, i) => rows.findIndex((x) => x.target === r.target) === i)
        return {
          source: unique.length ? "project" : "example",
          evidence: [...new Set(unique.map((r) => r.from.text))],
          count: unique.length,
          panels: [
            {
              kind: "table",
              columns: [
                { key: "target", label: "Target" },
                { key: "toolchain", label: "Build command", mono: true },
                { key: "from", label: "Detected from", mono: true },
              ],
              rows: unique.length ? unique : [{ target: "Web", toolchain: "vite build", from: "—" }],
            },
          ],
        }
      },
    },
  ],
}
