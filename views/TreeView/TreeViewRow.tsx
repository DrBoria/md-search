import React, { memo } from 'react';
import { FileTreeNode, FolderNode, FileNode } from './index';
import { FileIcon } from '../../components/icons';
import { AnimatedCounter } from '../components/AnimatedCounter';
import { getHighlightedMatchContextWithReplacement } from './highlightedContextWithReplacement';
import { getHighlightedMatchContext } from './highligtedContext';
import { cn } from '../../utils';
import { SearchReplaceViewValues } from '../../../model/SearchReplaceViewTypes';
import { URI } from 'vscode-uri';

import { getLineFromSource } from '../utils';

import { MatchNode } from './virtualizationUtils';

// Reusing types from index.tsx or defining subset needed for Row
interface TreeViewRowProps {
    node: FileTreeNode | MatchNode;
    depth: number;
    style: React.CSSProperties;
    expandedFolders: Set<string>;
    toggleFolderExpansion: (path: string) => void;
    expandedFiles: Set<string>;
    toggleFileExpansion: (path: string) => void;
    handleFileClick: (path: string) => void;
    handleFolderClick?: (path: string) => void; // New prop for smart folder click
    handleResultItemClick: (path: string, range?: { start: number; end: number }) => void;
    handleReplace: (paths: string[]) => void;
    handleExcludeFile?: (path: string) => void;
    currentSearchValues: SearchReplaceViewValues;
    onDragStart?: (e: React.DragEvent, node: FileTreeNode) => void;
    onDragOver?: (e: React.DragEvent, node: FileTreeNode) => void;
    onDrop?: (e: React.DragEvent, node: FileTreeNode) => void;
}

export const TreeViewRow = memo(({
    node,
    depth,
    style,
    expandedFolders,
    toggleFolderExpansion,
    expandedFiles,
    toggleFileExpansion,
    handleFileClick,
    handleFolderClick, // Destructure
    handleResultItemClick,
    handleReplace,
    handleExcludeFile,
    currentSearchValues,
    onDragStart,
    onDragOver,
    onDrop
}: TreeViewRowProps) => {
    const [isHovered, setIsHovered] = React.useState(false);
    const [isDragOver, setIsDragOver] = React.useState(false);

    // Indentation
    const indentSize = 16;
    const paddingLeft = depth * indentSize;

    const isExpanded = node.type === 'folder'
        ? expandedFolders.has(node.relativePath)
        : (node.type === 'file' ? expandedFiles.has(node.absolutePath || '') : false);

    // --- Drag & Drop Handlers ---
    const handleDragEnter = (e: React.DragEvent) => {
        e.preventDefault();
        if (node.type === 'file') setIsDragOver(true);
    };
    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
    };
    const handleDropWrapper = (e: React.DragEvent) => {
        setIsDragOver(false);
        if (node.type !== 'match') {
            onDrop?.(e, node);
        }
    };

    // --- Render Guides ---
    const renderIndentationGuides = () => {
        if (depth === 0) return null;
        return (
            <div className="absolute top-0 bottom-0 left-0 pointer-events-none" style={{ width: `${paddingLeft}px` }}>
                {Array.from({ length: depth }).map((_, i) => (
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

    // --- MATCH RENDERING ---
    if (node.type === 'match') {
        const matchNode = node as MatchNode;
        const { match, parentFile } = matchNode;
        const res = parentFile.results?.[matchNode.resultIndex];
        const source = res?.source || '';

        return (
            <div
                style={style}
                className="flex items-stretch cursor-pointer relative hover:bg-[var(--vscode-list-hoverBackground)] group bg-[var(--vscode-sideBar-background)]"
                onClick={() => handleResultItemClick(parentFile.absolutePath, { start: match.start, end: match.end })}
                title={getLineFromSource(source, match.start, match.end)}
            >
                {renderIndentationGuides()}

                <div className="pl-4 w-full overflow-hidden min-h-[22px] py-0.5 flex flex-col justify-center" style={{ paddingLeft: `${paddingLeft + 16}px` }}>
                    {currentSearchValues.replace && currentSearchValues.replace.length > 0
                        ? getHighlightedMatchContextWithReplacement(
                            source,
                            match,
                            currentSearchValues?.find,
                            currentSearchValues.replace,
                            currentSearchValues?.searchMode,
                            currentSearchValues?.matchCase,
                            currentSearchValues?.wholeWord,
                            undefined,
                            currentSearchValues?.searchMode === 'regex'
                        )
                        : getHighlightedMatchContext(source, match, undefined, currentSearchValues?.searchMode === 'regex')}
                </div>

                {/* Replace button for individual match */}
                {currentSearchValues.replace && (
                    <div
                        className="absolute right-[5px] top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-200 group-hover:opacity-100 bg-[var(--vscode-list-hoverBackground)]"
                        onClick={(e) => {
                            e.stopPropagation();
                            handleReplace([parentFile.absolutePath]); // TODO: Handle single match replacement if backend supports it
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
        );
    }

    // --- FOLDER RENDERING ---
    if (node.type === 'folder') {
        const hasMatches = node.stats && node.stats.numMatches > 0;

        const getAllFilePathsInFolder = (folder: FolderNode): string[] => {
            // Basic recursive collection - might be expensive if very deep, but necessary for action
            let paths: string[] = [];
            folder.children.forEach(child => {
                if (child.type === 'file') paths.push(child.absolutePath);
                else if (child.type === 'folder') paths = paths.concat(getAllFilePathsInFolder(child as FolderNode));
            });
            return paths;
        };

        return (
            <div
                style={style}
                className={cn(
                    "flex items-center cursor-pointer hover:bg-[var(--vscode-list-hoverBackground)] relative group bg-[var(--vscode-sideBar-background)] select-none overflow-hidden",
                )}
                onClick={(e) => {
                    e.stopPropagation();
                    // Use smart handler if available, otherwise fallback to toggle
                    if (handleFolderClick) handleFolderClick(node.relativePath);
                    else toggleFolderExpansion(node.relativePath);
                }}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
                draggable={true}
                onDragStart={(e) => {
                    e.stopPropagation();
                    if (onDragStart) {
                        const rowWidth = e.currentTarget.offsetWidth;

                        // Create a minimal custom drag preview element
                        const preview = document.createElement('div');
                        preview.style.cssText = `
                            position: fixed;
                            top: -1000px;
                            left: 0;
                            width: ${rowWidth}px;
                            height: 22px;
                            background: var(--vscode-list-hoverBackground, var(--vscode-sideBar-background));
                            color: var(--vscode-foreground);
                            padding: 0 8px;
                            font-size: 13px;
                            font-family: var(--vscode-font-family);
                            display: flex;
                            align-items: center;
                            gap: 6px;
                            pointer-events: none;
                            white-space: nowrap;
                            box-sizing: border-box;
                        `;
                        preview.innerHTML = `<span class="codicon codicon-folder" style="color: var(--vscode-icon-foreground);"></span><span style="font-weight: 600;">${node.name}</span>`;
                        document.body.appendChild(preview);

                        // Use actual mouse position so preview follows where user clicked
                        const rect = e.currentTarget.getBoundingClientRect();
                        const offsetX = e.clientX - rect.left;
                        const offsetY = e.clientY - rect.top;
                        e.dataTransfer.setDragImage(preview, offsetX, offsetY);

                        requestAnimationFrame(() => preview.remove());
                        onDragStart(e, node);
                    }
                }}
                onDragOver={(e) => onDragOver?.(e, node)}
                onDrop={(e) => onDrop?.(e, node)}
                title={node.absolutePath}
            >
                {renderIndentationGuides()}

                {/* Content offset by padding */}
                <div className="flex items-center gap-1.5 flex-grow py-0.5 min-h-[22px]" style={{ paddingLeft: `${paddingLeft + 4}px` }}>
                    <span
                        className={`codicon codicon-chevron-down transition-transform duration-200`}
                        style={{ transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
                        onClick={(e) => {
                            e.stopPropagation();
                            // DIRECT toggle, bypassing the "smart scroll" logic of the row click
                            toggleFolderExpansion(node.relativePath);
                        }}
                    />
                    <span className="codicon codicon-folder text-[var(--vscode-icon-foreground)]" />
                    <span className="font-semibold truncate">{node.name}</span>

                    {/* Stats & Actions */}
                    <div className="flex items-center gap-1 h-full ml-auto pr-2">
                        {hasMatches && node.stats && (
                            <span className="text-[var(--vscode-descriptionForeground)] text-xs whitespace-nowrap opacity-100 group-hover:opacity-100">
                                (<AnimatedCounter value={node.stats.numFilesWithMatches} suffix=" files" />, <AnimatedCounter value={node.stats.numMatches} suffix=" matches" />)
                            </span>
                        )}
                        {/* Actions visible on hover */}
                        {isHovered && hasMatches && currentSearchValues.replace && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleReplace(getAllFilePathsInFolder(node as FolderNode));
                                }}
                                title="Replace all in folder"
                                className="bg-transparent border-none px-0.5 cursor-pointer flex items-center justify-center text-[#bcbbbc] hover:bg-gray-500/20"
                            >
                                <span className="codicon codicon-replace-all" />
                            </button>
                        )}
                        {isHovered && handleExcludeFile && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    getAllFilePathsInFolder(node as FolderNode).forEach(p => handleExcludeFile(p));
                                }}
                                title="Exclude folder"
                                className="bg-transparent border-none px-0.5 cursor-pointer flex items-center justify-center text-[#bcbbbc] hover:bg-gray-500/20 hover:text-[var(--vscode-errorForeground)]"
                            >
                                <span className="codicon codicon-close" />
                            </button>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    // --- FILE RENDERING ---
    // If we are here, it's a file row. 
    // BUT wait: Virtualization usually flattens the file matches too (sub-rows).
    // Or do we keep matches inside the file row (variable height)?
    // FixedSizeList requires fixed height.
    // If we want to show matches *under* the file, we must flatten matches into the list as well!
    // Result: [Folder, File, Match1, Match2, Match3, File2...]

    // HOWEVER: The user might prefer expanding files to push content down.
    // FixedSizeList cannot do that easily (VariableSizeList can, but complex).

    // Alternative: The "File Row" only renders the File Header.
    // If expanded, the "Matches" are separate rows in the flat list.
    // Let's assume `flattenTree` handles matches too? 
    // Or does `flattenTree` only handle Files/Folders, and we accept files don't expand individually 
    // OR we use VariableSizeList?

    // Simpler approach for v1: 
    // Files are rows. If expanded, we unfortunately can't easily insert rows in FixedSizeList dynamically without full re-calc.
    // But `react-window` is fast.
    // So `flattenTree` should basically produce:
    // Row 1: Folder
    // Row 2: File 1
    // Row 3: Match 1 of File 1 (if expanded)
    // Row 4: Match 2 of File 1 (if expanded)

    // To do this, I need to update `virtualizationUtils.ts` to include Match Nodes in the flat list.
    // Let's assume for now I will update `virtualizationUtils` next.
    // This component `TreeViewRow` will handle "Match Node" rendering too if I add it.

    return (
        <div
            style={style}
            className={cn(
                "relative flex items-center cursor-pointer hover:bg-[var(--vscode-list-hoverBackground)] group bg-[var(--vscode-sideBar-background)] select-none",
                isDragOver ? "bg-[var(--vscode-list-dropBackground)]" : ""
            )}
            onClick={() => toggleFileExpansion(node.absolutePath)}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            onDragStart={(e) => {
                e.stopPropagation();
                debugger;

                if (onDragStart) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const offsetX = e.clientX - rect.left;
                    const offsetY = e.clientY - rect.top;
                    e.dataTransfer.setDragImage(e.currentTarget, offsetX, offsetY);
                    onDragStart(e, node);
                }
            }}
            onDragOver={(e) => { onDragOver?.(e, node); handleDragEnter(e); }}
            onDragLeave={handleDragLeave}
            onDrop={handleDropWrapper}
            draggable={true}
            title={node.absolutePath}
        >
            {renderIndentationGuides()}

            <div className="flex items-center gap-1.5 flex-grow py-0.5 min-h-[22px] overflow-hidden" style={{ paddingLeft: `${paddingLeft + 4}px` }}>
                <span
                    className={`codicon codicon-chevron-down transition-transform duration-200`}
                    style={{
                        visibility: (node.results && node.results.reduce((s, r) => s + (r.matches?.length || 0), 0) > 0) ? 'visible' : 'hidden',
                        transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)'
                    }}
                />
                <FileIcon filePath={node.name} />
                <span className="font-bold truncate shrink-0">{node.name}</span>
                {node.description && <span className="text-[var(--vscode-descriptionForeground)] text-xs ml-2 truncate opacity-90">{node.description}</span>}

                <div className="flex items-center gap-1 h-full ml-auto pr-2">
                    {/* Stats */}
                    <span className="text-[var(--vscode-descriptionForeground)] text-xs">
                        {node.results.reduce((s, r) => s + (r.matches?.length || 0), 0)} matches
                    </span>

                    {/* Actions */}
                    {isHovered && currentSearchValues.replace && (
                        <button
                            onClick={(e) => { e.stopPropagation(); handleReplace([node.absolutePath]); }}
                            className="bg-transparent border-none px-0.5 cursor-pointer flex items-center justify-center text-[#bcbbbc] hover:bg-gray-500/20"
                        >
                            <span className="codicon codicon-replace-all" />
                        </button>
                    )}
                    {isHovered && handleExcludeFile && (
                        <button
                            onClick={(e) => { e.stopPropagation(); handleExcludeFile(node.absolutePath); }}
                            className="bg-transparent border-none px-0.5 cursor-pointer flex items-center justify-center text-[#bcbbbc] hover:bg-gray-500/20 hover:text-[var(--vscode-errorForeground)]"
                        >
                            <span className="codicon codicon-close" />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
});
