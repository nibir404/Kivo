import { historyField } from "@codemirror/commands"
import type { EditorState } from "@codemirror/state"

/**
 * Per-tab editor state kept across tab switches (the editor is re-created per file): undo
 * history, selection and scroll position come back when the user returns to a tab.
 */

const states = new Map<string, EditorState>()
const scrolls = new Map<string, number>()

export const rememberState = (path: string, state: EditorState) => states.set(path, state)
export const rememberScroll = (path: string, top: number) => scrolls.set(path, top)
export const savedScroll = (path: string) => scrolls.get(path)

/** A serialized state to start the editor from, if the remembered one still matches the text. */
export function initialStateFor(path: string, content: string) {
  const s = states.get(path)
  if (!s || s.doc.length !== content.length || s.doc.toString() !== content) return undefined
  return { json: s.toJSON({ history: historyField }), fields: { history: historyField } }
}

export function forgetViewState(path: string) {
  states.delete(path)
  scrolls.delete(path)
}
