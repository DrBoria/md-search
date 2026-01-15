import React from "react";
import { css } from "@emotion/css";

// Helper function to get highlighted match context with replacement preview
export function getHighlightedMatchContextWithReplacement(
    source: string | undefined,
    locOrPos: { start: { line: number; column: number }, end: { line: number; column: number } } | { start: number, end: number } | number | any,
    find: string,
    replace: string,
    searchMode: string,
    matchCase: boolean,
    wholeWord: boolean,
    endParam?: number
): React.ReactNode {
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
            const originalMatch = source.substring(start, end);
            const highlightStart = start - lineStart;
            const highlightEnd = end - lineStart;

            if (highlightStart < 0 || highlightEnd < 0 || highlightStart > lineText.length ||
                highlightEnd > lineText.length || highlightStart >= highlightEnd) {
                return lineText || `Match at ${start}...${end}`;
            }

            // Создаем замену в зависимости от режима поиска
            let replacement = replace;

            if (searchMode === 'regex') {
                try {
                    // Для regex применяем замену с поддержкой групп захвата
                    const flags = matchCase ? 'g' : 'gi';
                    const regex = new RegExp(find, flags);

                    // Сбрасываем lastIndex и применяем regex к оригинальному совпадению
                    regex.lastIndex = 0;
                    replacement = originalMatch.replace(regex, replace);
                } catch (e) {
                    // В случае ошибки с regex, используем прямую замену
                }
            } else if (searchMode === 'text') {
                // Для текстового режима - простая замена
                replacement = replace;
            }

            const before = lineText.substring(0, highlightStart);
            const highlighted = lineText.substring(highlightStart, highlightEnd);
            const after = lineText.substring(highlightEnd);

            return (
                <>
                    {before}
                    <span style={{
                        backgroundColor: 'var(--vscode-editor-findMatchHighlightBackground)',
                        color: 'var(--vscode-errorForeground)',
                        textDecoration: 'line-through',
                    }}>{highlighted}</span>
                    {replacement && (
                        <span style={{
                            backgroundColor: 'var(--vscode-diffEditor-insertedTextBackground)',
                            color: 'var(--vscode-gitDecoration-addedResourceForeground)',
                            marginRight: '5px',
                            padding: '0 3px',
                            borderRadius: '2px',
                        }}>{`${replacement}`}</span>
                    )}
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

        // Извлекаем текст совпадения
        let originalMatch = '';

        if (!isMultiline) {
            // Для однострочного совпадения
            const lineText = lines[loc.start.line - 1] || '';
            originalMatch = lineText.substring(loc.start.column, loc.end.column);

            // Ensure highlight indices are within the bounds of the extracted line
            if (loc.start.column < 0 || loc.end.column < 0 || loc.start.column > lineText.length ||
                loc.end.column > lineText.length || loc.start.column >= loc.end.column) {
                return lineText || `Match at ${loc.start.line}:${loc.start.column}...${loc.end.line}:${loc.end.column}`;
            }

            // Создаем замену в зависимости от режима поиска
            let replacement = replace;

            if (searchMode === 'regex') {
                try {
                    // Для regex применяем замену с поддержкой групп захвата
                    const flags = matchCase ? 'g' : 'gi';
                    const regex = new RegExp(find, flags);

                    // Сбрасываем lastIndex и применяем regex к оригинальному совпадению
                    regex.lastIndex = 0;
                    replacement = originalMatch.replace(regex, replace);
                } catch (e) {
                    // В случае ошибки с regex, используем прямую замену
                }
            } else if (searchMode === 'text') {
                // Для текстового режима - простая замена
                replacement = replace;
            }

            const before = lineText.substring(0, loc.start.column);
            const highlighted = originalMatch;
            const after = lineText.substring(loc.end.column);

            // Return JSX with highlighted span + replacement preview
            return (
                <>
                    {before}
                    <span style={{
                        backgroundColor: 'var(--vscode-editor-findMatchHighlightBackground)',
                        color: 'var(--vscode-errorForeground)',
                        textDecoration: 'line-through',
                    }}>{highlighted}</span>
                    {replacement && (
                        <span style={{
                            backgroundColor: 'var(--vscode-diffEditor-insertedTextBackground)',
                            color: 'var(--vscode-gitDecoration-addedResourceForeground)',
                            marginRight: '5px',
                            padding: '0 3px',
                            borderRadius: '2px',
                        }}>{`${replacement}`}</span>
                    )}
                    {after}
                </>
            );
        } else {
            // Для многострочного совпадения

            // Собираем исходный текст совпадения
            for (let i = loc.start.line - 1; i <= loc.end.line - 1; i++) {
                const line = lines[i] || '';
                if (i === loc.start.line - 1) {
                    originalMatch += line.substring(loc.start.column);
                } else if (i === loc.end.line - 1) {
                    originalMatch += '\n' + line.substring(0, loc.end.column);
                } else {
                    originalMatch += '\n' + line;
                }
            }

            // Создаем замену
            let replacement = replace;

            if (searchMode === 'regex') {
                try {
                    const flags = matchCase ? 'g' : 'gi';
                    const regex = new RegExp(find, flags);
                    regex.lastIndex = 0;
                    replacement = originalMatch.replace(regex, replace);
                } catch (e) {
                    // В случае ошибки с regex, используем прямую замену
                }
            } else if (searchMode === 'text') {
                replacement = replace;
            }

            // Создаем элементы для каждой строки
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
                        color: 'var(--vscode-errorForeground)',
                        textDecoration: 'line-through',
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
                            color: 'var(--vscode-errorForeground)',
                            textDecoration: 'line-through',
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
                            color: 'var(--vscode-errorForeground)',
                            textDecoration: 'line-through',
                        }}>{lastLineHighlighted}</span>
                        {lastLineAfter}
                    </div>
                );
            }

            // Добавляем замену после последней строки
            if (replacement) {
                elements.push(
                    <div key="replacement" style={{
                        marginTop: '4px',
                    }}>
                        <span style={{
                            backgroundColor: 'var(--vscode-diffEditor-insertedTextBackground)',
                            color: 'var(--vscode-gitDecoration-addedResourceForeground)',
                            padding: '0 3px',
                            borderRadius: '2px',
                            whiteSpace: 'pre-wrap'
                        }}>{replacement}</span>
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
