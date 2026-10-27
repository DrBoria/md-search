import React, { useEffect, useState } from 'react';
import { cn } from '../../utils';

interface PushNotificationProps {
    message: string;
    type?: 'info' | 'error' | 'success';
    visible: boolean;
    onDismiss?: () => void;
    duration?: number;
}

export const PushNotification: React.FC<PushNotificationProps> = ({
    message,
    type = 'info',
    visible,
    onDismiss,
    duration = 2000
}) => {
    const [isShowing, setIsShowing] = useState(visible);

    useEffect(() => {
        setIsShowing(visible);
        if (visible && duration > 0) {
            const timer = setTimeout(() => {
                setIsShowing(false);
                onDismiss?.();
            }, duration);
            return () => clearTimeout(timer);
        }
    }, [visible, duration, onDismiss]);

    // Animation classes
    // We want it to take space, so we animate height and opacity?
    // Or translate Y?
    // If we want it to "push" content, we should animate height.

    return (
        <div
            className={cn(
                "w-full overflow-hidden transition-all duration-300 ease-in-out flex flex-col items-center justify-center bg-[var(--vscode-editor-background)] border-b border-[var(--vscode-widget-border)]",
                isShowing ? "max-h-[40px] opacity-100" : "max-h-0 opacity-0 border-none"
            )}
            role="alert"
        >
            <div className="flex items-center gap-2 px-4 py-1 text-xs font-medium text-[var(--vscode-foreground)]">
                {type === 'success' && <span className="codicon codicon-check text-[var(--vscode-testing-iconPassed)]" />}
                {type === 'error' && <span className="codicon codicon-error text-[var(--vscode-testing-iconFailed)]" />}
                {type === 'info' && <span className="codicon codicon-info text-[var(--vscode-textLink-foreground)]" />}
                <span>{message}</span>
            </div>
        </div>
    );
};
