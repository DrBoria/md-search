import React from "react";


// Helper function to get highlighted match context with replacement preview
export function getHighlightedMatchContextWithReplacement(
    source: string | undefined,
    locOrPos: { start: { line: number; column: number }, end: { line: number; column: number } } | { start: number, end: number } | number | any,
    find: string | undefined,
    replace: string,
    searchMode?: 'text' | 'regex' | 'words' | string,
    matchCase?: boolean,
    wholeWord?: boolean,
    endParam?: number,
    isRegex?: boolean
): React.ReactNode {
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
            const originalMatch = source.substring(start, end);
            const highlightStart = start - lineStart;
            const highlightEnd = end - lineStart;

            if (highlightStart < 0 || highlightEnd < 0 || highlightStart > lineText.length ||
                highlightEnd > lineText.length || highlightStart >= highlightEnd) {
                return lineText || `Match at ${start}...${end}`;
            }

            // Create replacement depending on search mode
            let replacement = replace;

            if (searchMode === 'regex') {
                try {
                    // For regex, apply replacement with capture group support
                    const flags = matchCase ? 'g' : 'gi';
                    const regex = new RegExp(find || '', flags);

                    // Reset lastIndex and apply regex to original match
                    regex.lastIndex = 0;
                    replacement = originalMatch.replace(regex, replace);
                } catch (e) {
                    // In case of regex error, use direct replacement
                }
            } else if (searchMode === 'text') {
                // For text mode - simple replacement
                replacement = replace;
            }

            const before = lineText.substring(0, highlightStart);
            const highlighted = lineText.substring(highlightStart, highlightEnd);
            const after = lineText.substring(highlightEnd);

            return (
                <>
                    {before}
                    <span className="bg-[var(--vscode-editor-findMatchHighlightBackground)] text-[var(--vscode-errorForeground)] line-through">
                        {highlighted}
                    </span>
                    {replacement && (
                        <span className="bg-[var(--vscode-diffEditor-insertedTextBackground)] text-[var(--vscode-gitDecoration-addedResourceForeground)] mr-[5px] px-[3px] rounded-[2px]">
                            {`${replacement}`}
                        </span>
                    )}
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

        // Extract match text
        let originalMatch = '';

        if (!isMultiline) {
            // For single-line match
            const lineText = lines[loc.start.line - 1] || '';
            originalMatch = lineText.substring(loc.start.column, loc.end.column);

            // Ensure highlight indices are within the bounds of the extracted line
            if (loc.start.column < 0 || loc.end.column < 0 || loc.start.column > lineText.length ||
                loc.end.column > lineText.length || loc.start.column >= loc.end.column) {
                return lineText || `Match at ${loc.start.line}:${loc.start.column}...${loc.end.line}:${loc.end.column}`;
            }

            // Create replacement depending on search mode
            let replacement = replace;

            if (searchMode === 'regex') {
                try {
                    // For regex apply replacement with capture group support
                    const flags = matchCase ? 'g' : 'gi';
                    const regex = new RegExp(find || '', flags);

                    // Reset lastIndex and apply regex to original match
                    regex.lastIndex = 0;
                    replacement = originalMatch.replace(regex, replace);
                } catch (e) {
                    // In case of regex error, use direct replacement
                }
            } else if (searchMode === 'text') {
                // For text mode - simple replacement
                replacement = replace;
            }

            // Truncation Logic
            const MAX_CONTEXT_CHARS = 30; // Slightly less because of replacement tag
            const ELLIPSIS = '...';

            let beforeText = lineText.substring(0, loc.start.column);
            let highlightedText = originalMatch;
            let afterText = lineText.substring(loc.end.column);

            // Truncate 'before' text (keep the end)
            if (beforeText.length > MAX_CONTEXT_CHARS) {
                beforeText = ELLIPSIS + beforeText.substring(beforeText.length - MAX_CONTEXT_CHARS);
            }

            // Truncate 'after' text (keep the start)
            if (afterText.length > MAX_CONTEXT_CHARS) {
                afterText = afterText.substring(0, MAX_CONTEXT_CHARS) + ELLIPSIS;
            }

            // Return JSX with highlighted span + replacement preview
            return (
                <div className="whitespace-pre overflow-hidden text-ellipsis flex items-center">
                    {beforeText}
                    <span className="bg-[var(--vscode-editor-findMatchHighlightBackground)] text-[var(--vscode-errorForeground)] line-through">
                        {highlightedText}
                    </span>
                    {replacement && (
                        <span className="bg-[var(--vscode-diffEditor-insertedTextBackground)] text-[var(--vscode-gitDecoration-addedResourceForeground)] mr-[5px] ml-[2px] px-[3px] rounded-[2px]">
                            {`${replacement}`}
                        </span>
                    )}
                    {afterText}
                </div>
            );
        } else {
            // For multiline match
            if (isRegex) {
                const startLine = loc.start.line - 1;
                const endLine = loc.end.line - 1;

                return (
                    <div className="whitespace-pre overflow-x-auto font-mono text-xs my-1 border-l-2 border-[var(--vscode-editor-lineHighlightBorder)] pl-2">
                        {lines.slice(startLine, endLine + 1).map((line, i) => {
                            const currentLineNum = loc.start.line + i;
                            let hlStart = 0;
                            let hlEnd = line.length;

                            if (currentLineNum === loc.start.line) hlStart = loc.start.column;
                            if (currentLineNum === loc.end.line) hlEnd = loc.end.column;

                            hlStart = Math.max(0, Math.min(hlStart, line.length));
                            hlEnd = Math.max(0, Math.min(hlEnd, line.length));

                            const pre = line.substring(0, hlStart);
                            const hl = line.substring(hlStart, hlEnd);
                            const post = line.substring(hlEnd);

                            return (
                                <div key={i} className="min-h-[16px] leading-4">
                                    {pre}
                                    <span className="bg-[var(--vscode-editor-findMatchHighlightBackground)] text-[var(--vscode-errorForeground)] line-through">
                                        {hl}
                                    </span>
                                    {post}
                                </div>
                            );
                        })}
                        <div className="mt-1 text-[var(--vscode-gitDecoration-addedResourceForeground)] bg-[var(--vscode-diffEditor-insertedTextBackground)] p-1 rounded inline-block">
                            <span className="opacity-70 text-[10px] uppercase tracking-wider mr-1">Rep:</span>
                            {replace}
                        </div>
                    </div>
                );
            }

            // For multiline match - also compress to single line
            // Collect original match text (first line)
            const firstLineIndex = loc.start.line - 1;
            const firstLine = lines[firstLineIndex] || '';

            // Just take the first line as representation
            originalMatch = firstLine.substring(loc.start.column); // To the end of the first line at least

            // Create replacement (for display only, simplified)
            let replacement = replace;
            // Regex replacement logic matches typically on full string, but for UI summary we can just show replacement raw
            // Or better, let's keep replacement simple for multiline view

            const MAX_CONTEXT_CHARS = 30;
            const ELLIPSIS = '...';

            let beforeText = firstLine.substring(0, loc.start.column);
            let highlightedText = firstLine.substring(loc.start.column);
            // We assume highlighted continues...
            if (highlightedText.length > MAX_CONTEXT_CHARS) {
                highlightedText = highlightedText.substring(0, MAX_CONTEXT_CHARS) + ELLIPSIS;
            }

            let afterText = ""; // No after text for first line of multiline match usually (it continues on next lines)

            // Truncate 'before'
            if (beforeText.length > MAX_CONTEXT_CHARS) {
                beforeText = ELLIPSIS + beforeText.substring(beforeText.length - MAX_CONTEXT_CHARS);
            }

            return (
                <div className="whitespace-pre overflow-hidden text-ellipsis flex items-center" title="Multiline match">
                    {beforeText}
                    <span className="bg-[var(--vscode-editor-findMatchHighlightBackground)] text-[var(--vscode-errorForeground)] line-through">
                        {highlightedText}
                    </span>
                    {/* Only show replacement if it exists, maybe simplified */}
                    {replacement && (
                        <span className="bg-[var(--vscode-diffEditor-insertedTextBackground)] text-[var(--vscode-gitDecoration-addedResourceForeground)] mr-[5px] ml-[2px] px-[3px] py-0 rounded-[2px] decoration-none border-b border-b-[var(--vscode-gitDecoration-addedResourceForeground)]">
                            {`${replacement}${isMultiline ? '...' : ''}`}</span>
                    )}
                    {/* No after text typically here as we cut off at multiline start */}
                </div>
            );
        }
    } catch (e) {
        return `Match at ${loc.start.line}:${loc.start.column}...${loc.end.line}:${loc.end.column}`;
    }
}
