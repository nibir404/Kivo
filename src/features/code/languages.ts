import { EditorState, type Extension } from "@codemirror/state"
import { cpp } from "@codemirror/lang-cpp"
import { css } from "@codemirror/lang-css"
import { go } from "@codemirror/lang-go"
import { html } from "@codemirror/lang-html"
import { java } from "@codemirror/lang-java"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { php } from "@codemirror/lang-php"
import { python } from "@codemirror/lang-python"
import { rust } from "@codemirror/lang-rust"
import { sass } from "@codemirror/lang-sass"
import { sql } from "@codemirror/lang-sql"
import { xml } from "@codemirror/lang-xml"
import { yaml } from "@codemirror/lang-yaml"
import { indentUnit, StreamLanguage, type StreamParser } from "@codemirror/language"
import { csharp, dart, kotlin, scala } from "@codemirror/legacy-modes/mode/clike"
import { diff } from "@codemirror/legacy-modes/mode/diff"
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile"
import { lua } from "@codemirror/legacy-modes/mode/lua"
import { nginx } from "@codemirror/legacy-modes/mode/nginx"
import { properties } from "@codemirror/legacy-modes/mode/properties"
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf"
import { ruby } from "@codemirror/legacy-modes/mode/ruby"
import { shell } from "@codemirror/legacy-modes/mode/shell"
import { swift } from "@codemirror/legacy-modes/mode/swift"
import { toml } from "@codemirror/legacy-modes/mode/toml"

/**
 * Language support by file name. Full Lezer grammars where CodeMirror has one (folding, bracket
 * matching, comment toggling, smart indent); CodeMirror's legacy stream modes for highlighting
 * the rest (Kotlin, Swift, shell, TOML, Dockerfile…).
 */

export interface Lang {
  name: string
  ext: Extension[]
}

const stream = (p: StreamParser<unknown>) => [StreamLanguage.define(p)]

const BY_NAME: Record<string, () => Lang> = {
  dockerfile: () => ({ name: "Dockerfile", ext: stream(dockerFile) }),
  makefile: () => ({ name: "Makefile", ext: stream(shell) }),
  gemfile: () => ({ name: "Ruby", ext: stream(ruby) }),
  ".gitignore": () => ({ name: "Ignore", ext: stream(properties) }),
  ".dockerignore": () => ({ name: "Ignore", ext: stream(properties) }),
  ".env": () => ({ name: "Environment", ext: stream(properties) }),
}

const BY_EXT: Record<string, () => Lang> = {
  py: () => ({ name: "Python", ext: [python()] }),
  pyi: () => ({ name: "Python", ext: [python()] }),
  ts: () => ({ name: "TypeScript", ext: [javascript({ typescript: true })] }),
  mts: () => ({ name: "TypeScript", ext: [javascript({ typescript: true })] }),
  cts: () => ({ name: "TypeScript", ext: [javascript({ typescript: true })] }),
  tsx: () => ({ name: "TypeScript JSX", ext: [javascript({ typescript: true, jsx: true })] }),
  js: () => ({ name: "JavaScript", ext: [javascript({ jsx: true })] }),
  mjs: () => ({ name: "JavaScript", ext: [javascript()] }),
  cjs: () => ({ name: "JavaScript", ext: [javascript()] }),
  jsx: () => ({ name: "JavaScript JSX", ext: [javascript({ jsx: true })] }),
  json: () => ({ name: "JSON", ext: [json()] }),
  jsonc: () => ({ name: "JSON with Comments", ext: [json()] }),
  yaml: () => ({ name: "YAML", ext: [yaml()] }),
  yml: () => ({ name: "YAML", ext: [yaml()] }),
  sql: () => ({ name: "SQL", ext: [sql()] }),
  md: () => ({ name: "Markdown", ext: [markdown()] }),
  mdx: () => ({ name: "MDX", ext: [markdown()] }),
  markdown: () => ({ name: "Markdown", ext: [markdown()] }),
  go: () => ({ name: "Go", ext: [go()] }),
  rs: () => ({ name: "Rust", ext: [rust()] }),
  java: () => ({ name: "Java", ext: [java()] }),
  c: () => ({ name: "C", ext: [cpp()] }),
  h: () => ({ name: "C/C++ Header", ext: [cpp()] }),
  cc: () => ({ name: "C++", ext: [cpp()] }),
  cpp: () => ({ name: "C++", ext: [cpp()] }),
  cxx: () => ({ name: "C++", ext: [cpp()] }),
  hpp: () => ({ name: "C++ Header", ext: [cpp()] }),
  ino: () => ({ name: "Arduino", ext: [cpp()] }),
  css: () => ({ name: "CSS", ext: [css()] }),
  scss: () => ({ name: "SCSS", ext: [sass()] }),
  sass: () => ({ name: "Sass", ext: [sass({ indented: true })] }),
  less: () => ({ name: "Less", ext: [css()] }),
  html: () => ({ name: "HTML", ext: [html()] }),
  htm: () => ({ name: "HTML", ext: [html()] }),
  vue: () => ({ name: "Vue", ext: [html()] }),
  svelte: () => ({ name: "Svelte", ext: [html()] }),
  php: () => ({ name: "PHP", ext: [php()] }),
  xml: () => ({ name: "XML", ext: [xml()] }),
  svg: () => ({ name: "SVG", ext: [xml()] }),
  plist: () => ({ name: "Property List", ext: [xml()] }),
  xaml: () => ({ name: "XAML", ext: [xml()] }),
  csproj: () => ({ name: "XML", ext: [xml()] }),
  kt: () => ({ name: "Kotlin", ext: stream(kotlin) }),
  kts: () => ({ name: "Kotlin Script", ext: stream(kotlin) }),
  scala: () => ({ name: "Scala", ext: stream(scala) }),
  cs: () => ({ name: "C#", ext: stream(csharp) }),
  dart: () => ({ name: "Dart", ext: stream(dart) }),
  swift: () => ({ name: "Swift", ext: stream(swift) }),
  rb: () => ({ name: "Ruby", ext: stream(ruby) }),
  lua: () => ({ name: "Lua", ext: stream(lua) }),
  sh: () => ({ name: "Shell", ext: stream(shell) }),
  bash: () => ({ name: "Shell", ext: stream(shell) }),
  zsh: () => ({ name: "Shell", ext: stream(shell) }),
  toml: () => ({ name: "TOML", ext: stream(toml) }),
  ini: () => ({ name: "INI", ext: stream(properties) }),
  cfg: () => ({ name: "INI", ext: stream(properties) }),
  properties: () => ({ name: "Properties", ext: stream(properties) }),
  env: () => ({ name: "Environment", ext: stream(properties) }),
  proto: () => ({ name: "Protocol Buffers", ext: stream(protobuf) }),
  conf: () => ({ name: "Nginx", ext: stream(nginx) }),
  diff: () => ({ name: "Diff", ext: stream(diff) }),
  patch: () => ({ name: "Diff", ext: stream(diff) }),
}

const cache = new Map<string, Lang>()

export function languageFor(path: string): Lang {
  const name = (path.split("/").pop() ?? "").toLowerCase()
  const ext = name.includes(".") ? name.split(".").pop()! : ""
  const key = BY_NAME[name] ? `name:${name}` : name.startsWith(".env") ? "name:.env" : name.startsWith("dockerfile") ? "name:dockerfile" : `ext:${ext}`
  let lang = cache.get(key)
  if (!lang) {
    const make = key.startsWith("name:") ? BY_NAME[key.slice(5)] : BY_EXT[ext]
    lang = make ? make() : { name: "Plain Text", ext: [] }
    cache.set(key, lang)
  }
  return lang
}

export interface Indent {
  tabs: boolean
  size: number
}

/**
 * Detect a file's indentation from its lines (VS Code's "detect indentation"): tabs if most
 * indented lines start with a tab, else the most common step between successive indent levels.
 */
export function detectIndent(text: string, fallback: Indent = { tabs: false, size: 4 }): Indent {
  let tabs = 0
  let spaces = 0
  const steps = new Map<number, number>()
  let prev = 0
  const lines = text.split("\n", 5000)
  for (const line of lines) {
    if (!line.trim()) continue
    const m = /^[ \t]*/.exec(line)![0]
    if (m.startsWith("\t")) tabs++
    else if (m.length) spaces++
    if (!m.includes("\t")) {
      const d = Math.abs(m.length - prev)
      if (d >= 2 && d <= 8) steps.set(d, (steps.get(d) ?? 0) + 1)
      prev = m.length
    }
  }
  if (!tabs && !spaces) return fallback
  if (tabs > spaces) return { tabs: true, size: fallback.size }
  const best = [...steps].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]
  return { tabs: false, size: best?.[0] ?? fallback.size }
}

export const indentExtensions = (i: Indent): Extension[] => [indentUnit.of(i.tabs ? "\t" : " ".repeat(i.size)), EditorState.tabSize.of(i.tabs ? 4 : i.size)]
