import React, { useEffect, useState } from 'react';
import { cn } from '../../utils';

interface NotificationBannerProps {
    visible: boolean;
    message: string;
    subMessage?: string;
    type: 'copy' | 'cut' | 'paste' | 'info';
    onClose: () => void;
}

export const NotificationBanner: React.FC<NotificationBannerProps> = ({
    visible,
    message,
    subMessage,
    type,
    onClose
}) => {
    const [shouldRender, setShouldRender] = useState(visible);
    const [isExiting, setIsExiting] = useState(false);

    useEffect(() => {
        if (visible) {
            setShouldRender(true);
            setIsExiting(false);

            // Auto close
            const timer = setTimeout(() => {
                handleClose();
            }, 2000);
            return () => clearTimeout(timer);
        } else {
            // Already hidden handled by handleClose -> useEffect dependency loop avoidance
        }
    }, [visible]);

    const handleClose = () => {
        setIsExiting(true);
        setTimeout(() => {
            setShouldRender(false);
            onClose();
        }, 300); // Match animation duration
    };

    if (!shouldRender) return null;

    const icons = {
        copy: 'codicon-copy',
        cut: 'codicon-cut',
        paste: 'codicon-clipboard', // corrected from codicon-paste to codicon-clipboard typically, or codicon-paste if valid
        info: 'codicon-info'
    };

    // Mapping type to specific styles if needed, mostly consistent
    const bgColor = "bg-[var(--vscode-editor-background)]";
    const borderColor = "border-[var(--vscode-focusBorder)]"; // Highlight border

    return (
        <div
            className={cn(
                "w-full overflow-hidden flex items-center justify-center px-4 border-l-4 shadow-sm select-none",
                "bg-[var(--vscode-editorWrapper-background)] border-[var(--vscode-focusBorder)]", // Theme integration
                "text-[var(--vscode-foreground)]",
                isExiting ? "animate-banner-out" : "animate-banner-in"
            )}
            style={{ "--banner-height": "32px" } as React.CSSProperties}
        >
            <div className="flex items-center gap-2 text-xs font-medium truncate">
                <span className={cn("codicon", icons[type] || 'codicon-info')} />
                <span>{message}</span>
                {subMessage && <span className="opacity-75">({subMessage})</span>}
            </div>
        </div>
    );
};
