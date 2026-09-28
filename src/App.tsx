import { ThemeProvider } from "next-themes"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppShell } from "@/shell/AppShell"
import { ErrorBoundary } from "@/shell/ErrorBoundary"

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <TooltipProvider delayDuration={300}>
        {/* Last line of defence: a render error anywhere (top bar, dialogs) shows a recoverable message, not a blank page. */}
        <ErrorBoundary>
          <AppShell />
        </ErrorBoundary>
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </ThemeProvider>
  )
}
