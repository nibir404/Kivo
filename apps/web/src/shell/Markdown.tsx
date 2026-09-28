import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

/** Model output rendering. react-markdown never renders raw HTML, so model text can't inject markup. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        "space-y-2 text-[13px] leading-relaxed break-words",
        "[&_strong]:font-semibold [&_em]:italic [&_a]:underline [&_a]:underline-offset-2",
        "[&_h1]:text-sm [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:font-semibold [&_h3]:text-[13px]",
        "[&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5",
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[12px]",
        "[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted/40 [&_pre]:p-2.5 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_table]:w-full [&_table]:text-[12px] [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left",
        "[&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Links never navigate Kivo away; clicking copies the URL instead.
          a: ({ href, children: label }) => (
            <button
              type="button"
              title={href}
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => {
                if (href) navigator.clipboard?.writeText(href).catch(() => {})
                toast("Link copied", { description: href })
              }}
            >
              {label}
            </button>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
