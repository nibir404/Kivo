import { create } from "zustand"
import { persist } from "zustand/middleware"
import { CONCEPTS } from "@/core/concepts"
import { analyzeRepository, SAMPLE_REPO } from "@/core/detect"
import { languageReason, parseIntent } from "@/core/intent"
import { planFor, testsFor } from "@/core/plan"
import { logsFor, nextTrace } from "@/core/runtime"
import { nodesForService, nodesFromAnalysis, PROJECT_NAME, SEED_EDGES, SEED_EXPERIENCES, SEED_LIBRARY, SEED_NODES } from "@/core/seed"
import { frameworkName, languageName } from "@/core/stacks"
import type { Health, ProjectInfo } from "@/lib/api"
import type {
  ContextItem,
  Discipline,
  Experience,
  KivoRef,
  Level,
  LibraryItem,
  LogLine,
  Mode,
  PlanStep,
  ProjectAnalysis,
  ServiceSpec,
  StackChoice,
  SystemEdge,
  SystemNode,
  Trace,
} from "@/core/types"

export interface ChatMessage {
  id: string
  role: "user" | "assistant"
  text: string
  context?: ContextItem[]
  ref?: KivoRef | null
  reasoning?: string
  streaming?: boolean
  model?: string
}

export type StepStatus = "todo" | "active" | "done" | "failed" | "skipped"

/** Live record of one plan step as the daemon executes it. */
export interface StepRun {
  status: StepStatus
  output: string
  reasoning: string
  logs: string[]
  files: string[]
  note?: string
  startedAt?: number
  endedAt?: number
  /** Set while the step is waiting on a rate limit, cleared when output resumes. */
  waiting?: string
}

export interface BuildRun {
  specId: string
  steps: PlanStep[]
  index: number
  startedAt: number
  finished: boolean
  /** true when executed by the daemon (real codegen, installs, tests); false = offline simulation */
  real: boolean
  runs: Record<string, StepRun>
  ok?: boolean
  url?: string
  routes?: string[]
  commit?: string
  error?: string
}

export interface Understanding {
  text: string
  reasoning: string
  waiting?: string
  error?: string
}

export interface OpenFile {
  content: string
  saved: string
}

type ContextTab = "explain" | "knowledge" | "ai"

/** Choices the user makes about how Kivo behaves. Kivo never overrides these on its own. */
export interface Prefs {
  /** Fold the context panel away while editing code, for a distraction-free editor. */
  focusCode: boolean
  /** Show the floating Explain & Capture toolbar when selecting text or objects. */
  captureToolbar: boolean
  /** Toast with next-step suggestions when a build finishes. */
  buildNotify: boolean
  /** Selecting code with the mouse opens the inline AI prompt (⌘K always works). */
  aiOnSelect: boolean
  /** Tab autocomplete: AI ghost-text suggestions while typing in the editor. */
  autocomplete: boolean
}

export type Dialog = "settings" | "shortcuts" | "welcome" | null
type BottomTab = "terminal" | "output" | "runtime" | "logs" | "problems" | "git"

interface State {
  mode: Mode
  discipline: Discipline
  /** The open section of a non-software workspace (null = its overview). */
  workspaceSection: string | null
  level: Level
  depthSignals: number
  analysis: ProjectAnalysis
  project: string
  /** The open project on disk (null until the daemon has answered). */
  projectInfo: ProjectInfo | null
  stack: StackChoice
  ai: Health | null
  daemon: boolean
  understanding: Understanding | null
  files: string[]
  openFiles: string[]
  activeFile: string | null
  fileCache: Record<string, OpenFile>

  services: ServiceSpec[]
  draft: ServiceSpec | null
  build: BuildRun | null
  focusStepId: string | null
  activeServiceId: string | null

  nodes: SystemNode[]
  edges: SystemEdge[]

  runtimeLive: boolean
  traces: Trace[]
  logs: LogLine[]
  output: string[]
  selectedTraceId: string | null

  selection: KivoRef | null
  contextTab: ContextTab
  bottomTab: BottomTab
  chat: ChatMessage[]

  library: LibraryItem[]
  experiences: Experience[]
  personalContext: boolean
  rememberRuntime: boolean

  commandOpen: boolean
  dialog: Dialog
  welcomed: boolean
  prefs: Prefs
  noteFor: KivoRef | null
  experienceDraftOpen: boolean

  setMode: (m: Mode) => void
  setDiscipline: (d: Discipline) => void
  /** Load a project: its files and analysis, with everything project-scoped reset. */
  loadProject: (info: ProjectInfo, analysis: ProjectAnalysis, files: string[]) => void
  openWorkspaceSection: (id: string | null) => void
  setLevel: (l: Level) => void
  noteDepth: () => boolean
  setStack: (s: Partial<StackChoice>) => void
  submitIntent: (text: string) => void
  updateDraft: (patch: Partial<ServiceSpec>) => void
  discardDraft: () => void
  startBuild: () => void
  advanceBuild: () => void
  focusStep: (id: string | null) => void
  openService: (id: string | null) => void

  toggleRuntime: () => void
  tickRuntime: () => void
  selectTrace: (id: string | null) => void

  select: (ref: KivoRef | null, tab?: ContextTab) => void
  setContextTab: (t: ContextTab) => void
  setBottomTab: (t: BottomTab) => void
  pushChat: (m: ChatMessage) => void

  saveToLibrary: (ref: KivoRef, myUnderstanding?: string) => LibraryItem
  updateLibraryItem: (id: string, patch: Partial<LibraryItem>) => void
  deleteLibraryItem: (id: string) => void
  addExperience: (e: Omit<Experience, "id" | "number" | "createdAt">) => void
  updateExperience: (id: string, patch: Partial<Experience>) => void
  deleteExperience: (id: string) => void
  setPersonalContext: (v: boolean) => void
  setRememberRuntime: (v: boolean) => void

  setCommandOpen: (v: boolean) => void
  setDialog: (d: Dialog) => void
  setWelcomed: (v: boolean) => void
  setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void
  openNote: (ref: KivoRef | null) => void
  setExperienceDraftOpen: (v: boolean) => void

  appendOutput: (lines: string[]) => void
  setDraft: (spec: ServiceSpec | null) => void
  beginRealBuild: () => ServiceSpec | null
  patchBuild: (fn: (b: BuildRun) => BuildRun) => void
  finishRealBuild: (ok: boolean, info: { url?: string; routes?: string[]; commit?: string; error?: string; tests?: ServiceSpec["tests"] }) => void
  openFile: (path: string, content?: string) => void
  closeFile: (path: string) => void
  setActiveFile: (path: string | null) => void
  editFile: (path: string, content: string) => void
  markSaved: (path: string) => void
  updateChat: (id: string, patch: Partial<ChatMessage>) => void
}

const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`

const EXISTING: ServiceSpec[] = [
  existing("users", "User Management", "Profiles and account settings.", ["GET /users/me", "PATCH /users/me"]),
  existing("notifications", "Notifications", "Sends email and push messages in the background.", ["POST /notify", "GET /notify/preferences"]),
]

function existing(id: string, name: string, purpose: string, eps: string[]): ServiceSpec {
  return {
    id,
    name,
    purpose,
    intent: "(detected from repository)",
    requirements: [],
    entities: [],
    storage: { type: "PostgreSQL", reason: "" },
    api: {
      style: "rest",
      endpoints: eps.map((e) => {
        const [method, path] = e.split(" ")
        return { method: method as "GET", path, summary: "", requirement: "", auth: true }
      }),
    },
    implementation: { language: "python", framework: "fastapi", database: "PostgreSQL" },
    dependsOn: [],
    decisions: [],
    status: "running",
    files: [`backend/app/${id}/router.py`, `backend/app/${id}/models.py`],
    tests: [],
  }
}

export const useKivo = create<State>()(
  persist(
    (set, get) => ({
      mode: "build",
      discipline: "software",
      workspaceSection: null,
      level: "intermediate",
      depthSignals: 0,
      analysis: analyzeRepository(SAMPLE_REPO),
      project: PROJECT_NAME,
      projectInfo: null,
      stack: { language: "python", framework: "fastapi", database: "PostgreSQL", cache: "Redis" },
      ai: null,
      daemon: false,
      understanding: null,
      files: SAMPLE_REPO.map((f) => f.path),
      openFiles: [],
      activeFile: null,
      fileCache: {},

      services: EXISTING,
      draft: null,
      build: null,
      focusStepId: null,
      activeServiceId: null,

      nodes: SEED_NODES,
      edges: SEED_EDGES,

      // Demo traffic is simulated; it only runs when the user turns it on.
      runtimeLive: false,
      traces: [],
      logs: [],
      output: [
        "$ kivo analyze .",
        "✓ scanned 14 files in 38ms (deterministic detectors)",
        "✓ project graph: 7 nodes, 6 edges",
        "$ docker compose up -d",
        "✓ postgres  healthy",
        "✓ redis     healthy",
        "✓ users     healthy  :8001",
        "✓ notifications healthy :8002",
      ],
      selectedTraceId: null,

      selection: null,
      contextTab: "explain",
      bottomTab: "terminal",
      chat: [],

      library: SEED_LIBRARY,
      experiences: SEED_EXPERIENCES,
      personalContext: true,
      rememberRuntime: true,

      commandOpen: false,
      dialog: null,
      welcomed: false,
      prefs: { focusCode: true, captureToolbar: true, buildNotify: true, aiOnSelect: true, autocomplete: true },
      noteFor: null,
      experienceDraftOpen: false,

      setMode: (mode) => set({ mode }),
      setDiscipline: (discipline) => set((s) => ({ discipline, workspaceSection: null, mode: s.mode === "code" || s.mode === "library" ? s.mode : "build" })),
      openWorkspaceSection: (workspaceSection) => set({ workspaceSection, mode: "build" }),
      loadProject: (info, analysis, files) =>
        set((s) => {
          const same = s.projectInfo?.id === info.id
          if (same) return { projectInfo: info, project: info.name, analysis, files }
          // Another project: nothing from the previous one (tabs, services, graph, build, logs) carries over.
          const demo = info.kind === "demo"
          return {
            projectInfo: info,
            project: info.name,
            analysis,
            files,
            openFiles: [],
            activeFile: null,
            fileCache: {},
            services: demo ? EXISTING : [],
            nodes: demo ? SEED_NODES : nodesFromAnalysis(analysis),
            edges: demo ? SEED_EDGES : [],
            draft: null,
            build: null,
            understanding: null,
            activeServiceId: null,
            workspaceSection: null,
            traces: [],
            logs: [],
            selection: null,
          }
        }),
      setLevel: (level) => set({ level, depthSignals: 0 }),
      /** Records that the user drilled deeper than their level. Returns true when Kivo should suggest levelling up. */
      noteDepth: () => {
        const n = get().depthSignals + 1
        set({ depthSignals: n })
        return n === 3 && get().level !== "expert"
      },
      setStack: (s) =>
        set((st) => {
          const stack = { ...st.stack, ...s }
          if (s.language && !s.framework) stack.framework = frameworkFirst(s.language)
          // Keep the draft's own "Language & framework" decision in step with the picker.
          const choice = `${languageName(stack.language)} · ${frameworkName(stack.language, stack.framework)}`
          const draft = st.draft
            ? {
                ...st.draft,
                implementation: { ...stack, cache: st.draft.cache ? stack.cache : undefined },
                decisions: st.draft.decisions.map((d) =>
                  d.topic === "Language & framework" && d.choice !== choice
                    ? { ...d, choice, reason: languageReason(stack.language) }
                    : d,
                ),
              }
            : null
          return { stack, draft }
        }),

      submitIntent: (text) => {
        const draft = parseIntent(text, get().stack)
        set({ draft, mode: "build", activeServiceId: null, selection: { kind: "service", id: draft.id, label: draft.name } })
      },
      updateDraft: (patch) => set((s) => (s.draft ? { draft: { ...s.draft, ...patch } } : {})),
      discardDraft: () => set({ draft: null }),

      startBuild: () => {
        const draft = get().draft
        if (!draft) return
        const spec: ServiceSpec = { ...draft, status: "building" }
        const steps = planFor(spec)
        set((s) => ({
          services: [...s.services.filter((x) => x.id !== spec.id), spec],
          draft: null,
          build: { specId: spec.id, steps, index: 0, startedAt: Date.now(), finished: false, real: false, runs: {} },
          focusStepId: steps[0].id,
          activeServiceId: spec.id,
          output: [...s.output, `$ kivo build ${spec.id}  (offline simulation — daemon not connected)`, `→ plan: ${steps.length} steps (${steps.filter((x) => x.executor === "deterministic").length} deterministic)`],
        }))
      },
      advanceBuild: () => {
        const b = get().build
        if (!b || b.finished) return
        const step = b.steps[b.index]
        const next = b.index + 1
        const line = `${step.executor === "deterministic" ? "⚙" : "✦"} ${step.title} — ${step.engine}${step.artifacts.length ? ` → ${step.artifacts.join(", ")}` : ""}`
        if (next < b.steps.length) {
          set((s) => ({
            build: { ...b, index: next },
            focusStepId: s.focusStepId === step.id ? b.steps[next].id : s.focusStepId,
            output: [...s.output, line],
          }))
          return
        }
        // Finished: validated by deterministic steps → mark running and extend the System Graph.
        const spec = get().services.find((s) => s.id === b.specId)!
        const tech = `${languageName(spec.implementation.language)} · ${frameworkName(spec.implementation.language, spec.implementation.framework)}`
        const { node, edges } = nodesForService(spec.id, spec.name, tech, spec.purpose, spec.dependsOn.filter((d) => get().nodes.some((n) => n.id === d)), !!spec.cache)
        const files = [...new Set(b.steps.flatMap((x) => x.artifacts))]
        const tests = testsFor(spec)
        set((s) => ({
          build: { ...b, index: b.steps.length, finished: true, ok: true },
          services: s.services.map((x) => (x.id === spec.id ? { ...x, status: "running", files, tests } : x)),
          nodes: [...s.nodes.filter((n) => n.id !== node.id), node],
          edges: [...s.edges.filter((e) => !edges.some((ne) => ne.id === e.id)), ...edges],
          output: [...s.output, line, `✓ ${tests.length}/${tests.length} tests passed (simulated)`, `✓ ${spec.id} healthy (simulated)`],
        }))
      },
      focusStep: (focusStepId) => set({ focusStepId }),
      openService: (activeServiceId) => set({ activeServiceId, draft: activeServiceId ? null : get().draft, mode: "build" }),

      toggleRuntime: () => set((s) => ({ runtimeLive: !s.runtimeLive })),
      tickRuntime: () => {
        const running = new Set(get().services.filter((s) => s.status === "running").map((s) => s.id))
        const t = nextTrace(running)
        set((s) => ({ traces: [t, ...s.traces].slice(0, 80), logs: [...s.logs, ...logsFor(t)].slice(-300) }))
      },
      selectTrace: (selectedTraceId) => set({ selectedTraceId }),

      select: (selection, tab) => set((s) => ({ selection, contextTab: tab ?? s.contextTab })),
      setContextTab: (contextTab) => set({ contextTab }),
      setBottomTab: (bottomTab) => set({ bottomTab }),
      pushChat: (m) => set((s) => ({ chat: [...s.chat, m] })),

      saveToLibrary: (ref, myUnderstanding = "") => {
        const c = ref.conceptId ? CONCEPTS[ref.conceptId] : undefined
        const item: LibraryItem = {
          id: uid("li"),
          kind: ref.kind === "span" ? "event" : ref.kind === "code" ? "snippet" : c ? "concept" : "note",
          title: c && ref.kind === "concept" ? c.name : ref.label,
          conceptId: ref.conceptId,
          systemExplanation: ref.detail ?? c?.what ?? "",
          myUnderstanding,
          source: { mode: get().mode, label: ref.label, project: get().project },
          tags: c ? [c.id, c.category.toLowerCase()] : [ref.kind],
          createdAt: Date.now(),
          visibility: "private",
          useAsContext: true,
        }
        set((s) => ({ library: [item, ...s.library] }))
        return item
      },
      updateLibraryItem: (id, patch) => set((s) => ({ library: s.library.map((l) => (l.id === id ? { ...l, ...patch } : l)) })),
      deleteLibraryItem: (id) => set((s) => ({ library: s.library.filter((l) => l.id !== id) })),
      addExperience: (e) =>
        set((s) => {
          const number = Math.max(0, ...s.experiences.map((x) => x.number)) + 1
          return { experiences: [{ ...e, id: uid("ex"), number, createdAt: Date.now() }, ...s.experiences] }
        }),
      updateExperience: (id, patch) => set((s) => ({ experiences: s.experiences.map((x) => (x.id === id ? { ...x, ...patch } : x)) })),
      deleteExperience: (id) => set((s) => ({ experiences: s.experiences.filter((x) => x.id !== id) })),
      setPersonalContext: (personalContext) => set({ personalContext }),
      setRememberRuntime: (rememberRuntime) => set({ rememberRuntime }),

      setCommandOpen: (commandOpen) => set({ commandOpen }),
      setDialog: (dialog) => set({ dialog, commandOpen: false }),
      setWelcomed: (welcomed) => set({ welcomed }),
      setPref: (k, v) => set((s) => ({ prefs: { ...s.prefs, [k]: v } })),
      openNote: (noteFor) => set({ noteFor }),
      setExperienceDraftOpen: (experienceDraftOpen) => set({ experienceDraftOpen }),

      appendOutput: (lines) => set((s) => ({ output: [...s.output, ...lines].slice(-2000) })),
      setDraft: (draft) => set({ draft, understanding: null, mode: "build", activeServiceId: null, selection: draft ? { kind: "service", id: draft.id, label: draft.name } : get().selection }),
      beginRealBuild: () => {
        const draft = get().draft
        if (!draft) return null
        const spec: ServiceSpec = { ...draft, status: "building", files: [], tests: [] }
        const steps = planFor(spec)
        const runs = Object.fromEntries(steps.map((st) => [st.id, { status: "todo", output: "", reasoning: "", logs: [], files: [] } as StepRun]))
        set((s) => ({
          services: [...s.services.filter((x) => x.id !== spec.id), spec],
          draft: null,
          build: { specId: spec.id, steps, index: 0, startedAt: Date.now(), finished: false, real: true, runs },
          focusStepId: steps[0].id,
          activeServiceId: spec.id,
          output: [...s.output, `$ kivo build ${spec.id}`, `→ plan: ${steps.length} steps · ${steps.filter((x) => x.executor === "ai").length} AI · ${steps.filter((x) => x.executor === "deterministic").length} deterministic`],
        }))
        return spec
      },
      patchBuild: (fn) => set((s) => (s.build ? { build: fn(s.build) } : {})),
      finishRealBuild: (ok, info) => {
        const b = get().build
        if (!b) return
        const spec = get().services.find((s) => s.id === b.specId)!
        const files = [...new Set(Object.values(b.runs).flatMap((r) => r.files))]
        const booted = !!info.url
        const tech = `${languageName(spec.implementation.language)} · ${frameworkName(spec.implementation.language, spec.implementation.framework)}`
        const { node, edges } = nodesForService(spec.id, spec.name, tech, spec.purpose, spec.dependsOn.filter((d) => get().nodes.some((n) => n.id === d)), !!spec.cache)
        const status = ok ? "running" : "failed"
        set((s) => ({
          build: { ...b, finished: true, ok, index: b.steps.length, ...info },
          services: s.services.map((x) => (x.id === spec.id ? { ...x, status, files, tests: info.tests ?? x.tests } : x)),
          nodes: booted ? [...s.nodes.filter((n) => n.id !== node.id), { ...node, status }] : s.nodes,
          edges: booted ? [...s.edges.filter((e) => !edges.some((ne) => ne.id === e.id)), ...edges] : s.edges,
        }))
      },
      openFile: (path, content) =>
        set((s) => ({
          mode: "code",
          activeFile: path,
          openFiles: s.openFiles.includes(path) ? s.openFiles : [...s.openFiles, path],
          fileCache: content === undefined || s.fileCache[path] ? s.fileCache : { ...s.fileCache, [path]: { content, saved: content } },
        })),
      closeFile: (path) =>
        set((s) => {
          const openFiles = s.openFiles.filter((f) => f !== path)
          const { [path]: _, ...fileCache } = s.fileCache
          void _
          return { openFiles, fileCache, activeFile: s.activeFile === path ? (openFiles[openFiles.length - 1] ?? null) : s.activeFile }
        }),
      setActiveFile: (activeFile) => set({ activeFile }),
      editFile: (path, content) => set((s) => ({ fileCache: { ...s.fileCache, [path]: { saved: s.fileCache[path]?.saved ?? "", content } } })),
      markSaved: (path) => set((s) => ({ fileCache: { ...s.fileCache, [path]: { ...s.fileCache[path], saved: s.fileCache[path].content } } })),
      updateChat: (id, patch) => set((s) => ({ chat: s.chat.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
    }),
    {
      name: "kivo:v1",
      partialize: (s) => ({
        level: s.level,
        discipline: s.discipline,
        workspaceSection: s.workspaceSection,
        library: s.library,
        experiences: s.experiences,
        personalContext: s.personalContext,
        rememberRuntime: s.rememberRuntime,
        welcomed: s.welcomed,
        prefs: s.prefs,
        runtimeLive: s.runtimeLive,
        bottomTab: s.bottomTab,
        stack: s.stack,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<State>
        return { ...current, ...p, prefs: { ...current.prefs, ...p.prefs } }
      },
    },
  ),
)

function frameworkFirst(language: string) {
  return (
    {
      python: "fastapi",
      typescript: "express",
      go: "chi",
      rust: "axum",
      java: "spring",
      kotlin: "ktor",
      swift: "vapor",
      dart: "shelf",
      cpp: "drogon",
    }[language] ?? ""
  )
}
