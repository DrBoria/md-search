import React from "react";


// Helper function to get highlighted match context
export function getHighlightedMatchContext(source: string | undefined, locOrPos: { start: { line: number; column: number }, end: { line: number; column: number } } | { start: number, end: number } | number | any, endParam?: number, isRegex?: boolean): React.ReactNode {
    // Support different call formats
    let loc: { start: { line: number; column: number }, end: { line: number; column: number } };

    if (typeof locOrPos === 'number' && typeof endParam === 'number') {
        // Old format with numeric positions
        loc = {
            start: { line: 1, column: locOrPos },
            end: { line: 1, column: endParam }
        };
    } else if (locOrPos?.loc) {
        // Match object with loc field
        loc = locOrPos.loc;
    } else if (locOrPos?.start?.line !== undefined && locOrPos?.end?.line !== undefined) {
        // Already formed loc object
        loc = locOrPos;
    } else if (locOrPos?.start !== undefined && locOrPos?.end !== undefined && typeof locOrPos.start === 'number' && typeof locOrPos.end === 'number') {
        // Object with numeric start/end
        const start = locOrPos.start;
        const end = locOrPos.end;

        if (!source) {
            return `Match at ${start}...${end}`;
        }

        try {
            // Use old implementation for numeric indices
            const lineStart = source.lastIndexOf('\n', start - 1) + 1;
            let lineEnd = source.indexOf('\n', start);
            if (lineEnd === -1) {
                lineEnd = source.length;
            }

            const lineText = source.substring(lineStart, lineEnd);
            const highlightStart = start - lineStart;
            const highlightEnd = end - lineStart;

            if (highlightStart < 0 || highlightEnd < 0 || highlightStart > lineText.length ||
                highlightEnd > lineText.length || highlightStart >= highlightEnd) {
                return lineText || `Match at ${start}...${end}`;
            }

            const before = lineText.substring(0, highlightStart);
            const highlighted = lineText.substring(highlightStart, highlightEnd);
            const after = lineText.substring(highlightEnd);

            return (
                <>
                    {before}
                    <span className="bg-[var(--vscode-editor-findMatchHighlightBackground)] text-[var(--vscode-editor-findMatchHighlightForeground)]">
                        {highlighted}
                    </span>
                    {after}
                </>
            );
        } catch (e) {
            return `Match at ${start}...${end}`;
        }
    } else {
        // Fallback if format not recognized
        return `Invalid match location data`;
    }

    if (!source) {
        return `Match at ${loc.start.line}:${loc.start.column}...${loc.end.line}:${loc.end.column}`;
    }

    try {
        // Split source into lines
        const lines = source.split('\n');

        // Check if match is multiline
        const isMultiline = loc.start.line !== loc.end.line;

        if (!isMultiline) {
            // For single-line match use previous logic
            const lineText = lines[loc.start.line - 1] || '';

            // Calculate highlight positions relative to the start of the line
            const highlightStart = loc.start.column;
            const highlightEnd = loc.end.column;

            // Ensure highlight indices are within the bounds of the extracted line
            if (highlightStart < 0 || highlightEnd < 0 || highlightStart > lineText.length ||
                highlightEnd > lineText.length || highlightStart >= highlightEnd) {
                return lineText || `Match at ${loc.start.line}:${loc.start.column}...${loc.end.line}:${loc.end.column}`;
            }

            // Truncation Logic
            const MAX_CONTEXT_CHARS = 40; // Approx characters to show before/after
            const ELLIPSIS = '...';

            let beforeText = lineText.substring(0, highlightStart);
            let highlightedText = lineText.substring(highlightStart, highlightEnd);
            let afterText = lineText.substring(highlightEnd);

            // Truncate 'before' text (keep the end)
            if (beforeText.length > MAX_CONTEXT_CHARS) {
                beforeText = ELLIPSIS + beforeText.substring(beforeText.length - MAX_CONTEXT_CHARS);
            }

            // Truncate 'after' text (keep the start)
            if (afterText.length > MAX_CONTEXT_CHARS) {
                afterText = afterText.substring(0, MAX_CONTEXT_CHARS) + ELLIPSIS;
            }

            // Return JSX with highlighted span
            return (
                <div className="whitespace-pre overflow-hidden text-ellipsis">
                    {beforeText}
                    <span className="bg-[var(--vscode-editor-findMatchHighlightBackground)] text-[var(--vscode-editor-findMatchHighlightForeground)]">
                        {highlightedText}
                    </span>
                    {afterText}
                </div>
            );
        } else {
            // For multiline match
            if (isRegex) {
                const startLine = loc.start.line - 1;
                const endLine = loc.end.line - 1;

                return (
                    <div className="whitespace-pre overflow-x-auto overflow-y-hidden font-mono text-xs my-1 border-l-2 border-[var(--vscode-editor-lineHighlightBorder)] pl-2">
                        {lines.slice(startLine, endLine + 1).map((line, i) => {
                            const currentLineNum = loc.start.line + i;
                            // Calculate highlight range for this line
                            let hlStart = 0;
                            let hlEnd = line.length;

                            if (currentLineNum === loc.start.line) hlStart = loc.start.column;
                            if (currentLineNum === loc.end.line) hlEnd = loc.end.column;

                            // Safety checks
                            hlStart = Math.max(0, Math.min(hlStart, line.length));
                            hlEnd = Math.max(0, Math.min(hlEnd, line.length));

                            const pre = line.substring(0, hlStart);
                            const hl = line.substring(hlStart, hlEnd);
                            const post = line.substring(hlEnd);

                            return (
                                <div key={i} className="min-h-[16px] leading-4">
                                    {pre}
                                    <span className="bg-[var(--vscode-editor-findMatchHighlightBackground)] text-[var(--vscode-editor-findMatchHighlightForeground)]">
                                        {hl}
                                    </span>
                                    {post}
                                </div>
                            );
                        })}
                    </div>
                );
            }

            // For multiline match - show only first line with ellipsis
            const firstLineIndex = loc.start.line - 1;
            const firstLine = lines[firstLineIndex] || '';

            const highlightStart = loc.start.column;
            // Highlight until end of this line
            const highlightEnd = firstLine.length;

            const MAX_CONTEXT_CHARS = 40;
            const ELLIPSIS = '...';

            let beforeText = firstLine.substring(0, highlightStart);
            let highlightedText = firstLine.substring(highlightStart, highlightEnd);
            // After text for multiline is just "..." effectively, or we assume it continues
            let afterText = ELLIPSIS;

            // Truncate 'before' text
            if (beforeText.length > MAX_CONTEXT_CHARS) {
                beforeText = ELLIPSIS + beforeText.substring(beforeText.length - MAX_CONTEXT_CHARS);
            }

            // Truncate 'highlighted' if it's too long on the first line? 
            if (highlightedText.length > MAX_CONTEXT_CHARS * 2) {
                highlightedText = highlightedText.substring(0, MAX_CONTEXT_CHARS * 2) + ELLIPSIS;
            }

            return (
                <div className="whitespace-pre overflow-hidden text-ellipsis" title="Multiline match">
                    {beforeText}
                    <span className="bg-[var(--vscode-editor-findMatchHighlightBackground)] text-[var(--vscode-editor-findMatchHighlightForeground)]">
                        {highlightedText}
                    </span>
                    {afterText}
                </div>
            );
        }
    } catch (e) {
        return `Match at ${loc.start.line}:${loc.start.column}...${loc.end.line}:${loc.end.column}`;
    }
}
