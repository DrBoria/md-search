import * as React from "react"
import { cn } from "../../utils"

export interface InputProps
    extends React.InputHTMLAttributes<HTMLInputElement> { }

const Input = React.forwardRef<HTMLInputElement, InputProps>(
    ({ className, type, ...props }, ref) => {
        return (
            <input
                type={type}
                className={cn(
                    "flex h-[26px] w-full rounded-[2px] border border-[var(--vscode-input-border)] bg-[var(--vscode-input-background)] px-2 py-1 text-[13px] text-[var(--vscode-input-foreground)] shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-[var(--vscode-input-placeholderForeground)] focus-visible:outline-none focus-visible:border-[var(--vscode-focusBorder)] focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50",
                    className
                )}
                ref={ref}
                {...props}
            />
        )
    }
)
Input.displayName = "Input"

export { Input }
