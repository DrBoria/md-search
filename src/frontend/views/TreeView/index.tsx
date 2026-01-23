import React, { memo, useRef, useState, useEffect, useCallback, useMemo } from "react";

import path from 'path-browserify'
import { SerializedTransformResultEvent } from '../../../model/SearchReplaceViewTypes';
import { cn } from "../../utils"
import { getHighlightedMatchContextWithReplacement } from './highlightedContextWithReplacement';
import { getHighlightedMatchContext } from './highligtedContext';
import { getLineFromSource } from '../utils';
import { FileIcon } from "../../components/icons";
import { SearchReplaceViewValues } from "../../../model/SearchReplaceViewTypes";
import { AnimatedCounter } from "../components/AnimatedCounter";

// --- Styles ---
const STYLES = `
@keyframes fadeIn { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: translateY(0); } }
.animate-fade-in { animation: fadeIn 0.2s ease-out forwards; }
/* Fix for Sticky Jump: behaviors sticky elements as relative during animation */
.collapsible-animating .tree-node-sticky-header {
    position: relative !important;
    top: auto !important;
}
`;

export interface FileTreeNodeBase {
    name: string
    relativePath: string
}

export interface FolderNode extends FileTreeNodeBase {
    type: 'folder'
    absolutePath: string
    children: FileTreeNode[]
    stats?: {
        numMatches: number
        numFilesWithMatches: number
    }
}

export interface FileNode extends FileTreeNodeBase {
    type: 'file'
    absolutePath: string
    description?: string // Added description support
    results: SerializedTransformResultEvent[]
}

export type FileTreeNode = FolderNode | FileNode

// --- Collapsible Component ---


const Collapsible = ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode; itemCount?: number }) => {
    if (!isOpen) return null;
    return <div>{children}</div>;
};

// --- TreeViewNode Component ---
interface TreeViewNodeProps {
    node: FileTreeNode;
    index: number; // Added index for z-index stacking context
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
    renderChildren?: boolean; // New prop to control children rendering
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
    index,
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
    onDrop,
    renderChildren = true // Default to true
}) => {
    const [isHovered, setIsHovered] = React.useState(false);
    const [isDragOver, setIsDragOver] = React.useState(false); // New state to track drag over
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
                            left: `${i * indentSize + indentSize / 2 + 3}px`,
                            width: '1px',
                            backgroundColor: 'var(--vscode-tree-indentGuidesStroke)'
                        }}
                    />
                ))}
            </div>
        );
    };

    const handleDragEnter = (e: React.DragEvent) => {
        e.preventDefault();
        // Only visual for files
        if (node.type === 'file') setIsDragOver(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
    };

    // Wrap onDrop to clear state
    const handleDropWrapper = (e: React.DragEvent) => {
        setIsDragOver(false);
        onDrop?.(e, node);
    }

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
                        "sticky bg-[var(--vscode-sideBar-background)] tree-node-sticky-header"
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
                            // Manual scroll to handle sticky positioning correctly
                            const header = e.currentTarget;
                            const wrapper = header.parentElement;
                            // Find closest scrollable container
                            let container = wrapper?.parentElement;
                            while (container && container !== document.body) {
                                const style = window.getComputedStyle(container);
                                if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                                    break;
                                }
                                container = container.parentElement;
                            }

                            if (container && wrapper) {
                                const containerRect = container.getBoundingClientRect();
                                const wrapperRect = wrapper.getBoundingClientRect();
                                // Calculate where the wrapper (start of folder) is relative to the scroll content
                                const currentRelativeTop = wrapperRect.top - containerRect.top + container.scrollTop;
                                // We want this wrapper top to settle at (level * 22px) from the container top
                                const targetScrollTop = currentRelativeTop - (level * 22);

                                container.scrollTo({
                                    top: targetScrollTop,
                                    behavior: 'smooth'
                                });
                            }
                        }
                    }}
                    title={`Click to ${isExpanded ? 'scroll to top' : 'expand'} ${node.name}`}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                    draggable={true}
                    onDragStart={(e) => {
                        console.log(`[TreeViewNode] [Folder] onDragStart: ${node.name}`, node);
                        onDragStart?.(e, node);
                    }}
                    onDragOver={(e) => {
                        // console.log(`[TreeViewNode] [Folder] onDragOver: ${node.name}`);
                        onDragOver?.(e, node);
                    }}
                    onDrop={(e) => {
                        console.log(`[TreeViewNode] [Folder] onDrop: ${node.name}`);
                        onDrop?.(e, node);
                    }}
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
                        <div
                            className="absolute right-1 flex items-center gap-1 h-full z-10 pl-2"
                            style={{ backgroundColor: 'inherit' }}
                        >
                            {/* Stats */}
                            {hasMatches && node.stats && (
                                <span
                                    className="text-[var(--vscode-descriptionForeground)] transition-opacity duration-200 text-xs whitespace-nowrap"
                                    style={{ opacity: isHovered && currentSearchValues.replace ? 0.3 : 1 }}
                                >
                                    (<AnimatedCounter value={node.stats.numFilesWithMatches} suffix=" files" />, <AnimatedCounter value={node.stats.numMatches} suffix=" matches" />)
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
                {renderChildren && (
                    <Collapsible isOpen={isExpanded} itemCount={node.children.length}>
                        {node.children.map((child, i) => (
                            <TreeViewNode
                                key={child.relativePath}
                                node={child}
                                index={i}
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
                    </Collapsible>
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
            <div
                key={node.relativePath}
                className="relative"
                style={{ zIndex: 1000 - index }} // Stack earlier items on top of later items
            >

                {/* File Entry */}
                <div
                    className={cn(
                        "relative flex items-stretch z-10",
                        isHovered ? "bg-[var(--vscode-list-hoverBackground)]" : "",
                        "group z-10",
                        isDragOver ? "bg-[var(--vscode-list-dropBackground)] outline outline-1 outline-[var(--vscode-list-focusOutline)]" : ""
                    )}
                    onClick={() => canExpand ? toggleFileExpansion(node.absolutePath) : handleFileClick(node.absolutePath)}
                    title={canExpand ? `Click to ${isExpanded ? 'collapse' : 'expand'} matches in ${node.name}` : `Click to open ${node.name}`}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                    draggable={true}
                    onDragStart={(e) => {
                        console.log(`[TreeViewNode] [File] onDragStart: ${node.name}`, node);
                        onDragStart?.(e, node);
                    }}
                    onDragOver={(e) => {
                        // console.log('onDragOver', e);
                        onDragOver?.(e, node);
                        handleDragEnter(e); // Trigger visual
                    }}
                    onDragEnter={handleDragEnter}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => {
                        console.log(`[TreeViewNode] [File] onDrop: ${node.name}`);
                        handleDropWrapper(e);
                    }}
                >
                    {renderIndentationGuides()}
                    <div className="flex items-center gap-1.5 pl-1 w-full overflow-hidden py-0.5 min-h-[22px]">
                        {/* Chevron only visible if there are matches to expand */}
                        <span className={`codicon codicon-chevron-down transition-transform duration-200`}
                            style={{
                                visibility: canExpand ? 'visible' : 'hidden',
                                transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)'
                            }} />
                        <FileIcon filePath={node.name} />
                        {/* Make filename itself always clickable to open file. Flex layout allows proper truncation. */}
                        <div className="flex-grow flex items-baseline min-w-0 overflow-hidden"
                            onClick={(e) => { e.stopPropagation(); handleFileClick(node.absolutePath); }}
                            title={`Click to open ${node.absolutePath}`}>
                            <span className="font-bold truncate shrink-0 cursor-pointer hover:underline">{node.name}</span>
                            {/* Render description if present (e.g. path in list view) */}
                            {node.description && (
                                <span className="text-[var(--vscode-descriptionForeground)] text-xs ml-2 truncate opacity-90 cursor-pointer">
                                    {node.description}
                                </span>
                            )}
                        </div>

                        {/* Stats & Replace button container - Flex Item, not absolute */}
                        <div
                            className="flex items-center gap-1 h-full z-10 pl-2 ml-auto flex-shrink-0"
                        >
                            {/* Match count or error status */}
                            <span
                                className="text-[var(--vscode-descriptionForeground)] transition-opacity duration-200 whitespace-nowrap"
                                style={{ opacity: isHovered && totalMatches > 0 && currentSearchValues.replace ? 0.3 : 1 }}
                            >
                                {/* Prioritize match count, then check for error */}
                                {totalMatches > 0
                                    ? <><AnimatedCounter value={totalMatches} suffix=" matches" /></>
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
                {renderChildren && (
                    <Collapsible isOpen={isExpanded && canExpand}>
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
                                                        left: `${i * indentSize + indentSize / 2 + 3}px`,
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
                        {/* Display error if present */}
                        {hasError && totalMatches === 0 && (
                            <div className="text-[var(--vscode-errorForeground)] px-1.5 py-px">
                                {String(firstResult.error?.message || firstResult.error || 'Error occurred')}
                            </div>
                        )}
                    </Collapsible>
                )}
            </div>
        );
    }
});
TreeViewNode.displayName = 'TreeViewNode';
