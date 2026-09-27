import { ThemeProvider } from "next-themes"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppShell } from "@/shell/AppShell"

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <TooltipProvider delayDuration={300}>
        <AppShell />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </ThemeProvider>
  )
}
