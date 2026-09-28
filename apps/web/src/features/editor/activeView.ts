import type { EditorView } from "@codemirror/view"

/** The code editor currently on screen, for commands that start outside it (e.g. ⌘⇧F seeding from the selection). */
export const activeView: { current: EditorView | null } = { current: null }

/** The selected text in the editor, if it's a short single-line selection worth searching for. */
export function selectedText(): string | undefined {
  const view = activeView.current
  if (!view) return undefined
  const sel = view.state.selection.main
  if (sel.empty) return undefined
  const text = view.state.sliceDoc(sel.from, sel.to)
  return text.includes("\n") || text.length > 200 ? undefined : text
}
