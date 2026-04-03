import React from 'react';

/**
 * A horizontal indeterminate progress bar (running light).
 * Uses CSS animation defined in index.css (or inline styles if necessary).
 * 
 * Animation: "indeterminate-progress"
 * Keyframes needed:
 * @keyframes indeterminate-progress {
 *   0% { left: -40%; width: 40%; }
 *   50% { left: 20%; width: 80%; }
 *   100% { left: 100%; width: 10%; }
 * }
 */
export const IndeterminateProgressBar = ({ className = '', style }: { className?: string, style?: React.CSSProperties }) => {
    return (
        <div
            className={`h-[2px] w-full bg-transparent overflow-hidden relative ${className}`}
            style={style}
        >
            <div
                className="absolute top-0 bottom-0 h-full w-[40%] bg-[var(--vscode-progressBar-background)] animate-indeterminate-progress"
            />
            <style>{`
                @keyframes indeterminate-progress {
                    0% { left: -40%; }
                    100% { left: 100%; }
                }
                .animate-indeterminate-progress {
                    animation: indeterminate-progress 1.5s cubic-bezier(0.4, 0.0, 0.2, 1) infinite;
                }
            `}</style>
        </div>
    );
};
