import { contextBridge, ipcRenderer } from "electron"

/**
 * The only bridge between the page and the desktop app: who we are, and menu commands
 * (Settings…, Open Folder…, Take the Tour) forwarded to the UI, which owns those dialogs.
 * No Node, no filesystem: everything else goes through the daemon's HTTP API like in a browser.
 */
contextBridge.exposeInMainWorld("kivoDesktop", {
  platform: process.platform,
  info: () => ipcRenderer.invoke("kivo:info") as Promise<{ version: string; platform: string }>,
  onCommand(cb: (command: string) => void) {
    const listener = (_e: unknown, command: string) => cb(command)
    ipcRenderer.on("kivo:command", listener)
    return () => void ipcRenderer.removeListener("kivo:command", listener)
  },
})
