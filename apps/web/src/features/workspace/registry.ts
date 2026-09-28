import { Code2 } from "lucide-react"
import type { Discipline } from "@kivo/core/types"
import { data } from "./defs/data"
import { devops } from "./defs/devops"
import { embedded } from "./defs/embedded"
import { frontend } from "./defs/frontend"
import { game } from "./defs/game"
import { ml } from "./defs/ml"
import { rl } from "./defs/rl"
import { security } from "./defs/security"
import type { WorkspaceDef } from "./model"

/** Software keeps its own purpose-built UI (intent → spec → build); the rest render from their definitions. */
export const software: WorkspaceDef = {
  id: "software",
  label: "Software",
  icon: Code2,
  hue: 250,
  tagline: "Describe a service, review the plan, watch it get built.",
  primaryMode: "Build",
  hero: { title: "What do you want to build?", body: "" },
  placeholder: "",
  examples: [],
  looksFor: [],
  relevant: () => true,
  stats: () => [],
  sections: [],
}

/** Order shown in the workspace picker. */
export const WORKSPACES: WorkspaceDef[] = [software, frontend, data, ml, rl, security, devops, embedded, game]

export const workspace = (id: Discipline) => WORKSPACES.find((w) => w.id === id) ?? software
