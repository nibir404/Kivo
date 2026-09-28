import { Boxes, Clapperboard, Gamepad2, Gauge, Image, Keyboard, ListChecks, MessageSquare, Package } from "lucide-react"
import { jitter, match, stem, type WorkspaceDef } from "../model"

const SCENE = /\.(unity|tscn|scn|umap|tmx|ldtk)$/
const SCRIPT = /\.(cs|gd|gdshader|lua)$|(^|\/)(Source|scripts?|Scripts)\/.*\.(cpp|h|ts|js)$/
const ASSET = /\.(png|jpe?g|psd|aseprite|wav|ogg|mp3|fbx|glb|gltf|blend|obj|ttf|otf)$/
const ASSET_KIND: [RegExp, string][] = [
  [/\.(png|jpe?g|psd|aseprite)$/, "Textures & sprites"],
  [/\.(wav|ogg|mp3)$/, "Audio"],
  [/\.(fbx|glb|gltf|blend|obj)$/, "3D models"],
  [/\.(ttf|otf)$/, "Fonts"],
]

export const game: WorkspaceDef = {
  id: "game",
  label: "Game Development",
  icon: Gamepad2,
  hue: 55,
  tagline: "Scenes, systems and the feel of play — at a steady frame rate.",
  primaryMode: "Build",
  hero: { title: "What should the player experience?", body: "Describe a mechanic, a level or a system. Kivo plans the scenes, the scripts and the assets, and keeps an eye on the frame budget." },
  placeholder: "e.g. A double-jump with coyote time and a short buffer, so jumps feel responsive on a controller",
  examples: [
    { icon: Gamepad2, label: "Responsive jump", text: "Implement a platformer jump in Godot with variable height, coyote time (100 ms) and a jump buffer (120 ms). Explain the tuning values." },
    { icon: Boxes, label: "Inventory system", text: "Design an inventory system with stackable items, a hotbar and save/load. Which data lives on the item vs the slot?" },
    { icon: Gauge, label: "Fix frame drops", text: "Frame time spikes to 40 ms when many enemies are on screen. Walk me through profiling it and the usual fixes (pooling, batching, LOD)." },
  ],
  looksFor: ["project.godot, ProjectSettings/ (Unity), *.uproject (Unreal)", "scenes: *.tscn, *.unity, *.umap", "scripts: *.gd, *.cs", "assets: textures, audio, models"],
  relevant: (_t, cat) => cat === "Game",
  stats: (ctx) => [
    { label: "Engine", value: ctx.analysis.detections.find((d) => d.category === "Game")?.tech ?? "—" },
    { label: "Scenes", value: String(match(ctx.files, SCENE).length) },
    { label: "Scripts", value: String(match(ctx.files, SCRIPT).length) },
    { label: "Assets", value: String(match(ctx.files, ASSET).length) },
  ],
  sections: [
    {
      id: "scenes",
      label: "Scenes",
      icon: Clapperboard,
      blurb: "Levels, menus and the scenes they're built from.",
      setup: "Set up the scene structure for a small game in this repository: main menu, one level, pause menu and how they load each other.",
      build: (ctx) => {
        const files = match(ctx.files, SCENE)
        return files.length
          ? { source: "project", evidence: files, count: files.length, panels: [{ kind: "table", columns: [{ key: "scene", label: "Scene" }, { key: "file", label: "File", mono: true }], rows: files.map((f) => ({ scene: stem(f), file: { text: f, mono: true } })) }] }
          : {
              source: "example",
              note: "No engine project in this repository yet.",
              panels: [
                {
                  kind: "table",
                  columns: [
                    { key: "scene", label: "Scene" },
                    { key: "nodes", label: "Nodes", align: "right" },
                    { key: "loads", label: "Loads" },
                  ],
                  rows: [
                    { scene: "MainMenu", nodes: 24, loads: "Level_01, Settings" },
                    { scene: "Level_01", nodes: 812, loads: "PauseMenu, GameOver" },
                    { scene: "PauseMenu", nodes: 18, loads: "MainMenu" },
                  ],
                },
              ],
            }
      },
    },
    {
      id: "scripts",
      label: "Entities & scripts",
      icon: Boxes,
      blurb: "The behaviours attached to things in the world.",
      build: (ctx) => {
        const files = match(ctx.files, SCRIPT)
        return files.length
          ? { source: "project", evidence: files, count: files.length, panels: [{ kind: "table", columns: [{ key: "name", label: "Script" }, { key: "file", label: "File", mono: true }], rows: files.map((f) => ({ name: stem(f), file: { text: f, mono: true } })) }] }
          : {
              source: "example",
              panels: [
                {
                  kind: "table",
                  columns: [
                    { key: "name", label: "Entity" },
                    { key: "scripts", label: "Scripts", mono: true },
                    { key: "does", label: "Behaviour" },
                  ],
                  rows: [
                    { name: "Player", scripts: "player.gd, health.gd", does: "Movement, jump, taking damage" },
                    { name: "Slime", scripts: "enemy.gd, patrol.gd", does: "Patrols, chases within 6 m" },
                    { name: "Coin", scripts: "pickup.gd", does: "Adds score, plays sound, frees itself" },
                  ],
                },
              ],
            }
      },
    },
    {
      id: "assets",
      label: "Assets",
      icon: Image,
      blurb: "Textures, audio, models and fonts, by type.",
      build: (ctx) => {
        const files = match(ctx.files, ASSET)
        if (files.length) {
          const rows = ASSET_KIND.map(([re, kind]) => ({ kind, count: files.filter((f) => re.test(f)).length })).filter((r) => r.count)
          return { source: "project", evidence: files, count: files.length, panels: [{ kind: "table", columns: [{ key: "kind", label: "Type" }, { key: "count", label: "Files", align: "right" }], rows }] }
        }
        return {
          source: "example",
          panels: [
            {
              kind: "table",
              columns: [
                { key: "kind", label: "Type" },
                { key: "count", label: "Files", align: "right" },
                { key: "size", label: "Size", align: "right" },
              ],
              rows: [
                { kind: "Textures & sprites", count: 214, size: "86 MB" },
                { kind: "Audio", count: 58, size: "41 MB" },
                { kind: "3D models", count: 37, size: "120 MB" },
                { kind: "Fonts", count: 3, size: "1.2 MB" },
              ],
            },
          ],
        }
      },
    },
    {
      id: "performance",
      label: "Frame budget",
      icon: Gauge,
      blurb: "Frame time against the 16.7 ms budget for 60 FPS.",
      build: () => ({
        source: "example",
        note: "Example profile. Spikes above the line are dropped frames — the player feels them as stutter.",
        panels: [
          {
            kind: "metrics",
            tiles: [
              { label: "Average FPS", value: "58", tone: "good" },
              { label: "1 % low", value: "31 FPS", tone: "warn", hint: "spikes when many enemies spawn" },
              { label: "Draw calls", value: "1,240", tone: "warn" },
            ],
            charts: [{ title: "Frame time", unit: "ms", x: "frame", series: [{ name: "frame time", points: jitter("game-ft", 90, 14.5, 1.8, 0.06) }], target: { value: 16.7, label: "60 FPS budget" } }],
          },
        ],
      }),
    },
    {
      id: "input",
      label: "Input map",
      icon: Keyboard,
      blurb: "Actions and their bindings on every device.",
      build: () => ({
        source: "example",
        panels: [
          {
            kind: "table",
            columns: [
              { key: "action", label: "Action", mono: true },
              { key: "kb", label: "Keyboard" },
              { key: "pad", label: "Controller" },
            ],
            rows: [
              { action: "move", kb: "WASD / arrows", pad: "Left stick" },
              { action: "jump", kb: "Space", pad: "A / Cross" },
              { action: "attack", kb: "J / left click", pad: "X / Square" },
              { action: "pause", kb: "Esc", pad: "Start" },
            ],
          },
        ],
      }),
    },
    {
      id: "builds",
      label: "Builds",
      icon: Package,
      blurb: "Export targets and their state.",
      build: (ctx) => ({
        source: "example",
        note: ctx.analysis.detections.some((d) => d.category === "Game") ? "Export presets appear here once they're configured in the engine." : undefined,
        panels: [
          {
            kind: "table",
            columns: [
              { key: "target", label: "Target" },
              { key: "size", label: "Size", align: "right" },
              { key: "state", label: "Last build" },
            ],
            rows: [
              { target: "Windows (x64)", size: "212 MB", state: { text: "passed", tone: "good" } },
              { target: "macOS (universal)", size: "240 MB", state: { text: "passed", tone: "good" } },
              { target: "Web (WASM)", size: "48 MB", state: { text: "over 40 MB budget", tone: "warn" } },
            ],
          },
        ],
      }),
    },
    {
      id: "playtests",
      label: "Playtests",
      icon: MessageSquare,
      blurb: "What players said, sorted by what to do about it.",
      build: () => ({
        source: "example",
        panels: [
          {
            kind: "board",
            columns: [
              { title: "Bugs", tone: "bad", cards: [{ title: "Fell through floor on level 1 after respawn", meta: "3 of 8 testers" }] },
              { title: "Feel", tone: "warn", cards: [{ title: "Jump feels floaty", meta: "5 of 8 — try higher gravity on the way down" }] },
              { title: "Balance", tone: "info", cards: [{ title: "Boss too easy with ranged weapon", meta: "2 of 8" }] },
              { title: "Loved it", tone: "good", cards: [{ title: "Coin sound and screen shake", meta: "6 of 8" }] },
            ],
          },
        ],
      }),
    },
    {
      id: "checklist",
      label: "Release checklist",
      icon: ListChecks,
      blurb: "Before a build goes to players.",
      build: () => ({
        source: "guide",
        panels: [
          {
            kind: "checklist",
            items: [
              { id: "fps", title: "Holds the target frame rate on the minimum-spec machine" },
              { id: "save", title: "Save files survive quitting mid-save and old versions load" },
              { id: "rebind", title: "Every control can be rebound; controller works end to end" },
              { id: "a11y", title: "Subtitles, colour-blind safe cues and adjustable difficulty" },
              { id: "pause", title: "The game pauses when the window loses focus" },
              { id: "crash", title: "Crash reports are captured with the build version" },
            ],
          },
        ],
      }),
    },
  ],
}
