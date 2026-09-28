/**
 * Symbols in a file for Go to Symbol (⌘⇧O) and the breadcrumbs. Line-based patterns per
 * language rather than a syntax tree, so it works the same for every language Kivo shows —
 * including ones with only a basic highlighter — and on files that don't parse yet.
 */

export interface SymbolInfo {
  name: string
  kind: "class" | "function" | "method" | "type" | "variable" | "heading" | "key" | "selector"
  /** 1-based line. */
  line: number
  /** 0-based column of the name. */
  col: number
  /** Indentation / heading depth, for nesting in lists. */
  depth: number
}

type Rule = [RegExp, SymbolInfo["kind"]]

const JS: Rule[] = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, "function"],
  [/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, "type"],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>|memo\(|forwardRef\(|create)/, "function"],
  [/^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+|override\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|return\b)([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/, "method"],
]

const RULES: Record<string, Rule[]> = {
  py: [
    [/^\s*class\s+([A-Za-z_]\w*)/, "class"],
    [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, "function"],
    [/^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/, "variable"],
  ],
  js: JS,
  go: [
    [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, "function"],
    [/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, "class"],
    [/^type\s+([A-Za-z_]\w*)/, "type"],
  ],
  rs: [
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, "function"],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|union)\s+([A-Za-z_]\w*)/, "class"],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:trait|type)\s+([A-Za-z_]\w*)/, "type"],
    [/^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_][\w:]*)/, "class"],
    [/^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)/, "type"],
  ],
  java: [
    [/^\s*(?:(?:public|private|protected|static|final|abstract|sealed|data|open|internal)\s+)*(?:class|interface|enum|record|object)\s+([A-Za-z_]\w*)/, "class"],
    [/^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|override|suspend|open|internal)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/, "function"],
    [/^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)+[\w<>[\],.? ]+\s+([A-Za-z_]\w*)\s*\(/, "method"],
  ],
  c: [
    [/^\s*(?:class|struct|union|enum(?:\s+class)?|namespace)\s+([A-Za-z_]\w*)\s*(?:[:{]|$)/, "class"],
    [/^(?!\s)(?!return\b|if\b|for\b|while\b|switch\b|else\b)[\w:*&<>, ]+?[\s*&]([A-Za-z_][\w:~]*)\s*\([^;]*$/, "function"],
    [/^\s*#define\s+([A-Za-z_]\w*)/, "variable"],
  ],
  php: [
    [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/, "class"],
    [/^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?([A-Za-z_]\w*)/, "function"],
  ],
  rb: [
    [/^\s*(?:class|module)\s+([A-Z][\w:]*)/, "class"],
    [/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, "function"],
  ],
  swift: [
    [/^\s*(?:(?:public|private|internal|open|final|fileprivate)\s+)*(?:class|struct|enum|protocol|extension|actor)\s+([A-Za-z_]\w*)/, "class"],
    [/^\s*(?:(?:public|private|internal|open|final|static|override|fileprivate|mutating)\s+)*func\s+([A-Za-z_]\w*)/, "function"],
  ],
  sql: [[/^\s*create\s+(?:or\s+replace\s+)?(?:table|view|index|function|procedure|trigger|type)\s+(?:if\s+not\s+exists\s+)?([\w."]+)/i, "class"]],
  sh: [[/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{?/, "function"]],
}

const ALIAS: Record<string, string> = { ts: "js", tsx: "js", jsx: "js", mjs: "js", cjs: "js", mts: "js", kt: "java", kts: "java", scala: "java", cs: "java", dart: "java", h: "c", hpp: "c", cc: "c", cpp: "c", cxx: "c", hh: "c", bash: "sh", zsh: "sh" }

export function symbolsOf(path: string, text: string): SymbolInfo[] {
  const ext = (path.split(".").pop() ?? "").toLowerCase()
  const lines = text.split("\n")
  const out: SymbolInfo[] = []
  if (ext === "md" || ext === "markdown" || ext === "mdx") {
    let fence = false
    lines.forEach((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence
      const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l)
      if (m) out.push({ name: m[2], kind: "heading", line: i + 1, col: m[1].length + 1, depth: m[1].length - 1 })
    })
    return out
  }
  if (ext === "yaml" || ext === "yml" || ext === "toml") {
    lines.forEach((l, i) => {
      const m = ext === "toml" ? /^\s*\[+\s*([^\]]+?)\s*\]+/.exec(l) : /^( {0,4})([A-Za-z_][\w.-]*)\s*:/.exec(l)
      if (m) out.push({ name: ext === "toml" ? m[1] : m[2], kind: "key", line: i + 1, col: l.indexOf(ext === "toml" ? m[1] : m[2]), depth: ext === "toml" ? 0 : m[1].length / 2 })
    })
    return out
  }
  if (ext === "css" || ext === "scss" || ext === "sass" || ext === "less") {
    lines.forEach((l, i) => {
      const m = /^(\s*)([^\s@/{}][^{};]*?)\s*\{\s*$/.exec(l)
      if (m) out.push({ name: m[2], kind: "selector", line: i + 1, col: m[1].length, depth: Math.floor(m[1].length / 2) })
    })
    return out
  }
  const rules = RULES[ALIAS[ext] ?? ext] ?? [...RULES.py, ...JS]
  let block = false
  lines.forEach((l, i) => {
    if (l.length > 400) return
    // Skip C-style block comments so commented-out code doesn't show up.
    if (block) {
      if (l.includes("*/")) block = false
      return
    }
    if (/^\s*\/\*/.test(l) && !l.includes("*/")) {
      block = true
      return
    }
    if (/^\s*(\/\/|#(?!define)|\*)/.test(l)) return
    for (const [re, kind] of rules) {
      const m = re.exec(l)
      if (!m) continue
      const indent = /^\s*/.exec(l)![0].replace(/\t/g, "    ").length
      out.push({ name: m[1], kind, line: i + 1, col: Math.max(0, l.indexOf(m[1], m.index)), depth: Math.floor(indent / 2) })
      break
    }
  })
  return out
}

/**
 * The chain of symbols enclosing a line (for breadcrumbs), by indentation: a symbol encloses the
 * cursor while the cursor's code is indented deeper than it. `text` is the file content.
 */
export function symbolAt(symbols: SymbolInfo[], text: string, line: number): SymbolInfo[] {
  const lines = text.split("\n")
  let i = Math.min(line, lines.length) - 1
  while (i > 0 && !lines[i].trim()) i--
  const depth = Math.floor((/^\s*/.exec(lines[i] ?? "")![0].replace(/\t/g, "    ").length) / 2)
  const chain: SymbolInfo[] = []
  for (const s of symbols) {
    if (s.line > line) break
    while (chain.length && chain[chain.length - 1].depth >= s.depth) chain.pop()
    chain.push(s)
  }
  return chain.filter((s) => s.line === i + 1 || s.kind === "heading" || s.depth < depth)
}
