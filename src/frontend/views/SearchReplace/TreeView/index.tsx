import React, { memo } from "react";
import path from 'path-browserify'
import { SerializedTransformResultEvent } from '../../../../model/SearchReplaceViewTypes';
import { css } from '@emotion/css'
import { getHighlightedMatchContextWithReplacement } from './highlightedContextWithReplacement';
import { getHighlightedMatchContext } from './highligtedContext';
import { getLineFromSource } from '../utils';
import { getFileIcon } from "../../../components/icons";
import { SearchReplaceViewValues } from "../../../../model/SearchReplaceViewTypes"; // Re-adding this as it was removed from the other import but is still used.

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
    handleExcludeFile?: (filePath: string) => void; // Добавляем обработчик для исключения файла
    onDragStart?: (e: React.DragEvent, node: FileTreeNode) => void; // Drag and drop handlers
    onDragOver?: (e: React.DragEvent, node: FileTreeNode) => void;
    onDrop?: (e: React.DragEvent, node: FileTreeNode) => void;
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

export const TreeViewNode: React.FC<TreeViewNodeProps> = React.memo(({
    node,
    level,
    expandedFolders,
    toggleFolderExpansion,
    expandedFiles,
    toggleFileExpansion,
    handleFileClick,
    handleResultItemClick,
    handleReplace,
    currentSearchValues, // Получаем значения через пропсы
    handleExcludeFile,
    onDragStart,
    onDragOver,
    onDrop
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
                    draggable={true}
                    onDragStart={(e) => onDragStart?.(e, node)}
                    onDragOver={(e) => onDragOver?.(e, node)}
                    onDrop={(e) => onDrop?.(e, node)}
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

                        {/* Exclude button shown on hover */}
                        {isHovered && handleExcludeFile && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation(); // Prevent folder expansion
                                    // Исключаем все файлы в папке
                                    getAllFilePathsInFolder().forEach(filePath => {
                                        handleExcludeFile(filePath);
                                    });
                                }}
                                title={`Exclude ${node.name} folder from search`}
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
                                        color: var(--vscode-errorForeground);
                                    }
                                `}
                            >
                                <span className="codicon codicon-close" />
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
                                handleExcludeFile={handleExcludeFile}
                                onDragStart={onDragStart}
                                onDragOver={onDragOver}
                                onDrop={onDrop}
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
                    draggable={true}
                    onDragStart={(e) => onDragStart?.(e, node)}
                    onDragOver={(e) => onDragOver?.(e, node)}
                    onDrop={(e) => onDrop?.(e, node)}
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

                        {/* Exclude button shown on hover */}
                        {isHovered && handleExcludeFile && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleExcludeFile(node.absolutePath);
                                }}
                                title={`Exclude ${node.name} from search`}
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
                                        color: var(--vscode-errorForeground);
                                    }
                                `}
                            >
                                <span className="codicon codicon-close" />
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
                                            match,
                                            currentSearchValues?.find,
                                            currentSearchValues.replace,
                                            currentSearchValues?.searchMode,
                                            currentSearchValues?.matchCase,
                                            currentSearchValues?.wholeWord
                                        )
                                        : getHighlightedMatchContext(res.source, match)}

                                    {/* Replace button for individual match */}
                                    {currentSearchValues.replace && (
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
                                                handleReplace([node.absolutePath]);
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
