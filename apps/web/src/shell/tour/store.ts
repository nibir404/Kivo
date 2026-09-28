import { create } from "zustand"

/** Whether the guided tour is showing. Kept apart from the tour component so menus can start it cheaply. */
export const useTour = create<{ open: boolean; start: () => void; close: () => void }>((set) => ({
  open: false,
  start: () => set({ open: true }),
  close: () => set({ open: false }),
}))

export const startTour = () => useTour.getState().start()
