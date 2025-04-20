import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import {
    VSCodeTextArea,
    VSCodeTextField,
    VSCodeButton,
    VSCodeDropdown,
    VSCodeOption,
    VSCodeCheckbox,
    VSCodeDivider,
} from '@vscode/webview-ui-toolkit/react'
import { css, keyframes } from '@emotion/css'
import useEvent from '../react/useEvent'
import {
    MessageToWebview,
    MessageFromWebview,
    SerializedTransformResultEvent,
    SearchReplaceViewStatus,
    SearchReplaceViewValues,
    SearchLevel,
} from './SearchReplaceViewTypes'
import path from 'path-browserify' // Use path-browserify for web compatibility
import { URI } from 'vscode-uri'; // Import URI library
// Используем file-icons-js через window.FileIcons. Импорт файла CSS происходит в SearchReplaceViewEntry.tsx

// Объявление типа для глобальной переменной
declare global {
    interface Window {
        activeSearchReplaceValues?: SearchReplaceViewValues;
        iconsPath?: string;
        MaterialIcons?: {
            getIconForFilePath: (filePath: string) => string;
            getIconUrlForFilePath: (filePath: string, iconsBasePath?: string) => string;
        };
        materialIconsPath?: string;
    }
}

// Helper function to get highlighted match context
function getHighlightedMatchContext(source: string | undefined, start: number, end: number): React.ReactNode {
    if (!source || start === undefined || end === undefined) {
        return `Match at ${start}...${end}`; // Fallback
    }

    try {
        // Find the start of the line containing the match start
        const lineStart = source.lastIndexOf('\n', start - 1) + 1; // Use const
        // Find the end of the line containing the match start
        let lineEnd = source.indexOf('\n', start);
        if (lineEnd === -1) {
            lineEnd = source.length; // Handle last line
        }

        const lineText = source.substring(lineStart, lineEnd); // <-- REMOVED .trim()

        // Calculate highlight positions relative to the start of the (trimmed) original line substring
        const highlightStart = start - lineStart;
        const highlightEnd = end - lineStart;

        // Ensure highlight indices are within the bounds of the extracted line
        // Also check that indices make sense relative to each other
        if (highlightStart < 0 || highlightEnd < 0 || highlightStart > lineText.length || highlightEnd > lineText.length || highlightStart >= highlightEnd) {
            // Consider logging this case for debugging?
            // console.warn("Invalid highlight indices calculated", { lineText, start, end, lineStart, lineEnd, highlightStart, highlightEnd });
            return lineText || `Match at ${start}...${end}`; // Return line without highlight if indices are invalid
        }


        const before = lineText.substring(0, highlightStart);
        const highlighted = lineText.substring(highlightStart, highlightEnd);
        const after = lineText.substring(highlightEnd);

        // Return JSX with highlighted span
        // Use CSS variables for theming
        return (
            <>
                {before}
                <span style={{
                    backgroundColor: 'var(--vscode-editor-findMatchHighlightBackground)',
                    color: 'var(--vscode-editor-findMatchHighlightForeground)',
                    // fontWeight: 'bold' // Optional: make it bold
                }}>{highlighted}</span>
                {after}
            </>
        );
    } catch (e) {
        // console.error("Error creating highlighted context:", e); // Keep console.error commented out or handle differently
        return `Match at ${start}...${end}`; // Fallback on error
    }
}

// Helper function to get highlighted match context with replacement preview
function getHighlightedMatchContextWithReplacement(
    source: string | undefined,
    start: number,
    end: number,
    find: string,
    replace: string,
    searchMode: string,
    matchCase: boolean,
    wholeWord: boolean
): React.ReactNode {
    if (!source || start === undefined || end === undefined) {
        return `Match at ${start}...${end}`; // Fallback
    }

    try {
        // Find the start of the line containing the match start
        const lineStart = source.lastIndexOf('\n', start - 1) + 1;
        // Find the end of the line containing the match start
        let lineEnd = source.indexOf('\n', start);
        if (lineEnd === -1) {
            lineEnd = source.length; // Handle last line
        }

        const lineText = source.substring(lineStart, lineEnd);
        const originalMatch = source.substring(start, end);

        // Calculate highlight positions relative to the start of the original line substring
        const highlightStart = start - lineStart;
        const highlightEnd = end - lineStart;

        // Ensure highlight indices are within the bounds of the extracted line
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
                // console.error("Regex replacement error:", e);
            }
        } else if (searchMode === 'text') {
            // Для текстового режима - простая замена
            replacement = replace;
        }
        // Для режима AST (astx) мы не можем точно предсказать замену в UI, 
        // поэтому просто показываем значение replace как есть

        const before = lineText.substring(0, highlightStart);
        const highlighted = lineText.substring(highlightStart, highlightEnd);
        const after = lineText.substring(highlightEnd);

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
                        color: 'var(--vscode-gitDecoration-addedResourceForeground)', // Зеленый цвет для замены
                        marginRight: '5px',
                        padding: '0 3px',
                        borderRadius: '2px',
                    }}>{`${replacement}`}</span>
                )}
                {after}
            </>
        );
    } catch (e) {
        // console.error("Error creating replacement preview:", e);
        return `Match at ${start}...${end}`; // Fallback on error
    }
}

// Добавляю функцию для получения целой строки без украшений
function getLineFromSource(source: string | undefined, start: number, end: number): string {
    if (!source || start === undefined || end === undefined) {
        return '';
    }

    try {
        // Находим начало строки с совпадением
        const lineStart = source.lastIndexOf('\n', start - 1) + 1;

        // Находим конец строки с совпадением
        let lineEnd = source.indexOf('\n', start);
        if (lineEnd === -1) {
            lineEnd = source.length;
        }

        // Возвращаем текст строки без обрезки
        return source.substring(lineStart, lineEnd);
    } catch (e) {
        return '';
    }
}

// --- Types for File Tree ---
interface FileTreeNodeBase {
    name: string
    relativePath: string
}

interface FolderNode extends FileTreeNodeBase {
    type: 'folder'
    children: FileTreeNode[]
    stats?: {
        numMatches: number
        numFilesWithMatches: number
    }
}

interface FileNode extends FileTreeNodeBase {
    type: 'file'
    absolutePath: string
    results: SerializedTransformResultEvent[]
}

type FileTreeNode = FolderNode | FileNode

// Helper function to convert file URI to path, handling potential Windows drive letters
function uriToPath(uriString: string | undefined): string {
    if (!uriString) return ''; // Return empty string instead of undefined
    try {
        const uri = URI.parse(uriString);
        if (uri.scheme === 'file') {
            // fsPath handles drive letters correctly (e.g., /c:/Users -> c:\Users)
            return uri.fsPath;
        }
        // Return original string if it's not a file URI or parsing fails
        return uriString;
    } catch (e) {
        // Fallback to returning the original string on error
        return uriString;
    }
}

// --- Helper Function to Build File Tree ---
function buildFileTree(
    resultsByFile: Record<string, SerializedTransformResultEvent[]>,
    workspacePathUri: string, // No longer undefined - it's a required parameter
): FolderNode {
    const root: FolderNode = { name: '', relativePath: '', type: 'folder', children: [], stats: { numMatches: 0, numFilesWithMatches: 0 } }
    const workspacePath = uriToPath(workspacePathUri); // Convert workspace URI to path
    // Helper to find or create folder nodes
    const findOrCreateFolder = (
        parent: FolderNode,
        segment: string,
        currentRelativePath: string
    ): FolderNode => {
        const existing = parent.children.find(
            (child) => child.type === 'folder' && child.name === segment
        ) as FolderNode | undefined
        if (existing) {
            return existing
        }
        const newFolder: FolderNode = {
            name: segment,
            relativePath: currentRelativePath,
            type: 'folder',
            children: [],
            stats: { numMatches: 0, numFilesWithMatches: 0 }
        }
        parent.children.push(newFolder)
        // Sort children: folders first, then files, alphabetically
        parent.children.sort((a, b) => {
            if (a.type !== b.type) {
                return a.type === 'folder' ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });
        return newFolder
    }

    // Use absolute path as key initially
    Object.entries(resultsByFile).forEach(([absoluteFilePathOrUri, fileResults]) => {
        // Convert file URI/path to a standard path
        const absoluteFilePath = uriToPath(absoluteFilePathOrUri);

        // Calculate relative path if workspacePath is available
        const displayPath = workspacePath
            ? path.relative(workspacePath, absoluteFilePath)
            : absoluteFilePath; // Fallback to absolute if no workspace

        // Ensure consistent POSIX separators for internal logic
        const posixDisplayPath = displayPath.replace(/\\/g, '/'); // Replace backslashes with forward slashes
        const segments = posixDisplayPath.split('/').filter(Boolean);
        let currentNode = root;
        let currentRelativePath = '';

        // Calculate file statistics
        const fileMatches = fileResults.reduce((sum, r) => sum + (r.matches?.length || 0), 0);
        const hasMatches = fileMatches > 0;

        // Update root stats for this file
        if (hasMatches) {
            root.stats!.numMatches += fileMatches;
            root.stats!.numFilesWithMatches += 1;
        }

        segments.forEach((segment, index) => {
            // Use posix.join for consistency in relative path construction
            currentRelativePath = currentRelativePath ? path.posix.join(currentRelativePath, segment) : segment;
            if (index === segments.length - 1) {
                // It's a file
                const fileNode: FileNode = {
                    name: path.basename(absoluteFilePath), // Basename from the actual path
                    relativePath: posixDisplayPath, // Store POSIX relative path
                    absolutePath: absoluteFilePathOrUri, // Keep original URI/path for opening
                    type: 'file',
                    results: fileResults
                }
                currentNode.children.push(fileNode)
                // Sort children
                currentNode.children.sort((a, b) => {
                    if (a.type !== b.type) {
                        return a.type === 'folder' ? -1 : 1;
                    }
                    return a.name.localeCompare(b.name);
                });
            } else {
                // It's a folder
                currentNode = findOrCreateFolder(currentNode, segment, currentRelativePath);

                // Update folder stats as we traverse
                if (hasMatches) {
                    currentNode.stats!.numMatches += fileMatches;
                    currentNode.stats!.numFilesWithMatches += 1;
                }
            }
        })
    })

    return root
}

// --- Helper Function to Filter Tree for Matches ---
function filterTreeForMatches(node: FileTreeNode): FileTreeNode | null {
    if (node.type === 'file') {
        // Keep file only if it has matches
        const hasMatches = node.results.some(r => r.matches && r.matches.length > 0);
        return hasMatches ? node : null;
    } else { // node.type === 'folder'
        // Recursively filter children
        const filteredChildren = node.children
            .map(filterTreeForMatches)
            .filter(Boolean) as FileTreeNode[]; // Filter out nulls

        // Keep folder only if it has children after filtering
        if (filteredChildren.length > 0) {
            // Recalculate stats for the filtered folder
            const stats = {
                numMatches: 0,
                numFilesWithMatches: 0
            };

            // Calculate stats by summing up stats from children
            filteredChildren.forEach(child => {
                if (child.type === 'folder' && child.stats) {
                    stats.numMatches += child.stats.numMatches;
                    stats.numFilesWithMatches += child.stats.numFilesWithMatches;
                } else if (child.type === 'file') {
                    const fileMatches = child.results.reduce((sum, r) => sum + (r.matches?.length || 0), 0);
                    stats.numMatches += fileMatches;
                    if (fileMatches > 0) {
                        stats.numFilesWithMatches += 1;
                    }
                }
            });

            // Sort children again after filtering
            filteredChildren.sort((a, b) => {
                if (a.type !== b.type) {
                    return a.type === 'folder' ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            });

            return { ...node, children: filteredChildren, stats };
        } else {
            return null;
        }
    }
}

const leftAnim = keyframes`
  from, 20% {
    left: 0%;
  }
  to {
    left: 100%;
  }
`
const rightAnim = keyframes`
  from {
    right: 100%;
  }
  80%, to {
    right: 0%;
  }
`

// Define props including the vscode api from controller
interface SearchReplaceViewProps {
    vscode: {
        postMessage(message: MessageFromWebview): void
        getState(): { [key: string]: any } | undefined;
        setState(newState: { [key: string]: any }): void;
    }
}

// --- TreeViewNode Component ---
interface TreeViewNodeProps {
    node: FileTreeNode;
    level: number;
    expandedFolders: Set<string>;
    toggleFolderExpansion: (folderPath: string) => void;
    expandedFiles: Set<string>;
    toggleFileExpansion: (filePath: string) => void;
    handleFileClick: (filePath: string) => void;
    handleResultItemClick: (filePath: string, range?: { start: number; end: number }) => void;
    handleReplace: (paths: string[]) => void; // Добавляем обработчик для замены
    currentSearchValues: SearchReplaceViewValues; // Добавляем текущие значения поиска как проп
}

const TreeViewNode: React.FC<TreeViewNodeProps> = React.memo(({
    node,
    level,
    expandedFolders,
    toggleFolderExpansion,
    expandedFiles,
    toggleFileExpansion,
    handleFileClick,
    handleResultItemClick,
    handleReplace,
    currentSearchValues // Получаем значения через пропсы
}) => {
    const indent = level * 15 // Indentation level
    const [isHovered, setIsHovered] = React.useState(false);

    if (node.type === 'folder') {
        const isExpanded = expandedFolders.has(node.relativePath);

        // Calculate all file paths in this folder for the Replace operation
        const getAllFilePathsInFolder = (): string[] => {
            const result: string[] = [];
            const traverse = (node: FileTreeNode) => {
                if (node.type === 'file') {
                    result.push(node.absolutePath);
                } else if (node.type === 'folder') {
                    node.children.forEach(traverse);
                }
            };
            traverse(node);
            return result;
        };

        // Only show stats and Replace button if there are matches
        const hasMatches = node.stats && node.stats.numMatches > 0;

        return (
            <div className={css`margin-bottom: 1px;`}>
                <div
                    className={css`
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        cursor: pointer;
                        padding-left: ${indent + 5}px; /* Indent folder */
                        padding-top: 2px; /* Add vertical padding */
                        padding-bottom: 2px; /* Add vertical padding */
                        &:hover { background-color: var(--vscode-list-hoverBackground); }
                        position: relative;
                    `}
                    onClick={() => toggleFolderExpansion(node.relativePath)}
                    title={`Click to ${isExpanded ? 'collapse' : 'expand'} ${node.name}`}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                >
                    <span className={`codicon codicon-chevron-${isExpanded ? 'down' : 'right'}`} />
                    {getFolderIcon(node.relativePath, isExpanded)}
                    <span>{node.name}</span>
                    <span className={css`flex-grow: 1;`}></span>

                    {/* Stats & Replace button container */}
                    <div className={css`
                        position: relative;
                        display: flex;
                        align-items: center;
                        gap: 4px;
                    `}>
                        {/* Stats */}
                        {hasMatches && node.stats && (
                            <span className={css`
                                color: var(--vscode-descriptionForeground);
                                opacity: ${isHovered && currentSearchValues.replace ? '0.3' : '1'};
                                transition: opacity 0.2s;
                            `}>
                                ({node.stats.numFilesWithMatches} files, {node.stats.numMatches} matches)
                            </span>
                        )}

                        {/* Replace button shown on hover */}
                        {isHovered && hasMatches && currentSearchValues.replace && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation(); // Prevent folder expansion
                                    handleReplace(getAllFilePathsInFolder());
                                }}
                                title={`Replace all matches in ${node.name} folder`}
                                className={css`
                                    background: transparent;
                                    border: none;
                                    padding: 0px 2px;
                                    cursor: pointer;
                                    display: flex;
                                    align-items: center;
                                    color: #bcbbbc;
                                    justify-content: center;
                                    min-width: auto;
                                    border-radius: 3px;
                                    &:hover {
                                        background-color: rgba(128, 128, 128, 0.2);
                                    }
                                `}
                            >
                                <span className="codicon codicon-replace-all" />
                            </button>
                        )}
                    </div>
                </div>
                {isExpanded && (
                    <div>
                        {node.children.map(child => (
                            <TreeViewNode
                                key={child.relativePath}
                                node={child}
                                level={level + 1}
                                expandedFolders={expandedFolders}
                                toggleFolderExpansion={toggleFolderExpansion}
                                expandedFiles={expandedFiles}
                                toggleFileExpansion={toggleFileExpansion}
                                handleFileClick={handleFileClick}
                                handleResultItemClick={handleResultItemClick}
                                handleReplace={handleReplace}
                                currentSearchValues={currentSearchValues}
                            />
                        ))}
                    </div>
                )}
            </div>
        );
    } else { // node.type === 'file'
        const fileResults = node.results;
        const firstResult = fileResults[0];
        const isExpanded = expandedFiles.has(node.relativePath);
        const totalMatches = fileResults.reduce((sum, r) => sum + (r.matches?.length || 0), 0);
        const hasError = fileResults.some(r => r.error);
        const canExpand = totalMatches > 0; // Can only expand file if there are matches

        return (
            <div key={node.relativePath} className={css` margin-bottom: 1px; `}>
                {/* File Entry */}
                <div
                    className={css`
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        cursor: pointer;
                        padding-left: ${indent + 5}px; /* Indent file */
                        padding-top: 2px; /* Add vertical padding */
                        padding-bottom: 2px; /* Add vertical padding */
                        &:hover { background-color: var(--vscode-list-hoverBackground); }
                        position: relative;
                    `}
                    // Click toggles expansion only if there are matches, otherwise opens file
                    onClick={() => canExpand ? toggleFileExpansion(node.relativePath) : handleFileClick(node.absolutePath)}
                    title={canExpand ? `Click to ${isExpanded ? 'collapse' : 'expand'} matches in ${node.name}` : `Click to open ${node.name}`}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                >
                    {/* Chevron only visible if there are matches to expand */}
                    <span className={`codicon codicon-chevron-${isExpanded ? 'down' : 'right'}`}
                        style={{ visibility: canExpand ? 'visible' : 'hidden' }} />
                    {getFileIcon(node.name)}
                    {/* Make filename itself always clickable to open file */}
                    <span className={css`font-weight: bold; flex-grow: 1; cursor: pointer;`}
                        onClick={(e) => { e.stopPropagation(); handleFileClick(node.absolutePath); }}
                        title={`Click to open ${node.name}`}>{node.name}</span>

                    {/* Stats & Replace button container */}
                    <div className={css`
                        position: relative;
                        display: flex;
                        align-items: center;
                        gap: 4px;
                    `}>
                        {/* Match count or error status */}
                        <span className={css`
                            color: var(--vscode-descriptionForeground);
                            opacity: ${isHovered && totalMatches > 0 && currentSearchValues.replace ? '0.3' : '1'};
                            transition: opacity 0.2s;
                        `}>
                            {/* Prioritize match count, then check for error */}
                            {totalMatches > 0
                                ? `${totalMatches} matches`
                                : (hasError ? 'Error' : 'Changed')}
                        </span>

                        {/* Show (Error) indicator only if there are no matches AND there is an error */}
                        {totalMatches === 0 && hasError &&
                            <span className={css`margin-left: 8px; color: var(--vscode-errorForeground);`}>(Error)</span>}

                        {/* Replace button shown on hover */}
                        {isHovered && totalMatches > 0 && currentSearchValues.replace && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleReplace([node.absolutePath]);
                                }}
                                title={`Replace all matches in ${node.name}`}
                                className={css`
                                    background: transparent;
                                    border: none;
                                    padding: 0px 2px;
                                    cursor: pointer;
                                    display: flex;
                                    align-items: center;
                                    color: #bcbbbc;
                                    justify-content: center;
                                    min-width: auto;
                                    border-radius: 3px;
                                    &:hover {
                                        background-color: rgba(128, 128, 128, 0.2);
                                    }
                                `}
                            >
                                <span className="codicon codicon-replace-all" />
                            </button>
                        )}
                    </div>
                </div>
                {/* Expanded Matches */}
                {isExpanded && canExpand && (
                    <div className={css` margin-left: ${indent + 25}px; /* Further indent matches */ padding: 2px 0; `}>
                        {fileResults.map((res, idx) => (
                            res.matches?.map((match, matchIdx) => (
                                <div key={`${idx}-${matchIdx}`}
                                    className={css`
                                        padding: 3px 5px;
                                        padding-top: 2px; /* Add vertical padding */
                                        padding-bottom: 2px; /* Add vertical padding */
                                        cursor: pointer;
                                        font-family: var(--vscode-editor-font-family);
                                        font-size: var(--vscode-editor-font-size);
                                        &:hover { background-color: var(--vscode-list-hoverBackground); }
                                        white-space: nowrap;
                                        overflow: hidden;
                                        text-overflow: ellipsis;
                                        position: relative;
                                    `}
                                    onClick={() => handleResultItemClick(node.absolutePath, { start: match.start, end: match.end })}
                                    title={getLineFromSource(res.source, match.start, match.end)}
                                >
                                    {/* Display highlighted context with replacement preview if replace exists */}
                                    {currentSearchValues.replace && currentSearchValues.replace.length > 0
                                        ? getHighlightedMatchContextWithReplacement(
                                            res.source,
                                            match.start,
                                            match.end,
                                            currentSearchValues.find,
                                            currentSearchValues.replace,
                                            currentSearchValues.searchMode,
                                            currentSearchValues.matchCase,
                                            currentSearchValues.wholeWord
                                        )
                                        : getHighlightedMatchContext(res.source, match.start, match.end)}
                                </div>
                            ))
                        ))}
                        {/* Display error if present (might co-exist with matches in some cases) */}
                        {hasError && totalMatches === 0 && ( // Only show error text if NO matches were displayed
                            <div className={css` color: var(--vscode-errorForeground); padding: 1px 5px; `}>
                                {String(firstResult.error?.message || firstResult.error || 'Error occurred')}
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    }
});
TreeViewNode.displayName = 'TreeViewNode';

// --- Helper function to get all folder paths from a tree ---
function getAllFolderPaths(node: FileTreeNode | null): string[] {
    if (!node || node.type === 'file') {
        return [];
    }
    // For a folder, return its own path plus paths from all children
    const childPaths = node.children.flatMap(getAllFolderPaths);
    // Add current node's path unless it's the root (which has an empty relativePath)
    return node.relativePath ? [node.relativePath, ...childPaths] : childPaths;
}

// --- Helper function to get all file paths from a tree ---
function getAllFilePaths(node: FileTreeNode | null): string[] {
    if (!node) {
        return [];
    }
    if (node.type === 'file') {
        // Return the file's relative path if it's a file node
        return node.relativePath ? [node.relativePath] : [];
    }
    // For a folder, return paths from all children
    return node.children.flatMap(getAllFilePaths);
}

// Функция для получения иконки файла из vscode-material-icons
function getFileIcon(filePath: string): React.ReactNode {
    // Проверяем доступность MaterialIcons
    const materialIcons = (window as any).MaterialIcons;
    if (!materialIcons) {
        // Возвращаем codicon как запасной вариант
        return (
            <span
                className="codicon codicon-file"
                style={{
                    width: '16px',
                    height: '16px',
                    marginRight: '4px',
                    verticalAlign: 'middle'
                }}
                title={path.basename(filePath)}
            />
        );
    }

    try {
        // Используем путь к иконкам из window
        const materialIconsPath = window.materialIconsPath || '/material-icons';
        // Получаем URL иконки с учетом пути к иконкам
        const iconUrl = materialIcons.getIconUrlForFilePath(filePath, materialIconsPath);

        return (
            <img
                src={iconUrl}
                alt={path.basename(filePath)}
                style={{
                    width: '16px',
                    height: '16px',
                    marginRight: '4px',
                    verticalAlign: 'middle'
                }}
                title={path.basename(filePath)}
            />
        );
    } catch (error) {
        // Запасной вариант в случае ошибки
        return (
            <span
                className="codicon codicon-file"
                style={{
                    width: '16px',
                    height: '16px',
                    marginRight: '4px',
                    verticalAlign: 'middle'
                }}
                title={path.basename(filePath)}
            />
        );
    }
}

// Функция для папок (используем codicons, так как material icons не имеет специальных иконок для папок)
function getFolderIcon(folderPath: string, isOpen = false): React.ReactNode {
    return (
        <span
            className={`codicon codicon-folder${isOpen ? '-opened' : ''}`}
            style={{
                width: '16px',
                height: '16px',
                marginRight: '4px',
                verticalAlign: 'middle'
            }}
            title={path.basename(folderPath)}
        />
    );
}

export default function SearchReplaceView({ vscode }: SearchReplaceViewProps): React.ReactElement {
    // --- State Initialization using VS Code Webview API ---
    const initialState = vscode.getState() || {};
    const [values, setValues] = useState<SearchReplaceViewValues>({
        // Default values first
        find: '', replace: '', paused: false, include: '', exclude: '',
        parser: 'babel', prettier: true, babelGeneratorHack: false, preferSimpleReplacement: false,
        searchMode: 'text', matchCase: false, wholeWord: false, searchInResults: false,
        // Then override with loaded state if available
        ...(initialState.values || {}),
    });
    const [status, setStatus] = useState<SearchReplaceViewStatus>(initialState.status || {
        running: false, completed: 0, total: 0, numMatches: 0,
        numFilesThatWillChange: 0, numFilesWithMatches: 0, numFilesWithErrors: 0,
    });
    // Store results keyed by absolute path initially
    const [resultsByFile, setResultsByFile] = useState<Record<string, SerializedTransformResultEvent[]>>(initialState.resultsByFile || {});
    const [workspacePath, setWorkspacePath] = useState<string>(initialState.workspacePath || '');

    // Состояние для отображения результатов замены
    const [replacementResult, setReplacementResult] = useState<{
        totalReplacements: number;
        totalFilesChanged: number;
        show: boolean;
    }>({
        totalReplacements: 0,
        totalFilesChanged: 0,
        show: false
    });

    // --- UI State ---
    const [isReplaceVisible, setIsReplaceVisible] = useState(initialState.isReplaceVisible ?? false);
    const [showSettings, setShowSettings] = useState(initialState.showSettings ?? true);
    const [viewMode, setViewMode] = useState<'list' | 'tree'>(initialState.viewMode || 'list');
    // Store expanded paths (relative paths) as Sets
    const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set(initialState.expandedFiles || []));
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(initialState.expandedFolders || []));
    const [currentSearchMode, setCurrentSearchMode] = useState<SearchReplaceViewValues['searchMode']>(values.searchMode);
    const [matchCase, setMatchCase] = useState(values.matchCase);
    const [wholeWord, setWholeWord] = useState(values.wholeWord);

    // --- Throttling для обновления результатов ---
    const throttleTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const pendingResultsRef = useRef<Record<string, SerializedTransformResultEvent[]>>({});
    const throttleDelayRef = useRef<number>(100); // Начальная задержка 100мс
    const lastUpdateTimeRef = useRef<number>(Date.now());

    // --- Multi-level Nested Search (Find in Found) States ---
    // Initializing searchLevels as an array of search levels, with the base search as the first level
    const [searchLevels, setSearchLevels] = useState<SearchLevel[]>(() => {
        // Check if we have saved search levels in state
        const savedLevels = initialState.searchLevels || [];

        if (savedLevels.length === 0) {
            // Initialize with the base search level only
            return [{
                values,
                resultsByFile,
                matchCase: values.matchCase,
                wholeWord: values.wholeWord,
                searchMode: values.searchMode,
                isReplaceVisible,
                expandedFiles: new Set(),
                expandedFolders: new Set(),
                label: values.find || 'Initial search'
            }];
        }

        // Convert any saved levels from plain objects to proper SearchLevel objects
        return savedLevels.map((level: any) => ({
            ...level,
            // Convert arrays back to Sets for expandedFiles and expandedFolders
            expandedFiles: level.expandedFiles instanceof Set
                ? level.expandedFiles
                : new Set(Array.isArray(level.expandedFiles) ? level.expandedFiles : []),
            expandedFolders: level.expandedFolders instanceof Set
                ? level.expandedFolders
                : new Set(Array.isArray(level.expandedFolders) ? level.expandedFolders : [])
        }));
    });

    // Convenience flag to check if we're in a nested search
    const isInNestedSearch = searchLevels.length > 1;

    // Keep track of whether replace interface is showing in the active nested search
    const [isNestedReplaceVisible, setIsNestedReplaceVisible] = useState(initialState.isNestedReplaceVisible ?? false);

    // Ref для отслеживания последнего поиска, чтобы избежать циклической перерисовки
    const lastSearchRef = useRef('');

    // Добавляем ref для контейнера хлебных крошек
    const breadcrumbsContainerRef = useRef<HTMLDivElement>(null);

    // Debounce ref for postValuesChange
    const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

    // Функция для применения накопленных результатов с адаптивным троттлингом
    const flushPendingResults = useCallback(() => {
        if (Object.keys(pendingResultsRef.current).length === 0) return;

        const now = Date.now();
        const timeSinceLastUpdate = now - lastUpdateTimeRef.current;

        // Адаптивный throttling: увеличиваем задержку, если накопилось много результатов
        const resultCount = Object.keys(pendingResultsRef.current).length;
        if (resultCount > 50) {
            throttleDelayRef.current = 300; // Большая задержка для большого количества результатов
        } else if (resultCount > 20) {
            throttleDelayRef.current = 200; // Средняя задержка
        } else {
            throttleDelayRef.current = 100; // Маленькая задержка для небольшого количества результатов
        }

        setResultsByFile(prev => {
            const newResults = { ...prev };

            // Применяем все накопленные результаты
            Object.entries(pendingResultsRef.current).forEach(([filePath, results]) => {
                newResults[filePath] = [...(newResults[filePath] || []), ...results];
            });

            // Очищаем накопленные результаты
            pendingResultsRef.current = {};
            lastUpdateTimeRef.current = now;

            return newResults;
        });
    }, []);

    // --- Save State Effect ---
    useEffect(() => {
        vscode.setState({
            values, status, resultsByFile, workspacePath, isReplaceVisible,
            showSettings, viewMode,
            // Convert Sets to Arrays for storage
            expandedFiles: Array.from(expandedFiles),
            expandedFolders: Array.from(expandedFolders),
            // Save search levels stack
            searchLevels: searchLevels.map(level => ({
                ...level,
                // Convert Sets to Arrays for storage
                expandedFiles: Array.from(level.expandedFiles instanceof Set ? level.expandedFiles : new Set()),
                expandedFolders: Array.from(level.expandedFolders instanceof Set ? level.expandedFolders : new Set())
            })),
            isNestedReplaceVisible
        });
    }, [
        values, status, resultsByFile, workspacePath, isReplaceVisible,
        showSettings, viewMode, expandedFiles, expandedFolders,
        vscode, searchLevels, isNestedReplaceVisible
    ]);

    // Очистка таймера throttling при размонтировании
    useEffect(() => {
        return () => {
            if (throttleTimeoutRef.current) {
                clearTimeout(throttleTimeoutRef.current);
            }
        };
    }, []);

    // --- Message Listener ---
    useEffect(() => {
        const handleMessage = (event: MessageEvent<MessageToWebview>) => {
            const message = event.data;
            switch (message.type) {
                case 'initialData':
                    setStatus(message.status);
                    setValues(message.values);
                    setWorkspacePath(message.workspacePath); // Store original workspacePath (might be URI)
                    setCurrentSearchMode(message.values.searchMode);
                    setMatchCase(message.values.matchCase);
                    setWholeWord(message.values.wholeWord);
                    setResultsByFile({}); // Clear previous results on init
                    setExpandedFiles(new Set());
                    setExpandedFolders(new Set());
                    pendingResultsRef.current = {}; // Очищаем накопленные результаты
                    break;
                case 'status':
                    setStatus(prev => ({ ...prev, ...message.status }));
                    break;
                case 'values':
                    setValues(prev => ({ ...prev, ...message.values }));
                    // Update local state tied to values if needed
                    if (message.values.searchMode !== undefined) setCurrentSearchMode(message.values.searchMode);
                    if (message.values.matchCase !== undefined) setMatchCase(message.values.matchCase);
                    if (message.values.wholeWord !== undefined) setWholeWord(message.values.wholeWord);
                    break;
                case 'clearResults':
                    setResultsByFile({});
                    setStatus(prev => ({
                        ...prev,
                        numMatches: 0,
                        numFilesWithMatches: 0,
                        numFilesWithErrors: 0,
                        numFilesThatWillChange: 0,
                        completed: 0,
                        total: 0,
                    }));
                    setExpandedFiles(new Set()); // Clear expanded state
                    setExpandedFolders(new Set());
                    setReplacementResult({ totalReplacements: 0, totalFilesChanged: 0, show: false });
                    pendingResultsRef.current = {}; // Очищаем накопленные результаты
                    if (throttleTimeoutRef.current) {
                        clearTimeout(throttleTimeoutRef.current);
                        throttleTimeoutRef.current = null;
                    }
                    break;
                case 'addResult': {
                    const newResult = message.data;

                    // Проверяем, есть ли совпадения
                    const hasMatches = newResult.matches && newResult.matches.length > 0;

                    // Если результат без совпадений и не ошибка, можем пропустить
                    if (!hasMatches && !newResult.error) {
                        return;
                    }

                    // Добавляем результат в накопитель
                    if (!pendingResultsRef.current[newResult.file]) {
                        pendingResultsRef.current[newResult.file] = [];
                    }
                    pendingResultsRef.current[newResult.file].push(newResult);

                    // Если это первый результат, применяем его немедленно
                    if (Object.keys(resultsByFile).length === 0 && Object.keys(pendingResultsRef.current).length === 1) {
                        flushPendingResults();
                    } else {
                        // Иначе используем throttling
                        if (throttleTimeoutRef.current) {
                            clearTimeout(throttleTimeoutRef.current);
                        }
                        throttleTimeoutRef.current = setTimeout(flushPendingResults, throttleDelayRef.current);
                    }
                    break;
                }
                case 'fileUpdated': {
                    // Обновляем source в результатах поиска и во всех searchLevels
                    const { filePath, newSource } = message;

                    // Обновляем source в основных результатах
                    setResultsByFile(prev => {
                        if (!prev[filePath] || prev[filePath].length === 0) {
                            return prev;
                        }

                        // Создаем новый массив результатов с обновленным source
                        const updatedResults = prev[filePath].map(result => ({
                            ...result,
                            source: newSource
                        }));

                        return {
                            ...prev,
                            [filePath]: updatedResults
                        };
                    });

                    // Обновляем source во всех уровнях поиска
                    setSearchLevels(prev => {
                        // Если нет уровней поиска, возвращаем как есть
                        if (prev.length === 0) return prev;

                        // Обновляем каждый уровень поиска
                        return prev.map(level => {
                            // Если в данном уровне нет результатов для этого файла, оставляем как есть
                            if (!level.resultsByFile[filePath] || level.resultsByFile[filePath].length === 0) {
                                return level;
                            }

                            // Обновляем source в результатах для этого файла
                            const updatedResults = level.resultsByFile[filePath].map(result => ({
                                ...result,
                                source: newSource
                            }));

                            // Создаем новый объект уровня с обновленными результатами
                            return {
                                ...level,
                                resultsByFile: {
                                    ...level.resultsByFile,
                                    [filePath]: updatedResults
                                }
                            };
                        });
                    });

                    break;
                }
                case 'replacementComplete': {
                    // При получении сообщения о завершении замены, очищаем дерево и показываем результат
                    setResultsByFile({});
                    setStatus(prev => ({
                        ...prev,
                        numMatches: 0,
                        numFilesWithMatches: 0,
                        completed: 0,
                        total: 0,
                    }));
                    setExpandedFiles(new Set());
                    setExpandedFolders(new Set());
                    pendingResultsRef.current = {}; // Очищаем накопленные результаты

                    // Устанавливаем результаты замены для отображения
                    setReplacementResult({
                        totalReplacements: message.totalReplacements,
                        totalFilesChanged: message.totalFilesChanged,
                        show: true
                    });
                    break;
                }
            }
        };

        window.addEventListener('message', handleMessage);

        // Request initial data on mount
        vscode.postMessage({ type: 'mount' });

        return () => {
            window.removeEventListener('message', handleMessage);
        };
    }, [vscode, flushPendingResults]); // Добавили flushPendingResults в зависимости

    // --- Callbacks ---
    const postValuesChange = useCallback((changed: Partial<SearchReplaceViewValues>) => {
        // Clear existing timeout
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }

        // Если это изменение строки поиска и поиск в данный момент идет - 
        // немедленно отправляем новые значения для остановки текущего поиска
        if (changed.find !== undefined && status.running) {
            setValues(prev => {
                const next = { ...prev, ...changed, isReplacement: false };
                // Немедленно отправляем новые значения
                vscode.postMessage({ type: 'values', values: next });
                return next;
            });
        } else {
            // В противном случае используем debounce как обычно
            debounceTimerRef.current = setTimeout(() => {
                // Immediately update local state for responsiveness
                setValues(prev => {
                    const next = { ...prev, ...changed, isReplacement: false };
                    // Update dependent local state right away
                    if (changed.searchMode !== undefined) setCurrentSearchMode(changed.searchMode);
                    if (changed.matchCase !== undefined) setMatchCase(changed.matchCase);
                    if (changed.wholeWord !== undefined) setWholeWord(changed.wholeWord);
                    // Post the complete updated values
                    vscode.postMessage({ type: 'values', values: next });
                    return next;
                });
            }, 150);
        }
    }, [vscode, status.running]);

    // Cleanup debounce timer on unmount
    useEffect(() => {
        return () => {
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }
        };
    }, []);

    const toggleReplace = useCallback(() => setIsReplaceVisible((v: boolean) => !v), []);
    const toggleSettings = useCallback(() => setShowSettings((v: boolean) => !v), []);

    const handleFindChange = useCallback((e: any) => {
        const newValue = e.target.value;

        // Если поиск выполняется, отменяем его перед запуском нового
        if (status.running) {
            // Отправляем сообщение отмены текущего поиска
            vscode.postMessage({ type: 'stop' });

            // Сбрасываем результаты, оставляя интерфейс чистым для нового поиска
            setResultsByFile({});
            pendingResultsRef.current = {};

            if (throttleTimeoutRef.current) {
                clearTimeout(throttleTimeoutRef.current);
                throttleTimeoutRef.current = null;
            }

            // Обновляем статус чтобы показать, что поиск остановлен
            setStatus(prev => ({
                ...prev,
                running: false,
                numMatches: 0,
                numFilesWithMatches: 0,
                numFilesWithErrors: 0,
                numFilesThatWillChange: 0,
                completed: 0,
                total: 0,
            }));
        }

        postValuesChange({ find: newValue });

        // If search field is cleared (empty), clear the search results
        if (newValue.trim() === '') {
            // Clear results directly in the local state
            setResultsByFile({});
            setStatus(prev => ({
                ...prev,
                numMatches: 0,
                numFilesWithMatches: 0,
                numFilesWithErrors: 0,
                numFilesThatWillChange: 0,
                completed: 0,
                total: 0,
            }));
            setExpandedFiles(new Set()); // Clear expanded state
            setExpandedFolders(new Set());
        }
    }, [postValuesChange, status.running, vscode]);

    const handleReplaceChange = useCallback((e: any) => {
        postValuesChange({ replace: e.target.value });
    }, [postValuesChange]);

    const toggleMatchCase = useCallback(() => {
        const next = !matchCase;
        setMatchCase(next); // Update local state immediately
        postValuesChange({ matchCase: next });
    }, [matchCase, postValuesChange]);

    const toggleWholeWord = useCallback(() => {
        const next = !wholeWord;
        setWholeWord(next); // Update local state immediately
        postValuesChange({ wholeWord: next });
    }, [wholeWord, postValuesChange]);

    const handleModeChange = useCallback((newMode: SearchReplaceViewValues['searchMode']) => {
        const finalMode = (newMode === currentSearchMode && newMode !== 'text') ? 'text' : newMode;
        setCurrentSearchMode(finalMode); // Update local state immediately
        postValuesChange({ searchMode: finalMode });
    }, [currentSearchMode, postValuesChange]);

    const handleRerunAutomaticallyChange = useCallback((e: any) => {
        postValuesChange({ paused: !e.target.checked });
    }, [postValuesChange]);

    const handleIncludeChange = useCallback((e: any) => {
        postValuesChange({ include: e.target.value });
    }, [postValuesChange]);

    const handleExcludeChange = useCallback((e: any) => {
        postValuesChange({ exclude: e.target.value });
    }, [postValuesChange]);

    const handleParserChange = useCallback((e: any) => {
        postValuesChange({ parser: e.target.value });
    }, [postValuesChange]);

    const handlePrettierChange = useCallback((e: any) => {
        postValuesChange({ prettier: e.target.checked });
    }, [postValuesChange]);

    const handleBabelGeneratorHackChange = useCallback((e: any) => {
        postValuesChange({ babelGeneratorHack: e.target.checked });
    }, [postValuesChange]);

    const handlePreferSimpleReplacementChange = useCallback((e: any) => {
        postValuesChange({ preferSimpleReplacement: e.target.checked });
    }, [postValuesChange]);

    const handleReplaceAllClick = useCallback(() => {
        // Собираем списки файлов из текущих результатов
        const currentResultFileList = Object.keys(resultsByFile);

        vscode.postMessage({
            type: 'replace',
            filePaths: currentResultFileList
        });
    }, [vscode, resultsByFile]);

    const handleKeyDown = useEvent((e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.ctrlKey || e.metaKey) { /* Potential future shortcuts */ }
    });

    // Toggle expansion for files (uses relative path)
    const toggleFileExpansion = useCallback((relativePath: string) => {
        setExpandedFiles((prev) => {
            const next = new Set(prev);
            if (next.has(relativePath)) next.delete(relativePath);
            else next.add(relativePath);
            return next;
        });
    }, []);

    // Toggle expansion for folders (uses relative path)
    const toggleFolderExpansion = useCallback((relativePath: string) => {
        setExpandedFolders((prev) => {
            const next = new Set(prev);
            if (next.has(relativePath)) next.delete(relativePath);
            else next.add(relativePath);
            return next;
        });
    }, []);

    // Open file (uses absolute path/URI)
    const handleFileClick = useCallback((absolutePathOrUri: string) => {
        vscode.postMessage({ type: 'openFile', filePath: absolutePathOrUri });
    }, [vscode]);

    // Open file to specific match (uses absolute path/URI)
    const handleResultItemClick = useCallback((absolutePathOrUri: string, range?: { start: number; end: number }) => {
        vscode.postMessage({ type: 'openFile', filePath: absolutePathOrUri, ...(range && { range }) });
    }, [vscode]);

    // --- Memoized Data ---
    // Build the initial, unfiltered tree
    const unfilteredFileTree = useMemo(() => {
        // Determine which results to use based on whether we're in nested search
        const activeResults = isInNestedSearch && searchLevels.length > 0
            ? searchLevels[searchLevels.length - 1].resultsByFile
            : resultsByFile;

        return buildFileTree(activeResults, workspacePath);
    }, [resultsByFile, searchLevels, isInNestedSearch, workspacePath]);

    // Filter the tree for nodes with matches
    const filteredFileTree = useMemo(() => {
        // Filter the children of the root node
        const rootChildren = unfilteredFileTree.children
            .map(filterTreeForMatches)
            .filter(Boolean) as FileTreeNode[];
        // Sort root children again after filtering
        rootChildren.sort((a, b) => {
            if (a.type !== b.type) {
                return a.type === 'folder' ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });
        // Return a new root node with filtered children
        return { ...unfilteredFileTree, children: rootChildren };
    }, [unfilteredFileTree]);

    // Calculate result counts from status
    const {
        running, completed, total, numMatches,
        numFilesWithMatches
    } = status;
    const hasResults = filteredFileTree.children.length > 0;

    // --- Derived State ---
    const isAstxMode = currentSearchMode === 'astx';
    const isTextMode = currentSearchMode === 'text';

    // --- Effect to expand all folders AND FILES in FILTERED Tree View by default ---
    useEffect(() => {
        if (viewMode === 'tree' && filteredFileTree && filteredFileTree.children.length > 0) {
            const allFolderPaths = getAllFolderPaths(filteredFileTree);
            const allFilePaths = getAllFilePaths(filteredFileTree); // <-- Get file paths
            setExpandedFolders(new Set(allFolderPaths));
            setExpandedFiles(new Set(allFilePaths)); // <-- Set expanded files
        }
    }, [filteredFileTree, viewMode]); // Depend on filteredFileTree

    // --- Find in Found Handlers ---
    const handleFindInFound = useCallback(() => {
        // Create a new nested search level with state from current results
        setSearchLevels(prev => {
            // Get current level's state
            const currentLevel = prev[prev.length - 1];

            // Create stats object for the current level before pushing a new one
            const currentLevelWithStats = {
                ...currentLevel,
                stats: {
                    numMatches: status.numMatches,
                    numFilesWithMatches: status.numFilesWithMatches
                }
            };

            // Replace the current level with the one containing stats
            const updatedLevels = [...prev.slice(0, -1), currentLevelWithStats];

            // Add a new empty level for the next search
            return [...updatedLevels, {
                values: {
                    ...values,
                    find: '', // Start with empty search
                    replace: '' // Always start with empty replace
                },
                resultsByFile: {},
                matchCase: values.matchCase,
                wholeWord: values.wholeWord,
                searchMode: values.searchMode,
                isReplaceVisible: false,
                expandedFiles: new Set(),
                expandedFolders: new Set(),
                label: `Search ${updatedLevels.length + 1}`
            }];
        });

        // Clear the replace input field
        setIsNestedReplaceVisible(false);

        postValuesChange({ searchInResults: true });
    }, [values, postValuesChange, status]);

    const handleCloseNestedSearch = useCallback(() => {
        setSearchLevels(prev => {
            // Сохраняем предыдущий уровень для перезапуска поиска
            const targetLevel = prev.length > 1 ? prev[prev.length - 2] : prev[0];
            const isReturningToRoot = prev.length <= 2;

            // Если возвращаемся к корневому поиску
            if (isReturningToRoot) {
                postValuesChange({ searchInResults: false });

                // Перезапускаем поиск для корневого уровня
                if (targetLevel.values.find) {
                    setTimeout(() => {
                        vscode.postMessage({
                            type: 'search',
                            ...targetLevel.values,
                            searchInResults: false
                        });
                    }, 100);
                }

                return [prev[0]]; // Оставляем только первый уровень
            }

            // Иначе возвращаемся на уровень назад, сохраняя searchInResults
            // Перезапускаем поиск для этого уровня
            if (targetLevel.values.find) {
                setTimeout(() => {
                    vscode.postMessage({
                        type: 'search',
                        ...targetLevel.values,
                        searchInResults: true
                    });
                }, 100);
            }

            return prev.slice(0, -1);
        });
    }, [postValuesChange, vscode]);

    const handleNestedFindChange = useCallback((e: any) => {
        // Если поиск выполняется, отменяем его перед запуском нового
        if (status.running) {
            vscode.postMessage({ type: 'stop' });

            // Очищаем накопленные результаты
            pendingResultsRef.current = {};

            if (throttleTimeoutRef.current) {
                clearTimeout(throttleTimeoutRef.current);
                throttleTimeoutRef.current = null;
            }

            // Обновляем статус
            setStatus(prev => ({
                ...prev,
                running: false,
                completed: 0,
                total: 0,
            }));
        }

        setSearchLevels((prev: SearchLevel[]) => [
            ...prev.slice(0, -1),
            {
                ...prev[prev.length - 1],
                values: {
                    ...prev[prev.length - 1].values,
                    find: e.target.value
                }
            }
        ]);
    }, [status.running, vscode]);

    const handleNestedReplaceChange = useCallback((e: any) => {
        setSearchLevels((prev: SearchLevel[]) => [
            ...prev.slice(0, -1),
            {
                ...prev[prev.length - 1],
                values: {
                    ...prev[prev.length - 1].values,
                    replace: e.target.value
                }
            }
        ]);
    }, []);

    const toggleNestedMatchCase = useCallback(() => {
        setSearchLevels((prev: SearchLevel[]) => [
            ...prev.slice(0, -1),
            {
                ...prev[prev.length - 1],
                values: {
                    ...prev[prev.length - 1].values,
                    matchCase: !prev[prev.length - 1].values.matchCase
                }
            }
        ]);
    }, []);

    const toggleNestedWholeWord = useCallback(() => {
        setSearchLevels((prev: SearchLevel[]) => [
            ...prev.slice(0, -1),
            {
                ...prev[prev.length - 1],
                values: {
                    ...prev[prev.length - 1].values,
                    wholeWord: !prev[prev.length - 1].values.wholeWord
                }
            }
        ]);
    }, []);

    const handleNestedModeChange = useCallback((newMode: SearchReplaceViewValues['searchMode']) => {
        setSearchLevels((prev: SearchLevel[]) => [
            ...prev.slice(0, -1),
            {
                ...prev[prev.length - 1],
                values: {
                    ...prev[prev.length - 1].values,
                    searchMode: (newMode === prev[prev.length - 1].values.searchMode && newMode !== 'text') ? 'text' : newMode
                }
            }
        ]);
    }, []);

    const toggleNestedReplace = useCallback(() => {
        setIsNestedReplaceVisible((prev: boolean) => !prev);
    }, []);

    // Исправляем useEffect для вложенного поиска
    useEffect(() => {
        // Check if we're in nested search and we have search levels with a valid search query
        if (isInNestedSearch &&
            searchLevels.length > 0 &&
            searchLevels[searchLevels.length - 1]?.values?.find) {

            const currentLevel = searchLevels[searchLevels.length - 1];
            const searchQuery = currentLevel.values.find;
            const currentSearchValue = `${searchQuery}_${currentLevel.values.matchCase}_${currentLevel.values.wholeWord}_${currentLevel.values.searchMode}`;

            // Skip if this exact search was already performed
            if (lastSearchRef.current === currentSearchValue && Object.keys(currentLevel.resultsByFile).length > 0) {
                return;
            }

            // Update the last search reference
            lastSearchRef.current = currentSearchValue;

            // Create search regex based on current settings
            const pattern = currentLevel.values.searchMode === 'regex'
                ? searchQuery
                : escapeRegExp(searchQuery);

            const modifiedPattern = currentLevel.values.wholeWord && currentLevel.values.searchMode === 'text'
                ? `\\b${pattern}\\b`
                : pattern;

            const flags = currentLevel.values.matchCase ? 'g' : 'gi';
            const regex = new RegExp(modifiedPattern, flags);

            // Search through results from previous level
            const newResults: Record<string, SerializedTransformResultEvent[]> = {};

            // Get results from the previous level (or base results if only one level back)
            const sourceResults = searchLevels.length > 2
                ? searchLevels[searchLevels.length - 2].resultsByFile
                : resultsByFile;

            Object.entries(sourceResults).forEach(([filePath, fileResults]) => {
                const fileMatches: SerializedTransformResultEvent[] = [];

                fileResults.forEach(result => {
                    if (result.source) {
                        const matches: Array<{ start: number; end: number }> = [];
                        let match;

                        // Reset lastIndex to start search from beginning of string
                        regex.lastIndex = 0;

                        while ((match = regex.exec(result.source)) !== null) {
                            matches.push({
                                start: match.index,
                                end: match.index + match[0].length
                            });

                            // Avoid infinite loop for zero-length matches
                            if (match.index === regex.lastIndex) {
                                regex.lastIndex++;
                            }
                        }

                        if (matches.length > 0) {
                            fileMatches.push({
                                ...result,
                                matches
                            });
                        }
                    }
                });

                if (fileMatches.length > 0) {
                    newResults[filePath] = fileMatches;
                }
            });

            // Use a stable way to update searchLevels to avoid infinite loops
            setSearchLevels((prev: SearchLevel[]) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                    ...updated[updated.length - 1],
                    resultsByFile: newResults
                };
                return updated;
            });
        }
    }, [isInNestedSearch, searchLevels[searchLevels.length - 1]?.values?.find,
        searchLevels[searchLevels.length - 1]?.values?.matchCase,
        searchLevels[searchLevels.length - 1]?.values?.wholeWord,
        searchLevels[searchLevels.length - 1]?.values?.searchMode,
        resultsByFile]);

    const handleNestedReplaceAllClick = useCallback(() => {
        // First, update the main values with nested values temporarily
        const originalValues = { ...values };
        const currentLevel = searchLevels[searchLevels.length - 1];

        // Собираем списки файлов из вложенного поиска
        const nestedResultFileList = Object.keys(currentLevel.resultsByFile);

        // Set the main search values to match the nested search values
        vscode.postMessage({
            type: 'values',
            values: {
                ...values,
                isReplacement: true,
                find: currentLevel.values.find,
                replace: currentLevel.values.replace,
                matchCase: currentLevel.values.matchCase,
                wholeWord: currentLevel.values.wholeWord,
                searchMode: currentLevel.values.searchMode
            }
        });

        // Then trigger replace with file list
        vscode.postMessage({
            type: 'replace',
            filePaths: nestedResultFileList
        });

        // Listen for replace completion
        const handleReplaceDone = (event: MessageEvent<MessageToWebview>) => {
            const message = event.data;
            if (message.type === 'replaceDone' || message.type === 'stop') {
                // Restore original values
                vscode.postMessage({
                    type: 'values',
                    values: originalValues
                });

                // Close nested search mode after replace is done
                setSearchLevels((prev: SearchLevel[]) => prev.slice(0, -1));

                // Clean up event listener
                window.removeEventListener('message', handleReplaceDone);
            }
        };

        // Add event listener for replace completion
        window.addEventListener('message', handleReplaceDone);

    }, [vscode, values, searchLevels]);

    // Effect to update the base search level when values change
    useEffect(() => {
        if (!isInNestedSearch && searchLevels.length > 0) {
            // Update only the base search level (index 0) with the current values
            setSearchLevels(prev => [
                {
                    ...prev[0],
                    values,
                    matchCase: values.matchCase,
                    wholeWord: values.wholeWord,
                    searchMode: values.searchMode,
                    isReplaceVisible,
                    label: values.find || 'Initial search'
                },
                ...prev.slice(1)
            ]);
        }
    }, [values, isReplaceVisible, isInNestedSearch]);

    // Добавляем новый эффект для автоматической прокрутки
    useEffect(() => {
        // Прокрутка к последнему активному поисковому уровню
        if (breadcrumbsContainerRef.current && searchLevels.length > 1) {
            // Установка максимального значения scrollLeft для прокрутки вправо
            breadcrumbsContainerRef.current.scrollLeft = breadcrumbsContainerRef.current.scrollWidth;
        }
    }, [searchLevels.length]); // Зависимость только от количества уровней поиска

    // Хранение текущих значений поиска в глобальной переменной для доступа из разных компонентов
    useEffect(() => {
        window.activeSearchReplaceValues = values;
    }, [values]);

    // Функция-обработчик для замены в выбранных файлах
    const handleReplaceSelectedFiles = (filePaths: string[]) => {
        // Проверяем, что у нас есть что заменять
        if (!values.find || !values.replace || filePaths.length === 0) {
            return;
        }

        // Если поиск в режиме замены, отправляем сообщение с путями файлов
        vscode.postMessage({
            type: 'replace',
            filePaths
        });
    };

    return (
        <div
            onKeyDown={handleKeyDown}
            className={css`
            display: flex;
            flex-direction: column;
            height: 100vh; /* Make main container fill viewport height */
            padding: 5px; /* Add some padding around the whole view */
            box-sizing: border-box; /* Include padding in height calculation */
          `}
        >
            {/* Show Find in Found Search Interface when activated */}
            {isInNestedSearch && (
                <div className={css`
              background-color: var(--vscode-editor-background);
              padding: 5px;
              border-radius: 3px;
              margin-bottom: 10px;
              position: relative;
              z-index: 10;
              box-shadow: 0 2px 5px rgba(0, 0, 0, 0.3);
            `}>
                    {/* Navigation Breadcrumbs for Nested Searches */}
                    <div className={css`
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 8px;
              `}>
                        {/* Search level breadcrumbs */}
                        <div
                            ref={breadcrumbsContainerRef}
                            className={css`
                    display: flex;
                    align-items: center;
                    overflow-x: auto;
                    flex-grow: 1;
                    padding: 3px;
                    gap: 4px;
                  `}
                        >
                            {/* Base search level - Show truncated search query instead of "Root search" */}
                            <span
                                className={css`
                      padding: 2px 6px;
                      border-radius: 3px;
                      font-size: 12px;
                      cursor: pointer;
                      color: var(--vscode-descriptionForeground);
                      &:hover { text-decoration: underline; }
                    `}
                                onClick={() => {
                                    // Jump back to root search
                                    setSearchLevels((prev: SearchLevel[]) => [prev[0]]);
                                    postValuesChange({ searchInResults: false });
                                    // Trigger a new search to update results
                                    if (values.find) {
                                        // Небольшая задержка, чтобы интерфейс успел обновиться
                                        setTimeout(() => {
                                            vscode.postMessage({
                                                type: 'search',
                                                ...values,
                                                searchInResults: false
                                            });
                                        }, 100);
                                    }
                                }}
                            >
                                {/* Показываем текст первого поискового запроса вместо "Initial" */}
                                {searchLevels[0].values.find
                                    ? (searchLevels[0].values.find.length > 10
                                        ? `${searchLevels[0].values.find.substring(0, 10)}...`
                                        : searchLevels[0].values.find)
                                    : values.find || 'Root'}
                            </span>

                            {/* Show each search level as a breadcrumb */}
                            {searchLevels.slice(1).map((level, index) => (
                                <React.Fragment key={index + 1}>
                                    {/* Иконка стрелки вместо символа > */}
                                    <span className="codicon codicon-arrow-right" style={{ color: 'var(--vscode-descriptionForeground)' }}></span>
                                    <span
                                        className={css`
                          padding: 2px 6px;
                          border-radius: 3px;
                          font-size: 12px;
                          cursor: pointer;
                          ${index === searchLevels.length - 2 ? 'font-weight: bold;' : 'color: var(--vscode-descriptionForeground);'}
                          ${index === searchLevels.length - 2 ? 'background-color: var(--vscode-badge-background);' : ''}
                          &:hover { text-decoration: underline; }
                        `}
                                        onClick={() => {
                                            // Jump to this specific search level
                                            if (index < searchLevels.length - 2) {
                                                const targetLevel = searchLevels[index + 1];
                                                setSearchLevels((prev: SearchLevel[]) => prev.slice(0, index + 2));
                                                postValuesChange({ searchInResults: true });

                                                // Trigger a new search to update results for this level
                                                if (targetLevel.values.find) {
                                                    setTimeout(() => {
                                                        vscode.postMessage({
                                                            type: 'search',
                                                            ...targetLevel.values,
                                                            searchInResults: true
                                                        });
                                                    }, 100);
                                                }
                                            }
                                        }}
                                    >
                                        {/* Truncate search query if longer than 10 chars */}
                                        {level.values.find
                                            ? (level.values.find.length > 10
                                                ? `${level.values.find.substring(0, 10)}...`
                                                : level.values.find)
                                            : `Search ${index + 1}`}
                                        {level.stats && (
                                            <span className={css`
                            margin-left: 4px;
                            font-size: 10px;
                            opacity: 0.8;
                          `}>
                                                ({level.stats.numFilesWithMatches} files, {level.stats.numMatches} matches)
                                            </span>
                                        )}
                                    </span>
                                </React.Fragment>
                            ))}
                        </div>

                        {/* Close button for the current nested search */}
                        <VSCodeButton
                            appearance="icon"
                            onClick={handleCloseNestedSearch}
                            title="Close Find in Found"
                        >
                            <span className="codicon codicon-close"></span>
                        </VSCodeButton>
                    </div>

                    {/* Nested Search/Replace Interface */}
                    <div className={css` display: flex; align-items: flex-start; gap: 4px; `}>
                        {/* Toggle Replace Button */}
                        <VSCodeButton appearance="icon" onClick={toggleNestedReplace} title="Toggle Replace" className={css` margin-top: 5px; flex-shrink: 0; `}>
                            <span className={`codicon codicon-chevron-${isNestedReplaceVisible ? 'down' : 'right'}`}></span>
                        </VSCodeButton>

                        {/* Search/Replace Text Areas & Options */}
                        <div className={css` flex-grow: 1; display: flex; flex-direction: column; gap: 4px; `}>
                            {/* --- Search Input Row with Options --- */}
                            <div className={css` display: flex; align-items: center; gap: 2px; `}>
                                <VSCodeTextArea
                                    placeholder="search"
                                    aria-label="Nested Search Pattern"
                                    name="nestedSearch"
                                    rows={1}
                                    value={searchLevels[searchLevels.length - 1].values.find}
                                    onInput={handleNestedFindChange}
                                    className={css` flex-grow: 1; `} // Make text area grow
                                />
                                {/* Search Options Buttons */}
                                <VSCodeButton
                                    appearance={searchLevels[searchLevels.length - 1].values.matchCase ? "secondary" : "icon"}
                                    onClick={toggleNestedMatchCase}
                                    title="Match Case (Aa)"
                                >
                                    <span className="codicon codicon-case-sensitive" />
                                </VSCodeButton>
                                <VSCodeButton
                                    appearance={searchLevels[searchLevels.length - 1].values.wholeWord ? "secondary" : "icon"}
                                    onClick={toggleNestedWholeWord}
                                    title="Match Whole Word (Ab)"
                                >
                                    <span className="codicon codicon-whole-word" />
                                </VSCodeButton>
                                <VSCodeButton
                                    appearance={searchLevels[searchLevels.length - 1].values.searchMode === 'regex' ? "secondary" : "icon"}
                                    onClick={() => handleNestedModeChange('regex')}
                                    title="Use Regular Expression (.*)"
                                >
                                    <span className="codicon codicon-regex" />
                                </VSCodeButton>
                                <VSCodeButton
                                    appearance={searchLevels[searchLevels.length - 1].values.searchMode === 'astx' ? "secondary" : "icon"}
                                    onClick={() => handleNestedModeChange('astx')}
                                    title="Use AST Search (<*>)"
                                >
                                    <span className="codicon codicon-symbol-struct" />
                                </VSCodeButton>
                            </div>

                            {/* --- Nested Replace Input Row --- */}
                            {isNestedReplaceVisible && (
                                <div className={css` display: flex; align-items: center; gap: 2px; `}>
                                    <VSCodeTextArea
                                        placeholder="replace"
                                        aria-label="Nested Replace Pattern"
                                        name="nestedReplace"
                                        rows={1}
                                        value={searchLevels[searchLevels.length - 1].values.replace}
                                        onInput={handleNestedReplaceChange}
                                        className={css` flex-grow: 1; `} // Make textarea grow
                                    />
                                    {/* Кнопка Replace All для вложенного поиска */}
                                    <VSCodeButton
                                        appearance="icon"
                                        onClick={handleNestedReplaceAllClick}
                                        disabled={!Object.keys(searchLevels[searchLevels.length - 1].resultsByFile).length}
                                        title={!Object.keys(searchLevels[searchLevels.length - 1].resultsByFile).length ? "Replace All" : `Replace ${searchLevels[searchLevels.length - 1].values.replace} in matched files`}
                                        className={css` flex-shrink: 0; `} // Prevent shrinking
                                    >
                                        <span className="codicon codicon-replace-all" />
                                    </VSCodeButton>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Button to add another level of nested search */}
                    {Object.keys(searchLevels[searchLevels.length - 1].resultsByFile).length > 0 && (
                        <div className={css`
                    display: flex;
                    justify-content: flex-end;
                    margin-top: 8px;
                    margin-bottom: 8px;
                `}>
                            <VSCodeButton
                                appearance="icon"
                                onClick={handleFindInFound}
                                title="Search within these results"
                            >
                                <span className="codicon codicon-filter-filled"></span>
                            </VSCodeButton>

                            {/* View Mode Toggle Buttons for nested search */}
                            <div className={css` display: flex; align-items: center; gap: 4px; `}>
                                {/* Show only one button based on current view mode */}
                                {viewMode === 'list' ? (
                                    <VSCodeButton
                                        appearance="secondary"
                                        onClick={() => setViewMode('tree')}
                                        title="View as tree"
                                    >
                                        <span className="codicon codicon-list-tree"></span>
                                    </VSCodeButton>
                                ) : (
                                    <VSCodeButton
                                        appearance="secondary"
                                        onClick={() => setViewMode('list')}
                                        title="View as list"
                                    >
                                        <span className="codicon codicon-list-flat"></span>
                                    </VSCodeButton>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Original Search Interface */}
            <div className={css`
            ${isInNestedSearch ? 'display: none;' : ''} /* Hide completely rather than making opaque */
          `}>
                {/* --- Search/Replace/Actions Row --- */}
                <div className={css` display: flex; align-items: flex-start; gap: 4px; `}>
                    {/* Toggle Replace Button */}
                    <VSCodeButton appearance="icon" onClick={toggleReplace} title="Toggle Replace" className={css` margin-top: 5px; flex-shrink: 0; `}>
                        <span className={`codicon codicon-chevron-${isReplaceVisible ? 'down' : 'right'}`}></span>
                    </VSCodeButton>
                    {/* Search/Replace Text Areas & Options */}
                    <div className={css` flex-grow: 1; display: flex; flex-direction: column; gap: 4px; `}>
                        {/* --- Search Input Row with Options --- */}
                        <div className={css` display: flex; align-items: center; gap: 2px; `}>
                            <VSCodeTextArea
                                placeholder="search"
                                aria-label="Search Pattern"
                                name="search"
                                rows={1}
                                value={values.find}
                                onInput={handleFindChange}
                                className={css` flex-grow: 1; `} // Make text area grow
                            />
                            {/* Search Options Buttons */}
                            <VSCodeButton
                                appearance={matchCase ? "secondary" : "icon"}
                                onClick={toggleMatchCase}
                                title="Match Case (Aa)"
                                disabled={!isTextMode} // Only enable in text mode
                            >
                                <span className="codicon codicon-case-sensitive" />
                            </VSCodeButton>
                            <VSCodeButton
                                appearance={wholeWord ? "secondary" : "icon"}
                                onClick={toggleWholeWord}
                                title="Match Whole Word (Ab)"
                                disabled={!isTextMode} // Only enable in text mode
                            >
                                <span className="codicon codicon-whole-word" />
                            </VSCodeButton>
                            <VSCodeButton
                                appearance={currentSearchMode === 'regex' ? "secondary" : "icon"}
                                onClick={() => handleModeChange('regex')}
                                title="Use Regular Expression (.*)"
                            >
                                <span className="codicon codicon-regex" />
                            </VSCodeButton>
                            <VSCodeButton
                                appearance={isAstxMode ? "secondary" : "icon"}
                                onClick={() => handleModeChange('astx')}
                                title="Use AST Search (<*>)"
                            >
                                <span className="codicon codicon-symbol-struct" />{/* Or another suitable icon */}
                            </VSCodeButton>
                        </div>
                        {/* --- Replace Input Row --- */}
                        {isReplaceVisible && (
                            <div className={css` display: flex; align-items: center; gap: 2px; `}>
                                <VSCodeTextArea
                                    placeholder={isAstxMode ? "replace" : "replace"} // Adjusted placeholder
                                    aria-label="Replace Pattern"
                                    name="replace"
                                    rows={1}
                                    value={values.replace}
                                    onInput={handleReplaceChange}
                                    className={css` flex-grow: 1; `} // Make textarea grow
                                />
                                {/* Moved Replace All button here */}
                                <VSCodeButton
                                    appearance="icon"
                                    onClick={handleReplaceAllClick}
                                    disabled={!hasResults || running} // Simplified disabled logic (assuming replace is visible)
                                    title={!hasResults || running ? "Replace All" : `Replace ${values.replace} in ${numFilesWithMatches} files`}
                                    className={css` flex-shrink: 0; `} // Prevent shrinking
                                >
                                    <span className="codicon codicon-replace-all" />
                                </VSCodeButton>
                            </div>
                        )}
                    </div>
                </div>

                {/* --- Settings Toggle & Result Summary/View Mode --- */}
                <div className={css` display: flex; justify-content: space-between; gap: 8px; align-items: center; padding: 0 5px; `}>
                    <div className={css` display: flex; align-items: center; gap: 4px; `}>
                        <VSCodeButton appearance="icon" onClick={toggleSettings} title="Toggle Search Details">
                            <span className={`codicon codicon-ellipsis ${showSettings ? 'codicon-close' : ''}`} />
                        </VSCodeButton>
                        {hasResults && (
                            <span className={css` color: var(--vscode-descriptionForeground); `}>
                                {`${numMatches} results in ${numFilesWithMatches} files`}
                            </span>
                        )}
                    </div>
                    {/* View Mode Toggle Buttons + Find in Found Button */}
                    {hasResults && (
                        <div className={css` display: flex; align-items: center; gap: 4px; `}>
                            {/* Find in Found Button */}
                            <VSCodeButton
                                appearance="icon"
                                onClick={handleFindInFound}
                                title="Search within these results"
                                className={css` margin-right: 5px; `} /* Add margin to separate from view toggles */
                            >
                                <span className="codicon codicon-filter-filled"></span>
                            </VSCodeButton>

                            {/* View Mode Toggle Buttons for nested search */}
                            <div className={css` display: flex; align-items: center; gap: 4px; `}>
                                {/* Show only one button based on current view mode */}
                                {viewMode === 'list' ? (
                                    <VSCodeButton
                                        appearance="icon"
                                        onClick={() => setViewMode('tree')}
                                        title="View as tree"
                                    >
                                        <span className="codicon codicon-list-tree"></span>
                                    </VSCodeButton>
                                ) : (
                                    <VSCodeButton
                                        appearance="icon"
                                        onClick={() => setViewMode('list')}
                                        title="View as list"
                                    >
                                        <span className="codicon codicon-list-flat"></span>
                                    </VSCodeButton>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {!isInNestedSearch && showSettings && (
                    <div className={css` display: flex; flex-direction: column; gap: 5px; padding: 5px; border-top: 1px solid var(--vscode-divider-background); margin-top: 4px;`}>
                        <VSCodeTextField name="filesToInclude" value={values.include || ''} onInput={handleIncludeChange}> files to include </VSCodeTextField>
                        <VSCodeTextField name="filesToExclude" value={values.exclude || ''} onInput={handleExcludeChange}> files to exclude </VSCodeTextField>
                        <VSCodeCheckbox
                            checked={!values.paused}
                            onChange={handleRerunAutomaticallyChange}
                        >
                            Rerun Automatically
                        </VSCodeCheckbox>

                        {/* --- CONDITIONAL Parser and Other Advanced Settings --- */}
                        {isAstxMode && (
                            <>
                                <VSCodeDivider />
                                <p>Parser:</p>
                                <VSCodeDropdown
                                    position="below"
                                    value={values.parser || 'babel'} // Provide default
                                    onChange={handleParserChange}
                                >
                                    <VSCodeOption value="babel">babel</VSCodeOption>
                                    <VSCodeOption value="babel/auto">babel/auto</VSCodeOption>
                                    <VSCodeOption value="recast/babel">recast/babel</VSCodeOption>
                                    <VSCodeOption value="recast/babel/auto">recast/babel/auto</VSCodeOption>
                                </VSCodeDropdown>

                                <VSCodeCheckbox checked={values.prettier} onChange={handlePrettierChange}>
                                    Prettier
                                </VSCodeCheckbox>
                                <VSCodeCheckbox
                                    checked={values.babelGeneratorHack}
                                    onChange={handleBabelGeneratorHackChange}
                                >
                                    Babel Generator Hack
                                </VSCodeCheckbox>
                                <VSCodeCheckbox
                                    checked={values.preferSimpleReplacement}
                                    onChange={handlePreferSimpleReplacementChange}
                                >
                                    Prefer Simple Replacement
                                </VSCodeCheckbox>
                            </>
                        )}
                    </div>
                )}
            </div>

            {/* --- Results Section --- */}
            <div className={css`
                ${running ? 'position: relative;' : ''}
                padding: 4px;
                flex-grow: 1;
                overflow: auto;
            `}>
                {/* Progress Indicator (during run) */}
                {running && (
                    <div className={css`
                        position: absolute;
                        top: 0px;
                        left: 0px;
                        width: 100%;
                        height: 2px;
                        background-color: var(--vscode-progressBar-background);
                        overflow: hidden;
                        z-index: 2;
                    `}>
                        <div className={css`
                            position: absolute;
                            width: 100%;
                            height: 2px;
                            background-color: var(--vscode-progressBar-foreground);
                            animation: ${leftAnim} 2s infinite ease-in-out,
                                      ${rightAnim} 2s infinite ease-in-out;
                        `} />
                    </div>
                )}

                {/* Display replacement results */}
                {replacementResult.show && (
                    <div className={css`
                        display: flex;
                        flex-direction: column;
                        justify-content: center;
                        align-items: center;
                        height: 100%;
                        text-align: center;
                        padding: 20px;
                    `}>
                        <div className={css`
                            font-size: 1.2em;
                            margin-bottom: 10px;
                            color: var(--vscode-gitDecoration-addedResourceForeground);
                        `}>
                            <span className="codicon codicon-check-all" style={{ marginRight: '8px' }}></span>
                            Replacement completed successfully
                        </div>
                        <div className={css`
                            margin-bottom: 5px;
                            color: var(--vscode-foreground);
                        `}>
                            Replaced <strong>{replacementResult.totalReplacements}</strong> matches
                            in <strong>{replacementResult.totalFilesChanged}</strong> files
                        </div>
                        <VSCodeButton
                            appearance="secondary"
                            onClick={() => {
                                // Reset replacement results state
                                setReplacementResult({
                                    totalReplacements: 0,
                                    totalFilesChanged: 0,
                                    show: false
                                });
                                // Launch new search
                                if (values.find) {
                                    vscode.postMessage({
                                        type: 'search',
                                        ...values
                                    });
                                }
                            }}
                        >
                            New search
                        </VSCodeButton>
                    </div>
                )}

                {/* Show either nested results or regular results based on state */}
                {!replacementResult.show && isInNestedSearch ? (
                    // Nested search results view
                    Object.keys(searchLevels[searchLevels.length - 1].resultsByFile).length > 0 ? (
                        <div>
                            {viewMode === 'tree' ? (
                                // Tree view for nested results
                                <div>
                                    {filteredFileTree.children.length > 0 ? (
                                        filteredFileTree.children.map(node => (
                                            <TreeViewNode
                                                key={node.relativePath}
                                                node={node}
                                                level={0}
                                                expandedFolders={expandedFolders}
                                                toggleFolderExpansion={toggleFolderExpansion}
                                                expandedFiles={expandedFiles}
                                                toggleFileExpansion={toggleFileExpansion}
                                                handleFileClick={handleFileClick}
                                                handleResultItemClick={handleResultItemClick}
                                                handleReplace={handleReplaceSelectedFiles}
                                                currentSearchValues={searchLevels[searchLevels.length - 1].values}
                                            />
                                        ))
                                    ) : (
                                        <div className={css`
                                            padding: 10px;
                                            color: var(--vscode-descriptionForeground);
                                            text-align: center;
                                        `}>
                                            No matches found in tree view.
                                        </div>
                                    )}
                                </div>
                            ) : (
                                // List view for nested results
                                <div>
                                    {/* Group results by file */}
                                    {Object.entries(searchLevels[searchLevels.length - 1].resultsByFile).map(([filePath, results]) => {
                                        const displayPath = workspacePath
                                            ? path.relative(uriToPath(workspacePath), uriToPath(filePath))
                                            : uriToPath(filePath);

                                        const totalMatches = results.reduce((sum, r) => sum + (r.matches?.length || 0), 0);
                                        if (totalMatches === 0) return null; // Don't show files without matches

                                        const filePathKey = filePath; // Use original path as key
                                        const isExpanded = expandedFiles.has(displayPath);

                                        return (
                                            <div key={filePathKey} className={css`
                                                margin-bottom: 8px;
                                                border-radius: 3px;
                                                overflow: hidden;
                                            `}>
                                                {/* File Header */}
                                                <div
                                                    className={css`
                                                        display: flex;
                                                        align-items: center;
                                                        background-color: var(--vscode-list-dropBackground);
                                                        padding: 4px 8px;
                                                        gap: 8px;
                                                        cursor: pointer;
                                                        &:hover { background-color: var(--vscode-list-hoverBackground); }
                                                    `}
                                                    onClick={() => toggleFileExpansion(displayPath)}
                                                >
                                                    <span className={`codicon codicon-chevron-${isExpanded ? 'down' : 'right'}`} />
                                                    <span
                                                        className={css`font-weight: bold; cursor: pointer;`}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleFileClick(filePath);
                                                        }}
                                                        title={`Click to open ${displayPath}`}
                                                    >
                                                        {displayPath}
                                                    </span>
                                                    <span className={css`
                                                        margin-left: auto;
                                                        color: var(--vscode-descriptionForeground);
                                                    `}>
                                                        {totalMatches} matches
                                                    </span>
                                                </div>

                                                {/* Expanded Matches */}
                                                {isExpanded && (
                                                    <div className={css`
                                                        padding: 4px 0;
                                                        background-color: var(--vscode-editor-background);
                                                    `}>
                                                        {results.map((result, resultIdx) =>
                                                            result.matches?.map((match, matchIdx) => (
                                                                <div
                                                                    key={`${resultIdx}-${matchIdx}`}
                                                                    className={css`
                                                                        padding: 2px 24px;
                                                                        font-family: var(--vscode-editor-font-family);
                                                                        font-size: var(--vscode-editor-font-size);
                                                                        cursor: pointer;
                                                                        &:hover { background-color: var(--vscode-list-hoverBackground); }
                                                                    `}
                                                                    onClick={() => handleResultItemClick(filePath, match)}
                                                                    title={getLineFromSource(result.source, match.start, match.end)}
                                                                    onMouseEnter={(e) => {
                                                                        // Set hovering state for the match item
                                                                        (e.currentTarget as HTMLElement).dataset.hovered = 'true';
                                                                    }}
                                                                    onMouseLeave={(e) => {
                                                                        // Clear hovering state
                                                                        delete (e.currentTarget as HTMLElement).dataset.hovered;
                                                                    }}
                                                                >
                                                                    {searchLevels[searchLevels.length - 1].values.replace && searchLevels[searchLevels.length - 1].values.replace.length > 0
                                                                        ? getHighlightedMatchContextWithReplacement(
                                                                            result.source,
                                                                            match.start,
                                                                            match.end,
                                                                            searchLevels[searchLevels.length - 1].values.find,
                                                                            searchLevels[searchLevels.length - 1].values.replace,
                                                                            searchLevels[searchLevels.length - 1].values.searchMode,
                                                                            searchLevels[searchLevels.length - 1].values.matchCase,
                                                                            searchLevels[searchLevels.length - 1].values.wholeWord
                                                                        )
                                                                        : getHighlightedMatchContext(result.source, match.start, match.end)}

                                                                    {/* Replace button for individual match */}
                                                                    {searchLevels[searchLevels.length - 1].values.replace && (
                                                                        <div
                                                                            className={css`
                                                                                position: absolute;
                                                                                right: 5px;
                                                                                top: 50%;
                                                                                transform: translateY(-50%);
                                                                                opacity: 0;
                                                                                transition: opacity 0.2s;
                                                                                [data-hovered="true"] & {
                                                                                    opacity: 1;
                                                                                }
                                                                            `}
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                // For now, just replace all matches in this file
                                                                                // In the future we could implement single match replacement
                                                                                handleReplace([filePath]);
                                                                            }}
                                                                        >
                                                                            <button
                                                                                className={css`
                                                                                    background-color: var(--vscode-button-background);
                                                                                    color: var(--vscode-button-foreground);
                                                                                    border: none;
                                                                                    border-radius: 2px;
                                                                                    cursor: pointer;
                                                                                    padding: 2px 6px;
                                                                                    font-size: 12px;
                                                                                    &:hover {
                                                                                        background-color: var(--vscode-button-hoverBackground);
                                                                                    }
                                                                                `}
                                                                                title="Replace this match"
                                                                            >
                                                                                <span className="codicon codicon-replace-all" />
                                                                            </button>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            ))
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    ) : searchLevels[searchLevels.length - 1].values.find ? (
                        <div className={css`
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            height: 100px;
                            color: var(--vscode-descriptionForeground);
                        `}>
                            No matches found for "{searchLevels[searchLevels.length - 1].values.find}"
                        </div>
                    ) : (
                        <div className={css`
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            height: 100px;
                            color: var(--vscode-descriptionForeground);
                        `}>
                            Enter a search term to find within the results
                        </div>
                    )
                ) : !replacementResult.show ? (
                    // Original results view
                    <>
                        {/* Regular Results View */}
                        {viewMode === 'tree' ? (
                            // Tree view of results
                            <div>
                                {filteredFileTree.children.length > 0 ? (
                                    filteredFileTree.children.map(node => (
                                        <TreeViewNode
                                            key={node.relativePath}
                                            node={node}
                                            level={0}
                                            expandedFolders={expandedFolders}
                                            toggleFolderExpansion={toggleFolderExpansion}
                                            expandedFiles={expandedFiles}
                                            toggleFileExpansion={toggleFileExpansion}
                                            handleFileClick={handleFileClick}
                                            handleResultItemClick={handleResultItemClick}
                                            handleReplace={handleReplaceSelectedFiles}
                                            currentSearchValues={values}
                                        />
                                    ))
                                ) : (
                                    <div className={css`
                                        padding: 10px;
                                        color: var(--vscode-descriptionForeground);
                                        text-align: center;
                                        `}>
                                        No matches found. Try adjusting your search terms or filters.
                                    </div>
                                )}
                            </div>
                        ) : (
                            // List view of results
                            <div>
                                {Object.entries(resultsByFile).length > 0 ? (
                                    Object.entries(resultsByFile).map(([filePath, results]) => {
                                        const displayPath = workspacePath
                                            ? path.relative(uriToPath(workspacePath), uriToPath(filePath))
                                            : uriToPath(filePath);

                                        const totalMatches = results.reduce((sum, r) => sum + (r.matches?.length || 0), 0);
                                        if (totalMatches === 0) return null; // Don't show files without matches

                                        const filePathKey = filePath; // Use original path as key
                                        const isExpanded = expandedFiles.has(displayPath);

                                        return (
                                            <div key={filePathKey} className={css`
                                                margin-bottom: 8px;
                                                border-radius: 3px;
                                                overflow: hidden;
                                            `}>
                                                {/* File Header */}
                                                <div
                                                    className={css`
                                                        display: flex;
                                                        align-items: center;
                                                        background-color: var(--vscode-list-dropBackground);
                                                        padding: 4px 8px;
                                                        gap: 8px;
                                                        cursor: pointer;
                                                        &:hover { background-color: var(--vscode-list-hoverBackground); }
                                                    `}
                                                    onClick={() => toggleFileExpansion(displayPath)}
                                                >
                                                    <span className={`codicon codicon-chevron-${isExpanded ? 'down' : 'right'}`} />
                                                    <span
                                                        className={css`font-weight: bold; cursor: pointer;`}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleFileClick(filePath);
                                                        }}
                                                        title={`Click to open ${displayPath}`}
                                                    >
                                                        {displayPath}
                                                    </span>
                                                    <span className={css`
                                                        margin-left: auto;
                                                        color: var(--vscode-descriptionForeground);
                                                    `}>
                                                        {totalMatches} matches
                                                    </span>
                                                </div>

                                                {/* Expanded Matches */}
                                                {isExpanded && (
                                                    <div className={css`
                                                        padding: 4px 0;
                                                        background-color: var(--vscode-editor-background);
                                                    `}>
                                                        {results.map((result, resultIdx) =>
                                                            result.matches?.map((match, matchIdx) => (
                                                                <div
                                                                    key={`${resultIdx}-${matchIdx}`}
                                                                    className={css`
                                                                        padding: 2px 24px;
                                                                        font-family: var(--vscode-editor-font-family);
                                                                        font-size: var(--vscode-editor-font-size);
                                                                        cursor: pointer;
                                                                        &:hover { background-color: var(--vscode-list-hoverBackground); }
                                                                    `}
                                                                    onClick={() => handleResultItemClick(filePath, match)}
                                                                    title={getLineFromSource(result.source, match.start, match.end)}
                                                                    onMouseEnter={(e) => {
                                                                        // Set hovering state for the match item
                                                                        (e.currentTarget as HTMLElement).dataset.hovered = 'true';
                                                                    }}
                                                                    onMouseLeave={(e) => {
                                                                        // Clear hovering state
                                                                        delete (e.currentTarget as HTMLElement).dataset.hovered;
                                                                    }}
                                                                >
                                                                    {searchLevels[searchLevels.length - 1].values.replace && searchLevels[searchLevels.length - 1].values.replace.length > 0
                                                                        ? getHighlightedMatchContextWithReplacement(
                                                                            result.source,
                                                                            match.start,
                                                                            match.end,
                                                                            searchLevels[searchLevels.length - 1].values.find,
                                                                            searchLevels[searchLevels.length - 1].values.replace,
                                                                            searchLevels[searchLevels.length - 1].values.searchMode,
                                                                            searchLevels[searchLevels.length - 1].values.matchCase,
                                                                            searchLevels[searchLevels.length - 1].values.wholeWord
                                                                        )
                                                                        : getHighlightedMatchContext(result.source, match.start, match.end)}

                                                                    {/* Replace button for individual match */}
                                                                    {searchLevels[searchLevels.length - 1].values.replace && (
                                                                        <div
                                                                            className={css`
                                                                                position: absolute;
                                                                                right: 5px;
                                                                                top: 50%;
                                                                                transform: translateY(-50%);
                                                                                opacity: 0;
                                                                                transition: opacity 0.2s;
                                                                                [data-hovered="true"] & {
                                                                                    opacity: 1;
                                                                                }
                                                                            `}
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                // For now, just replace all matches in this file
                                                                                handleReplaceSelectedFiles([filePath]);
                                                                            }}
                                                                        >
                                                                            <button
                                                                                className={css`
                                                                                    background-color: var(--vscode-button-background);
                                                                                    color: var(--vscode-button-foreground);
                                                                                    border: none;
                                                                                    border-radius: 2px;
                                                                                    cursor: pointer;
                                                                                    padding: 2px 6px;
                                                                                    font-size: 12px;
                                                                                    &:hover {
                                                                                        background-color: var(--vscode-button-hoverBackground);
                                                                                    }
                                                                                `}
                                                                                title="Replace this match"
                                                                            >
                                                                                <span className="codicon codicon-replace-all" />
                                                                            </button>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            ))
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })
                                ) : running ? (
                                    <div className={css`
                                        padding: 10px;
                                        color: var(--vscode-descriptionForeground);
                                        text-align: center;
                                    `}>
                                        Searching... {completed} / {total} files
                                    </div>
                                ) : (
                                    <div className={css`
                                        padding: 10px;
                                        color: var(--vscode-descriptionForeground);
                                        text-align: center;
                                    `}>
                                        No matches found. Try adjusting your search terms or filters.
                                    </div>
                                )}
                            </div>
                        )}
                    </>
                ) : (
                    // Original results view
                    <>
                        {/* Regular Results View */}
                        {viewMode === 'tree' ? (
                            // Tree view of results
                            <div>
                                {filteredFileTree.children.length > 0 ? (
                                    filteredFileTree.children.map(node => (
                                        <TreeViewNode
                                            key={node.relativePath}
                                            node={node}
                                            level={0}
                                            expandedFolders={expandedFolders}
                                            toggleFolderExpansion={toggleFolderExpansion}
                                            expandedFiles={expandedFiles}
                                            toggleFileExpansion={toggleFileExpansion}
                                            handleFileClick={handleFileClick}
                                            handleResultItemClick={handleResultItemClick}
                                            handleReplace={handleReplaceSelectedFiles}
                                            currentSearchValues={values}
                                        />
                                    ))
                                ) : (
                                    <div className={css`
                                        padding: 10px;
                                        color: var(--vscode-descriptionForeground);
                                        text-align: center;
                                        `}>
                                        No matches found. Try adjusting your search terms or filters.
                                    </div>
                                )}
                            </div>
                        ) : (
                            // List view of results
                            <div>
                                {Object.entries(resultsByFile).length > 0 ? (
                                    Object.entries(resultsByFile).map(([filePath, results]) => {
                                        const displayPath = workspacePath
                                            ? path.relative(uriToPath(workspacePath), uriToPath(filePath))
                                            : uriToPath(filePath);

                                        const totalMatches = results.reduce((sum, r) => sum + (r.matches?.length || 0), 0);
                                        if (totalMatches === 0) return null; // Don't show files without matches

                                        const filePathKey = filePath; // Use original path as key
                                        const isExpanded = expandedFiles.has(displayPath);

                                        return (
                                            <div key={filePathKey} className={css`
                                                margin-bottom: 8px;
                                                border-radius: 3px;
                                                overflow: hidden;
                                            `}>
                                                {/* File Header */}
                                                <div
                                                    className={css`
                                                        display: flex;
                                                        align-items: center;
                                                        background-color: var(--vscode-list-dropBackground);
                                                        padding: 4px 8px;
                                                        gap: 8px;
                                                        cursor: pointer;
                                                        &:hover { background-color: var(--vscode-list-hoverBackground); }
                                                    `}
                                                    onClick={() => toggleFileExpansion(displayPath)}
                                                >
                                                    <span className={`codicon codicon-chevron-${isExpanded ? 'down' : 'right'}`} />
                                                    <span
                                                        className={css`font-weight: bold; cursor: pointer;`}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleFileClick(filePath);
                                                        }}
                                                        title={`Click to open ${displayPath}`}
                                                    >
                                                        {displayPath}
                                                    </span>
                                                    <span className={css`
                                                        margin-left: auto;
                                                        color: var(--vscode-descriptionForeground);
                                                    `}>
                                                        {totalMatches} matches
                                                    </span>
                                                </div>

                                                {/* Expanded Matches */}
                                                {isExpanded && (
                                                    <div className={css`
                                                        padding: 4px 0;
                                                        background-color: var(--vscode-editor-background);
                                                    `}>
                                                        {results.map((result, resultIdx) =>
                                                            result.matches?.map((match, matchIdx) => (
                                                                <div
                                                                    key={`${resultIdx}-${matchIdx}`}
                                                                    className={css`
                                                                        padding: 2px 24px;
                                                                        font-family: var(--vscode-editor-font-family);
                                                                        font-size: var(--vscode-editor-font-size);
                                                                        cursor: pointer;
                                                                        &:hover { background-color: var(--vscode-list-hoverBackground); }
                                                                    `}
                                                                    onClick={() => handleResultItemClick(filePath, match)}
                                                                    title={getLineFromSource(result.source, match.start, match.end)}
                                                                    onMouseEnter={(e) => {
                                                                        // Set hovering state for the match item
                                                                        (e.currentTarget as HTMLElement).dataset.hovered = 'true';
                                                                    }}
                                                                    onMouseLeave={(e) => {
                                                                        // Clear hovering state
                                                                        delete (e.currentTarget as HTMLElement).dataset.hovered;
                                                                    }}
                                                                >
                                                                    {searchLevels[searchLevels.length - 1].values.replace && searchLevels[searchLevels.length - 1].values.replace.length > 0
                                                                        ? getHighlightedMatchContextWithReplacement(
                                                                            result.source,
                                                                            match.start,
                                                                            match.end,
                                                                            searchLevels[searchLevels.length - 1].values.find,
                                                                            searchLevels[searchLevels.length - 1].values.replace,
                                                                            searchLevels[searchLevels.length - 1].values.searchMode,
                                                                            searchLevels[searchLevels.length - 1].values.matchCase,
                                                                            searchLevels[searchLevels.length - 1].values.wholeWord
                                                                        )
                                                                        : getHighlightedMatchContext(result.source, match.start, match.end)}

                                                                    {/* Replace button for individual match */}
                                                                    {searchLevels[searchLevels.length - 1].values.replace && (
                                                                        <div
                                                                            className={css`
                                                                                position: absolute;
                                                                                right: 5px;
                                                                                top: 50%;
                                                                                transform: translateY(-50%);
                                                                                opacity: 0;
                                                                                transition: opacity 0.2s;
                                                                                [data-hovered="true"] & {
                                                                                    opacity: 1;
                                                                                }
                                                                            `}
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                // For now, just replace all matches in this file
                                                                                handleReplaceSelectedFiles([filePath]);
                                                                            }}
                                                                        >
                                                                            <button
                                                                                className={css`
                                                                                    background-color: var(--vscode-button-background);
                                                                                    color: var(--vscode-button-foreground);
                                                                                    border: none;
                                                                                    border-radius: 2px;
                                                                                    cursor: pointer;
                                                                                    padding: 2px 6px;
                                                                                    font-size: 12px;
                                                                                    &:hover {
                                                                                        background-color: var(--vscode-button-hoverBackground);
                                                                                    }
                                                                                `}
                                                                                title="Replace this match"
                                                                            >
                                                                                <span className="codicon codicon-replace-all" />
                                                                            </button>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            ))
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })
                                ) : running ? (
                                    <div className={css`
                                        padding: 10px;
                                        color: var(--vscode-descriptionForeground);
                                        text-align: center;
                                    `}>
                                        Searching... {completed} / {total} files
                                    </div>
                                ) : (
                                    <div className={css`
                                        padding: 10px;
                                        color: var(--vscode-descriptionForeground);
                                        text-align: center;
                                    `}>
                                        No matches found. Try adjusting your search terms or filters.
                                    </div>
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    )
}

// Helper function to escape regex special characters
function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
