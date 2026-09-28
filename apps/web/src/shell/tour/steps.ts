/**
 * The guided tour's content: what Kivo is, then one stop per part of the screen, in plain words.
 * Pure data (no React) so it can be tested and adapted to where Kivo runs and which workspace is open.
 */

export type Side = "bottom" | "top" | "left" | "right"

export interface TourStep {
  id: string
  title: string
  body: string
  /** Optional short list under the body (e.g. what each mode is for). */
  points?: { label: string; text: string }[]
  /** `data-tour` names to spotlight, first visible one wins. None (or none visible) → a centered card. */
  targets?: string[]
  side?: Side
  /** Put the screen in the state this step talks about (side panels only open on wide screens; narrow ones point at their button). */
  prepare?: "build-mode" | "open-context"
  kind?: "intro" | "finish"
}

export interface TourContext {
  /** Hosted web app (no daemon): no terminal, AI uses the user's own Groq key. */
  inBrowser: boolean
  /** The workspace's word for the first mode: Build, Train, Assess… */
  primaryMode: string
  /** Software workspaces start from a "describe it" box; others from a workspace home. */
  software: boolean
  /** AI is already connected. */
  aiReady: boolean
}

export function tourSteps(c: TourContext): TourStep[] {
  return [
    {
      id: "intro",
      kind: "intro",
      title: "Kivo in one minute",
      body: "Kivo turns what you describe in everyday words into working software — and explains every part of it at the level you choose. You don't need to write code to start.",
    },
    {
      id: "workspace",
      targets: ["workspace", "workspace-toggle"],
      side: "right",
      title: "Pick your field",
      body: "Kivo adapts its screens and its words to the kind of work you do — software, data, embedded devices, games and more. Switch here any time; your project stays the same.",
    },
    {
      id: "modes",
      targets: ["modes"],
      side: "bottom",
      title: "Five places, one project",
      body: "Move between them from this bar. Nothing is lost when you switch.",
      points: [
        { label: c.primaryMode, text: c.software ? "describe something and Kivo makes it" : "the home for your kind of work" },
        { label: "Code", text: "see and change the files, with AI help" },
        { label: "Observe", text: "watch your system handle requests, live" },
        { label: "Learn", text: "a map of how everything fits together" },
        { label: "Library", text: "notes and lessons you've saved" },
      ],
    },
    c.software
      ? {
          id: "describe",
          targets: ["intent", "main"],
          side: "bottom",
          prepare: "build-mode",
          title: "Say what you want",
          body: "Type it like you'd tell a colleague — for example “a way for customers to book a table”. Kivo first shows you a plan in plain language. Nothing is built until you approve it.",
        }
      : {
          id: "describe",
          targets: ["main"],
          side: "left",
          prepare: "build-mode",
          title: `Your ${c.primaryMode.toLowerCase()} home`,
          body: "Everything for your kind of work starts here. Click any card or item to open it — Kivo explains what it is on the right.",
        },
    {
      id: "context",
      targets: ["context", "context-toggle"],
      side: "left",
      prepare: "open-context",
      title: "Click anything, get an explanation",
      body: "Select a service, a file or a step and it's explained here. Open the AI tab to ask follow-up questions like “why is it built this way?”.",
    },
    {
      id: "level",
      targets: ["level", "context", "context-toggle"],
      side: "bottom",
      title: "Explanations at your level",
      body: "Beginner means plain language with no jargon. Move up to Intermediate, Advanced or Expert whenever you want more detail — every explanation and AI answer follows this setting.",
    },
    {
      id: "command",
      targets: ["command"],
      side: "bottom",
      title: "Not sure where something is? Just ask",
      body: "Click here or press ⌘K (Ctrl K on Windows) and type what you want — “build a login”, “open settings”, “explain caching”.",
    },
    {
      id: "project",
      targets: ["project"],
      side: "bottom",
      title: "Start with the demo, then bring your own",
      body: c.inBrowser
        ? "You're looking at a demo project. From here you can open a folder on your computer (Chrome or Edge) or import a public GitHub repository."
        : "You're looking at a demo project. From here you can open a folder on your computer or clone a repository from GitHub.",
    },
    {
      id: "ai",
      targets: ["ai"],
      side: "bottom",
      title: c.aiReady ? "AI is connected" : "Turn on AI",
      body: c.aiReady
        ? "This shows which AI model Kivo is using. Click it to check the connection or switch model."
        : c.inBrowser
          ? "Kivo's AI runs on Groq. Click here and paste your Groq API key — it stays in this browser only. Until then, Kivo shows simulated results so you can still look around."
          : "No AI service is connected yet, so Kivo shows simulated results. Add a key in the .env file on your computer to turn it on.",
    },
    {
      id: "finish",
      kind: "finish",
      title: "You're ready",
      body: "Describe something, click around the demo, or ask ⌘K. Every change Kivo proposes waits for your OK.",
    },
  ]
}
