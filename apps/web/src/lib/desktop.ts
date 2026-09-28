import { useKivo } from "@/state/store"
import { useUi } from "@/shell/capture"
import { startTour } from "@/shell/tour/store"

/** What the desktop app's preload exposes (apps/desktop/src/preload.ts). */
interface KivoDesktop {
  platform: string
  onCommand(cb: (command: string) => void): () => void
}

const bridge = (): KivoDesktop | undefined => (window as { kivoDesktop?: KivoDesktop }).kivoDesktop

/**
 * Inside the desktop app: let the page draw under the macOS title bar (the top bar is the drag
 * area, with room for the traffic lights), and handle the app menu's commands.
 */
export function connectDesktop() {
  const d = bridge()
  if (!d) return
  document.documentElement.dataset.desktop = d.platform === "darwin" ? "mac" : d.platform
  d.onCommand((command) => {
    const s = useKivo.getState()
    if (command === "settings") s.setDialog("settings")
    else if (command === "shortcuts") s.setDialog("shortcuts")
    else if (command === "tour") startTour()
    else if (command === "open-folder") useUi.getState().setProjectDialog("open")
    else if (command === "clone") useUi.getState().setProjectDialog("clone")
  })
}
