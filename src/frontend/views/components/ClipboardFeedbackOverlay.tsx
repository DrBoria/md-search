import React, { useEffect, useState } from 'react';
import { cn } from '../../utils';

interface ClipboardFeedbackOverlayProps {
    visible: boolean;
    message: string;
    subMessage?: string;
    type: 'copy' | 'cut' | 'paste' | 'info';
    onClose: () => void;
}

export const ClipboardFeedbackOverlay: React.FC<ClipboardFeedbackOverlayProps> = ({
    visible,
    message,
    subMessage,
    type,
    onClose
}) => {
    const [render, setRender] = useState(visible);
    const [animating, setAnimating] = useState(false);

    useEffect(() => {
        if (visible) {
            setRender(true);
            setTimeout(() => setAnimating(true), 10);

            // Auto-hide after 2 seconds
            const timer = setTimeout(() => {
                onClose();
            }, 2000);
            return () => clearTimeout(timer);
        } else {
            setAnimating(false);
            const timer = setTimeout(() => setRender(false), 300);
            return () => clearTimeout(timer);
        }
    }, [visible, onClose]);

    if (!render) return null;

    const icons = {
        copy: 'codicon-copy',
        cut: 'codicon-cut',
        paste: 'codicon-paste',
        info: 'codicon-info'
    };

    return (
        <div
            className={cn(
                "absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 min-w-[200px] z-50",
                "px-4 py-3 shadow-lg backdrop-blur-sm border",
                "bg-[var(--vscode-notifications-background)] text-[var(--vscode-notifications-foreground)] border-[var(--vscode-notifications-border)]",
                "flex flex-col items-center justify-center gap-1",
                "transition-all duration-300 ease-in-out",
                animating ? "opacity-100 scale-100" : "opacity-0 scale-95"
            )}
        >
            <div className="flex items-center gap-2 text-lg font-medium">
                <span className={cn("codicon", icons[type])} />
                <span>{message}</span>
            </div>
            {subMessage && (
                <div className="text-xs opacity-90 font-mono">
                    {subMessage}
                </div>
            )}
        </div>
    );
};
