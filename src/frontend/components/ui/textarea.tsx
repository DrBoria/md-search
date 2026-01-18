import * as React from "react"
import { cn } from "../../utils"

export interface TextareaProps
    extends React.TextareaHTMLAttributes<HTMLTextAreaElement> { }

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
    ({ className, ...props }, ref) => {
        return (
            <textarea
                className={cn(
                    "flex min-h-[26px] w-full rounded-[2px] border border-[var(--vscode-input-border)] bg-[var(--vscode-input-background)] px-2 py-1 text-[13px] text-[var(--vscode-input-foreground)] shadow-sm placeholder:text-[var(--vscode-input-placeholderForeground)] focus-visible:outline-none focus-visible:border-[var(--vscode-focusBorder)] focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50 resize-y font-sans",
                    className
                )}
                ref={ref}
                {...props}
            />
        )
    }
)
Textarea.displayName = "Textarea"

export { Textarea }
