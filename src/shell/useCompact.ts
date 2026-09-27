import { useSyncExternalStore } from "react"

/** Width tiers: compact (< 960px) swaps side panels for sheets; medium (< 1280px) starts with the context panel folded. */
function subscribe(cb: () => void) {
  window.addEventListener("resize", cb)
  return () => window.removeEventListener("resize", cb)
}

export function useWidthTier(): "compact" | "medium" | "wide" {
  return useSyncExternalStore(subscribe, () => (window.innerWidth < 960 ? "compact" : window.innerWidth < 1280 ? "medium" : "wide"))
}
