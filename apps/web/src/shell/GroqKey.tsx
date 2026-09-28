import { useState } from "react"
import { Check, ExternalLink, KeyRound, Loader2, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { inBrowser } from "@/lib/transport"
import { saveGroqKey } from "@/state/runners"
import { useKivo } from "@/state/store"

/**
 * The hosted app's AI setup: the user pastes their own Groq key. It's stored only in this
 * browser and sent only to api.groq.com — the deployed site contains no key.
 */
export function GroqKeyForm({ onSaved, autoFocus }: { onSaved?: () => void; autoFocus?: boolean }) {
  const groq = useKivo((s) => s.ai?.providers?.find((p) => p.id === "groq"))
  const connected = groq?.status === "ok"
  const [key, setKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (value: string) => {
    setBusy(true)
    setError(null)
    try {
      const p = await saveGroqKey(value)
      if (value && p?.status !== "ok") setError(p?.message ?? "Groq didn't accept that key")
      else {
        setKey("")
        onSaved?.()
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[12px]">
        <KeyRound className="size-3.5 text-muted-foreground" />
        {connected ? (
          <span className="flex items-center gap-1.5">
            <Check className="size-3.5 text-success" /> Groq connected · {groq.models.join(" → ")}
          </span>
        ) : (
          <span className="text-muted-foreground">{groq?.status === "unauthorized" ? "Groq rejected the saved key" : "No Groq key yet"}</span>
        )}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (key.trim()) void save(key)
        }}
      >
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={connected ? "Paste a different key to replace it" : "gsk_…"}
          aria-label="Groq API key"
          className="font-mono text-[12px]"
        />
        <Button type="submit" disabled={busy || !key.trim()}>
          {busy && <Loader2 className="animate-spin" />}
          {connected ? "Replace" : "Connect"}
        </Button>
      </form>
      {error && (
        <p className="flex items-start gap-1.5 text-[12px] text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {error}
        </p>
      )}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {inBrowser ? "Stored only in this browser and sent only to Groq. Anyone using this browser profile can use it." : "Stored on this computer (readable only by your user account) and sent only to Groq."}{" "}
        <a className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground" href="https://console.groq.com/keys" target="_blank" rel="noreferrer">
          Get a key <ExternalLink className="size-3" />
        </a>
        {connected && (
          <>
            {" · "}
            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => void save("")} disabled={busy}>
              Remove key
            </button>
          </>
        )}
      </p>
    </div>
  )
}
