import React, { useMemo } from 'react';
import { List } from 'react-window';
import { AutoSizer } from 'react-virtualized-auto-sizer';
import { SerializedTransformResultEvent, SearchReplaceViewValues } from '../../model/SearchReplaceViewTypes';
import { TreeViewNode, FileNode } from './TreeView';
import path from 'path-browserify';
import { getHighlightedMatchContext } from './TreeView/highligtedContext';
import { getHighlightedMatchContextWithReplacement } from './TreeView/highlightedContextWithReplacement';
import { getLineFromSource } from './utils';
import { cn } from '../utils';

type SerializedTransformResultEventMatch = NonNullable<SerializedTransformResultEvent['matches']>[number];

interface VirtualizedListViewProps {
    results: Record<string, SerializedTransformResultEvent[]>;
    workspacePath: string | null;
    expandedFiles: Set<string>;
    toggleFileExpansion: (path: string) => void;
    handleFileClick: (path: string) => void;
    handleResultItemClick: (path: string, match: SerializedTransformResultEventMatch) => void;
    handleReplace: (paths: string[]) => void;
    handleExcludeFile: (path: string) => void;
    currentSearchValues: SearchReplaceViewValues;
    sortedFilePaths?: string[];
    animationState?: { type: 'copy' | 'cut' | 'paste' | null, timestamp: number };
}

type FlattenedItem =
    | { type: 'file'; path: string; displayPath: string; results: SerializedTransformResultEvent[] }
    | { type: 'match'; path: string; result: SerializedTransformResultEvent; match: SerializedTransformResultEventMatch };

export const VirtualizedListView: React.FC<VirtualizedListViewProps> = ({
    results,
    workspacePath,
    expandedFiles,
    toggleFileExpansion,
    handleFileClick,
    handleResultItemClick,
    handleReplace,
    handleExcludeFile,
    currentSearchValues,
    sortedFilePaths,
    animationState
}) => {

    const flattenedItems = useMemo(() => {
        const items: FlattenedItem[] = [];
        const paths = sortedFilePaths || Object.keys(results);

        paths.forEach((filePath) => {
            const fileResults = results[filePath];
            if (!fileResults) return;

            let displayPath = filePath;
            if (workspacePath) {
                // Manual relative path calculation to avoid 'process' dependency in browser
                const normalizedWorkspace = workspacePath.replace(/\\/g, '/').replace(/\/$/, '');
                const normalizedFile = filePath.replace(/\\/g, '/');
                if (normalizedFile.startsWith(normalizedWorkspace)) {
                    displayPath = normalizedFile.slice(normalizedWorkspace.length).replace(/^[\\\/]/, '');
                }
            }

            items.push({
                type: 'file',
                path: filePath,
                displayPath: displayPath,
                results: fileResults
            });

            if (expandedFiles.has(filePath)) {
                fileResults.forEach(result => {
                    result.matches?.forEach(match => {
                        items.push({
                            type: 'match',
                            path: filePath,
                            result,
                            match
                        });
                    });
                });
            }
        });
        return items;
    }, [results, expandedFiles, workspacePath, sortedFilePaths]);

    const getItemSize = (index: number) => {
        const item = flattenedItems[index];
        return item.type === 'file' ? 26 : 24; // 24px is h-[22px] + margin/border approx
    };

    const Row = ({ index, style }: { index: number; style: React.CSSProperties }) => {
        const item = flattenedItems[index];

        if (item.type === 'file') {
            const fileNode: FileNode = {
                type: 'file',
                name: item.displayPath,
                relativePath: item.path,
                absolutePath: item.path,
                results: item.results
            };

            return (
                <div style={style}>
                    <TreeViewNode
                        node={fileNode}
                        index={index}
                        level={0}
                        expandedFolders={new Set()}
                        toggleFolderExpansion={() => { }}
                        expandedFiles={expandedFiles}
                        toggleFileExpansion={toggleFileExpansion}
                        handleFileClick={handleFileClick}
                        handleResultItemClick={() => { }} // Not clicked here
                        handleReplace={handleReplace}
                        currentSearchValues={currentSearchValues}
                        handleExcludeFile={handleExcludeFile}
                        renderChildren={false}
                    />
                </div>
            );
        } else {
            // Render Match
            // We need to render JUST the match row, but TreeViewNode renders file wrapper + matches loop.
            // Reusing TreeViewNode for a single match is hard because it loops.
            // So we should construct the Match Row manually here, replicating TreeViewNode's match rendering.

            // Copy styling from TreeViewNode match rendering
            const { result, match, path: filePath } = item;
            const indentSize = 12; // Should match TreeViewNode
            const level = 0; // List view matches have level 1 relative to file (level 0)

            const animationClass = useMemo(() => {
                if (!animationState?.type) return '';
                if (animationState.type === 'copy') return 'animate-copy-pulse';
                if (animationState.type === 'cut') return 'animate-cut-shrink';
                // Paste: new items will animate on mount if we had a way to track "newness", 
                // but since we just re-render, applying it to ALL matches during "paste animation" state creates the effect of "popping in"
                // provided the state is active.
                if (animationState.type === 'paste') return 'animate-paste-expand';
                return '';
            }, [animationState]);

            return (
                <div style={style} className={cn(
                    "flex items-center cursor-pointer h-[24px] hover:bg-[var(--vscode-list-hoverBackground)] group",
                    animationClass
                )}
                    onClick={() => handleResultItemClick(filePath, match)}
                    title={getLineFromSource(result.source, match.start, match.end)}
                >
                    {/* Indentation for match: level 0 file -> level 1 match */}
                    {/* Actually TreeViewNode adds guides. We can manual add one spacer for match indentation */}
                    <div
                        className="h-full border-r border-r-[var(--vscode-tree-indentGuidesStroke)]"
                        style={{ width: `${indentSize}px`, minWidth: `${indentSize}px` }}
                    />

                    <div className="pl-4 w-full truncate relative">
                        {currentSearchValues.replace && currentSearchValues.replace.length > 0
                            ? getHighlightedMatchContextWithReplacement(
                                result.source,
                                match,
                                currentSearchValues.find,
                                currentSearchValues.replace,
                                currentSearchValues.searchMode,
                                currentSearchValues.matchCase,
                                currentSearchValues.wholeWord,
                                undefined,
                                currentSearchValues.searchMode === 'regex'
                            )
                            : getHighlightedMatchContext(result.source, match, undefined, currentSearchValues.searchMode === 'regex')}

                        {currentSearchValues.replace && (
                            <div className="absolute right-[5px] top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                                onClick={(e) => { e.stopPropagation(); handleReplace([filePath]); }}>
                                <button className="bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] border-none rounded-[2px] cursor-pointer px-[6px] py-[2px] text-xs hover:bg-[var(--vscode-button-hoverBackground)]" title="Replace this match">
                                    <span className="codicon codicon-replace-all" />
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            );
        }
    };

    return (
        <div style={{ flex: '1 1 auto', height: '100%' }}>
            <div style={{ flex: '1 1 auto', height: '100%' }}>
                <AutoSizer renderProp={({ height, width }: { height?: number; width?: number }) => (
                    <List
                        style={{ height: height ?? 0, width: width ?? 0, overflowX: 'hidden' }}
                        rowCount={flattenedItems.length}
                        rowHeight={getItemSize}
                        rowComponent={Row}
                        rowProps={{} as any}
                    />
                )} />
            </div>
        </div>
    );
};

