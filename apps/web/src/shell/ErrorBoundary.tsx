import { Component, type ReactNode } from "react"
import { Button } from "@/components/ui/button"

/** Keeps a rendering error in one view from blanking the whole environment. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="text-sm font-medium">This view hit an error</div>
        <pre className="max-w-lg overflow-auto rounded-md border bg-muted/40 p-3 text-left font-mono text-[11px] text-muted-foreground">{this.state.error.message}</pre>
        <Button size="sm" variant="outline" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    )
  }
}
