import React, { memo, useRef, useState, useEffect } from "react";
import path from 'path-browserify'
import { SerializedTransformResultEvent } from '../../../model/SearchReplaceViewTypes';
import { cn } from "../../utils"
import { getHighlightedMatchContextWithReplacement } from './highlightedContextWithReplacement';
import { getHighlightedMatchContext } from './highligtedContext';
import { getLineFromSource } from '../utils';
import { getFileIcon } from "../../components/icons";
import { SearchReplaceViewValues } from "../../../model/SearchReplaceViewTypes";

// --- Styles ---
const STYLES = `
@keyframes fadeIn { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: translateY(0); } }
.animate-fade-in { animation: fadeIn 0.2s ease-out forwards; }
`;

export interface FileTreeNodeBase {
    name: string
    relativePath: string
}

export interface FolderNode extends FileTreeNodeBase {
    type: 'folder'
    children: FileTreeNode[]
    stats?: {
        numMatches: number
        numFilesWithMatches: number
    }
}

export interface FileNode extends FileTreeNodeBase {
    type: 'file'
    absolutePath: string
    results: SerializedTransformResultEvent[]
}

export type FileTreeNode = FolderNode | FileNode

// --- Collapsible Component ---
const Collapsible = ({ isOpen, children }: { isOpen: boolean, children: React.ReactNode }) => {
    const [shouldRender, setShouldRender] = useState(isOpen);
    const [height, setHeight] = useState<string | number>(isOpen ? 'auto' : 0);
    const [opacity, setOpacity] = useState<number>(isOpen ? 1 : 0);
    const ref = useRef<HTMLDivElement>(null);
    const isFirstRender = useRef(true);

    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return; // Skip animation on mount
        }

        if (isOpen) {
            setShouldRender(true);
            setHeight(0);
            setOpacity(0);

            // Double RAF to ensure browser paint
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (ref.current) {
                        const fullHeight = ref.current.scrollHeight;
                        const maxAnimHeight = window.innerHeight;
                        const targetHeight = Math.min(fullHeight, maxAnimHeight);

                        setHeight(targetHeight);
                        setOpacity(1);
                    }
                });
            });

            const timer = setTimeout(() => {
                setHeight('auto');
            }, 200); // Match transition duration
            return () => clearTimeout(timer);
        } else {
            if (ref.current) {
                const fullHeight = ref.current.scrollHeight;
                const maxAnimHeight = window.innerHeight;
                const startHeight = Math.min(fullHeight, maxAnimHeight);

                setHeight(startHeight);

                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        setHeight(0);
                        setOpacity(0);
                    });
                });
            }

            const timer = setTimeout(() => {
                setShouldRender(false);
            }, 200);
            return () => clearTimeout(timer);
        }
    }, [isOpen]);

    if (!shouldRender) return null;

    return (
        <div
            ref={ref}
            style={{
                height,
                opacity,
                transition: 'height 0.2s ease-in-out, opacity 0.2s ease-in-out',
                overflow: 'hidden'
            }}
        >
            {children}
        </div>
    );
};

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
    handleReplace: (paths: string[]) => void;
    currentSearchValues: SearchReplaceViewValues;
    handleExcludeFile?: (filePath: string) => void;
    onDragStart?: (e: React.DragEvent, node: FileTreeNode) => void;
    onDragOver?: (e: React.DragEvent, node: FileTreeNode) => void;
    onDrop?: (e: React.DragEvent, node: FileTreeNode) => void;
}

// Function for folders (using codicons)
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
    currentSearchValues,
    handleExcludeFile,
    onDragStart,
    onDragOver,
    onDrop
}) => {
    const [isHovered, setIsHovered] = React.useState(false);
    const indentSize = 16;
    const isExpanded = node.type === 'folder'
        ? expandedFolders.has(node.relativePath)
        : expandedFiles.has(node.absolutePath || '');

    const renderIndentationGuides = () => {
        if (level === 0) return null;

        const totalWidth = level * indentSize;

        return (
            <div
                className="relative flex-shrink-0"
                style={{ width: `${totalWidth}px`, minWidth: `${totalWidth}px` }}
            >
                {Array.from({ length: level }).map((_, i) => (
                    <div
                        key={i}
                        className="absolute top-0 bottom-0"
                        style={{
                            left: `${i * indentSize + indentSize / 2}px`,
                            width: '1px',
                            backgroundColor: 'var(--vscode-tree-indentGuidesStroke)'
                        }}
                    />
                ))}
            </div>
        );
    };

    if (node.type === 'folder') {

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
            <div>
                <style>{STYLES}</style>
                <div
                    className={cn(
                        "flex items-stretch cursor-pointer hover:bg-[var(--vscode-list-hoverBackground)]",
                        "sticky bg-[var(--vscode-sideBar-background)]"
                    )}
                    style={{
                        zIndex: 100 - level,
                        top: `${level * 22}px`
                    }}
                    onClick={(e) => {
                        // Interactive sticky header: Expand if closed, Scroll to top if open
                        if (!isExpanded) {
                            toggleFolderExpansion(node.relativePath);
                        } else {
                            e.currentTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }
                    }}
                    title={`Click to ${isExpanded ? 'scroll to top' : 'expand'} ${node.name}`}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                    draggable={true}
                    onDragStart={(e) => onDragStart?.(e, node)}
                    onDragOver={(e) => onDragOver?.(e, node)}
                    onDrop={(e) => onDrop?.(e, node)}
                >
                    {renderIndentationGuides()}
                    <div className="flex items-center gap-1.5 pl-1 flex-grow py-0.5 min-h-[22px]">
                        <span
                            className={`codicon codicon-chevron-down transition-transform duration-200 cursor-pointer`}
                            style={{ transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
                            onClick={(e) => {
                                e.stopPropagation();
                                toggleFolderExpansion(node.relativePath);
                            }}
                        />
                        <span className="codicon codicon-folder text-[var(--vscode-icon-foreground)]" />
                        <span className="font-semibold">{node.name}</span>

                        {/* Stats & Replace button container */}
                        <div className="relative flex items-center gap-1 ml-auto mr-1">
                            {/* Stats */}
                            {hasMatches && node.stats && (
                                <span
                                    className="text-[var(--vscode-descriptionForeground)] transition-opacity duration-200 text-xs"
                                    style={{ opacity: isHovered && currentSearchValues.replace ? 0.3 : 1 }}
                                >
                                    ({node.stats.numFilesWithMatches}, {node.stats.numMatches})
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
                                    className="bg-transparent border-none px-0.5 cursor-pointer flex items-center justify-center text-[#bcbbbc] rounded-[3px] hover:bg-gray-500/20 min-w-auto"
                                >
                                    <span className="codicon codicon-replace-all" />
                                </button>
                            )}

                            {/* Exclude button shown on hover */}
                            {isHovered && handleExcludeFile && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation(); // Prevent folder expansion
                                        // Exclude all files in folder
                                        getAllFilePathsInFolder().forEach(filePath => {
                                            handleExcludeFile(filePath);
                                        });
                                    }}
                                    title={`Exclude ${node.name} folder from search`}
                                    className="bg-transparent border-none px-0.5 cursor-pointer flex items-center justify-center text-[#bcbbbc] rounded-[3px] hover:bg-gray-500/20 hover:text-[var(--vscode-errorForeground)] min-w-auto"
                                >
                                    <span className="codicon codicon-close" />
                                </button>
                            )}
                        </div>
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
        const totalMatches = fileResults.reduce((sum, r) => sum + (r.matches?.length || 0), 0);
        const hasError = fileResults.some(r => r.error);
        const canExpand = totalMatches > 0; // Can only expand file if there are matches

        return (
            <div key={node.relativePath}>
                <style>{STYLES}</style>
                {/* File Entry */}
                <div
                    className="flex items-stretch cursor-pointer hover:bg-[var(--vscode-list-hoverBackground)] group"
                    onClick={() => canExpand ? toggleFileExpansion(node.absolutePath) : handleFileClick(node.absolutePath)}
                    title={canExpand ? `Click to ${isExpanded ? 'collapse' : 'expand'} matches in ${node.name}` : `Click to open ${node.name}`}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                    draggable={true}
                    onDragStart={(e) => onDragStart?.(e, node)}
                    onDragOver={(e) => onDragOver?.(e, node)}
                    onDrop={(e) => onDrop?.(e, node)}
                >
                    {renderIndentationGuides()}
                    <div className="flex items-center gap-1.5 pl-1 w-full overflow-hidden py-0.5 min-h-[22px]">
                        {/* Chevron only visible if there are matches to expand */}
                        <span className={`codicon codicon-chevron-down transition-transform duration-200`}
                            style={{
                                visibility: canExpand ? 'visible' : 'hidden',
                                transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)'
                            }} />
                        {getFileIcon(node.name)}
                        {/* Make filename itself always clickable to open file */}
                        <span className="font-bold flex-grow cursor-pointer truncate"
                            onClick={(e) => { e.stopPropagation(); handleFileClick(node.absolutePath); }}
                            title={`Click to open ${node.name}`}>{node.name}</span>

                        {/* Stats & Replace button container */}
                        <div className="relative flex items-center gap-1 ml-auto shrink-0 mr-1">
                            {/* Match count or error status */}
                            <span
                                className="text-[var(--vscode-descriptionForeground)] transition-opacity duration-200"
                                style={{ opacity: isHovered && totalMatches > 0 && currentSearchValues.replace ? 0.3 : 1 }}
                            >
                                {/* Prioritize match count, then check for error */}
                                {totalMatches > 0
                                    ? `${totalMatches} matches`
                                    : (hasError ? 'Error' : 'Changed')}
                            </span>

                            {/* Show (Error) indicator only if there are no matches AND there is an error */}
                            {totalMatches === 0 && hasError &&
                                <span className="ml-2 text-[var(--vscode-errorForeground)]">(Error)</span>}

                            {/* Replace button shown on hover */}
                            {isHovered && totalMatches > 0 && currentSearchValues.replace && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleReplace([node.absolutePath]);
                                    }}
                                    title={`Replace all matches in ${node.name}`}
                                    className="bg-transparent border-none px-0.5 cursor-pointer flex items-center justify-center text-[#bcbbbc] rounded-[3px] hover:bg-gray-500/20 min-w-auto"
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
                                    className="bg-transparent border-none px-0.5 cursor-pointer flex items-center justify-center text-[#bcbbbc] rounded-[3px] hover:bg-gray-500/20 hover:text-[var(--vscode-errorForeground)] min-w-auto"
                                >
                                    <span className="codicon codicon-close" />
                                </button>
                            )}
                        </div>
                    </div>
                </div>
                {/* Expanded Matches */}
                {(isExpanded && canExpand) && (
                    <div>
                        {fileResults.map((res, idx) => (
                            res.matches?.map((match, matchIdx) => (
                                <div key={`${idx}-${matchIdx}`}
                                    className="flex items-stretch cursor-pointer relative hover:bg-[var(--vscode-list-hoverBackground)] group"
                                    onClick={() => handleResultItemClick(node.absolutePath, { start: match.start, end: match.end })}
                                    title={getLineFromSource(res.source, match.start, match.end)}
                                >
                                    {/* Match Indentation: level + 1 (for file) */}
                                    {(level + 1) > 0 && (
                                        <div
                                            className="relative flex-shrink-0"
                                            style={{ width: `${(level + 1) * indentSize}px`, minWidth: `${(level + 1) * indentSize}px` }}
                                        >
                                            {Array.from({ length: level + 1 }).map((_, i) => (
                                                <div
                                                    key={i}
                                                    className="absolute top-0 bottom-0"
                                                    style={{
                                                        left: `${i * indentSize + indentSize / 2}px`,
                                                        width: '1px',
                                                        backgroundColor: 'var(--vscode-tree-indentGuidesStroke)'
                                                    }}
                                                />
                                            ))}
                                        </div>
                                    )}

                                    <div className="pl-4 w-full overflow-hidden min-h-[22px] py-0.5 flex flex-col justify-center">
                                        {currentSearchValues.replace && currentSearchValues.replace.length > 0
                                            ? getHighlightedMatchContextWithReplacement(
                                                res.source,
                                                match,
                                                currentSearchValues?.find,
                                                currentSearchValues.replace,
                                                currentSearchValues?.searchMode,
                                                currentSearchValues?.matchCase,
                                                currentSearchValues?.wholeWord,
                                                undefined,
                                                currentSearchValues?.searchMode === 'regex'
                                            )
                                            : getHighlightedMatchContext(res.source, match, undefined, currentSearchValues?.searchMode === 'regex')}
                                    </div>

                                    {/* Replace button for individual match */}
                                    {currentSearchValues.replace && (
                                        <div
                                            className="absolute right-[5px] top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                // For now, just replace all matches in this file
                                                // In the future we could implement single match replacement
                                                handleReplace([node.absolutePath]);
                                            }}
                                        >
                                            <button
                                                className="bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] border-none rounded-[2px] cursor-pointer px-1.5 py-[2px] text-xs hover:bg-[var(--vscode-button-hoverBackground)]"
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
                            <div className="text-[var(--vscode-errorForeground)] px-1.5 py-px">
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
