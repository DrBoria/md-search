import React from "react";
import { css } from "@emotion/css";

// Helper function to get highlighted match context
export function getHighlightedMatchContext(source: string | undefined, locOrPos: { start: { line: number; column: number }, end: { line: number; column: number } } | { start: number, end: number } | number | any, endParam?: number): React.ReactNode {
    // Поддержка разных форматов вызова
    let loc: { start: { line: number; column: number }, end: { line: number; column: number } };

    if (typeof locOrPos === 'number' && typeof endParam === 'number') {
        // Старый формат с числовыми позициями
        loc = {
            start: { line: 1, column: locOrPos },
            end: { line: 1, column: endParam }
        };
    } else if (locOrPos?.loc) {
        // Объект match с полем loc
        loc = locOrPos.loc;
    } else if (locOrPos?.start?.line !== undefined && locOrPos?.end?.line !== undefined) {
        // Уже сформированный объект loc
        loc = locOrPos;
    } else if (locOrPos?.start !== undefined && locOrPos?.end !== undefined && typeof locOrPos.start === 'number' && typeof locOrPos.end === 'number') {
        // Объект с числовыми start/end
        const start = locOrPos.start;
        const end = locOrPos.end;

        if (!source) {
            return `Match at ${start}...${end}`;
        }

        try {
            // Используем старую реализацию для числовых индексов
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
                    <span style={{
                        backgroundColor: 'var(--vscode-editor-findMatchHighlightBackground)',
                        color: 'var(--vscode-editor-findMatchHighlightForeground)',
                    }}>{highlighted}</span>
                    {after}
                </>
            );
        } catch (e) {
            return `Match at ${start}...${end}`;
        }
    } else {
        // Фоллбэк, если формат не распознан
        return `Invalid match location data`;
    }

    if (!source) {
        return `Match at ${loc.start.line}:${loc.start.column}...${loc.end.line}:${loc.end.column}`;
    }

    try {
        // Split source into lines
        const lines = source.split('\n');

        // Проверим, является ли совпадение многострочным
        const isMultiline = loc.start.line !== loc.end.line;

        if (!isMultiline) {
            // Для однострочного совпадения используем прежнюю логику
            const lineText = lines[loc.start.line - 1] || '';

            // Calculate highlight positions relative to the start of the line
            const highlightStart = loc.start.column;
            const highlightEnd = loc.end.column;

            // Ensure highlight indices are within the bounds of the extracted line
            if (highlightStart < 0 || highlightEnd < 0 || highlightStart > lineText.length ||
                highlightEnd > lineText.length || highlightStart >= highlightEnd) {
                return lineText || `Match at ${loc.start.line}:${loc.start.column}...${loc.end.line}:${loc.end.column}`;
            }

            const before = lineText.substring(0, highlightStart);
            const highlighted = lineText.substring(highlightStart, highlightEnd);
            const after = lineText.substring(highlightEnd);

            // Return JSX with highlighted span
            return (
                <>
                    {before}
                    <span style={{
                        backgroundColor: 'var(--vscode-editor-findMatchHighlightBackground)',
                        color: 'var(--vscode-editor-findMatchHighlightForeground)',
                    }}>{highlighted}</span>
                    {after}
                </>
            );
        } else {
            // Для многострочного совпадения
            // Создаем массив элементов для каждой строки
            const elements: React.ReactNode[] = [];

            // Обрабатываем первую строку
            const firstLineIndex = loc.start.line - 1;
            const firstLine = lines[firstLineIndex] || '';
            const firstLineBefore = firstLine.substring(0, loc.start.column);
            const firstLineHighlighted = firstLine.substring(loc.start.column);

            elements.push(
                <div key={`line-${firstLineIndex}`}>
                    {firstLineBefore}
                    <span style={{
                        backgroundColor: 'var(--vscode-editor-findMatchHighlightBackground)',
                        color: 'var(--vscode-editor-findMatchHighlightForeground)',
                    }}>{firstLineHighlighted}</span>
                </div>
            );

            // Обрабатываем промежуточные строки
            for (let i = firstLineIndex + 1; i < loc.end.line - 1; i++) {
                const line = lines[i] || '';
                elements.push(
                    <div key={`line-${i}`}>
                        <span style={{
                            backgroundColor: 'var(--vscode-editor-findMatchHighlightBackground)',
                            color: 'var(--vscode-editor-findMatchHighlightForeground)',
                        }}>{line}</span>
                    </div>
                );
            }

            // Обрабатываем последнюю строку
            const lastLineIndex = loc.end.line - 1;
            if (lastLineIndex > firstLineIndex) {
                const lastLine = lines[lastLineIndex] || '';
                const lastLineHighlighted = lastLine.substring(0, loc.end.column);
                const lastLineAfter = lastLine.substring(loc.end.column);

                elements.push(
                    <div key={`line-${lastLineIndex}`}>
                        <span style={{
                            backgroundColor: 'var(--vscode-editor-findMatchHighlightBackground)',
                            color: 'var(--vscode-editor-findMatchHighlightForeground)',
                        }}>{lastLineHighlighted}</span>
                        {lastLineAfter}
                    </div>
                );
            }

            // Возвращаем контейнер с многострочным содержимым
            return (
                <div className={css`
                    display: flex;
                    flex-direction: column;
                    
                    
                    white-space: pre;
                `}>
                    {elements}
                </div>
            );
        }
    } catch (e) {
        return `Match at ${loc.start.line}:${loc.start.column}...${loc.end.line}:${loc.end.column}`;
    }
}
