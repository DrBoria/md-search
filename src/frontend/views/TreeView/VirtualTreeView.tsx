import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { FileTreeNode } from './index';
import { TreeViewRow } from './TreeViewRow';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { createVirtualListAnimatePlugin } from './animations';
import { flattenList } from './virtualizationUtils';
import { SearchReplaceViewValues } from '../../../model/SearchReplaceViewTypes';


interface VirtualTreeViewProps {
    fileTree: FileTreeNode[];
    expandedFolders: Set<string>;
    toggleFolderExpansion: (path: string) => void;
    expandedFiles: Set<string>;
    toggleFileExpansion: (path: string) => void;
    handleFileClick: (path: string) => void;
    handleResultItemClick: (path: string, range?: { start: number; end: number }) => void;
    handleReplace: (paths: string[]) => void;
    handleExcludeFile?: (path: string) => void;
    currentSearchValues: SearchReplaceViewValues;
    onDragStart?: (e: React.DragEvent, node: FileTreeNode) => void;
    onDragOver?: (e: React.DragEvent, node: FileTreeNode) => void;
    onDrop?: (e: React.DragEvent, node: FileTreeNode) => void;
}

export const VirtualTreeView: React.FC<VirtualTreeViewProps> = ({
    fileTree,
    expandedFolders,
    toggleFolderExpansion,
    expandedFiles,
    toggleFileExpansion,
    handleFileClick,
    handleResultItemClick,
    handleReplace,
    handleExcludeFile,
    currentSearchValues,
    onDragStart,
    onDragOver,
    onDrop
}) => {
    // Constants
    const ROW_HEIGHT = 22;
    const OVERSCAN = 10;

    // Data - Memoize the flat list
    const flatNodes = useMemo(() =>
        flattenList(fileTree, expandedFolders, expandedFiles),
        [fileTree, expandedFolders, expandedFiles]
    );

    // Variable Height Metadata
    interface ItemMetadata {
        index: number;
        offset: number;
        size: number;
    }

    const { metadata, totalHeight } = useMemo(() => {
        const meta: ItemMetadata[] = [];
        let currentOffset = 0;
        const isRegex = currentSearchValues.searchMode === 'regex';

        flatNodes.forEach((node, index) => {
            let size = ROW_HEIGHT; // Default

            // Variable height for Regex Matches
            if (isRegex && (node.node as any).type === 'match') {
                const matchNode = node.node as any;
                const { match, parentFile } = matchNode;

                if (match && parentFile && parentFile.results) {
                    // Find the result that contains this match
                    const result = parentFile.results[matchNode.resultIndex];
                    if (result && result.source) {
                        const start = match.start;
                        const end = match.end;
                        const text = result.source.slice(start, end);
                        // Count newlines. 1 line = 0 newlines.
                        const lineCount = (text.match(/\n/g) || []).length + 1;

                        // Tighter line height for code (text-xs is approx 16px)
                        // Add padding for container (my-1 = 8px, plus borders)
                        const CODE_LINE_HEIGHT = 16;
                        const PADDING_V = 8;

                        let calculatedHeight = (lineCount * CODE_LINE_HEIGHT) + PADDING_V;

                        // Add extra height for replacement preview if it exists
                        if (currentSearchValues.replace) {
                            const REPLACEMENT_HEIGHT = 26; // approx height for replace badge
                            calculatedHeight += REPLACEMENT_HEIGHT;
                        }

                        size = Math.max(ROW_HEIGHT, calculatedHeight);
                    }
                }
            }

            meta.push({
                index,
                offset: currentOffset,
                size
            });
            currentOffset += size;
        });

        return { metadata: meta, totalHeight: currentOffset };
    }, [flatNodes, currentSearchValues.searchMode, currentSearchValues.replace]);

    // State
    const [scrollTop, setScrollTop] = useState(0);
    const [containerHeight, setContainerHeight] = useState(500); // Initial guess
    const containerRef = useRef<HTMLDivElement>(null);
    const isScrollingRef = useRef(false);
    const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Animations - use extracted plugin from animations.ts
    // We use a ref to track drag state to avoid re-rendering the tree while dragging
    // and to gate the animation plugin synchronously.
    // We use a specific plugin to only animate reorders (moves) and ignore add/remove.
    const [animationParent] = useAutoAnimate(createVirtualListAnimatePlugin(isScrollingRef));

    // We conditionally attach the animation ref ONLY when dragging.
    // This ensures ZERO overhead/glitches during normal scrolling.
    const [isDragActive, setIsDragActive] = useState(false);

    useEffect(() => {
        const handleDragEnd = () => {
            // Delay disabling animations to allow the Drop reorder (FLIP) to initialize
            setTimeout(() => {
                setIsDragActive(false);
            }, 400);
        };

        window.addEventListener('dragend', handleDragEnd);
        window.addEventListener('drop', handleDragEnd);

        return () => {
            window.removeEventListener('dragend', handleDragEnd);
            window.removeEventListener('drop', handleDragEnd);
        };
    }, []);

    const handleNodeDragStart = (e: React.DragEvent, node: FileTreeNode) => {
        setIsDragActive(true);
        onDragStart?.(e, node);
    };


    // Resize Observer to handle container size changes
    useEffect(() => {
        if (!containerRef.current) return;

        const observer = new ResizeObserver(entries => {
            for (const entry of entries) {
                if (entry.contentRect.height > 0) {
                    setContainerHeight(entry.contentRect.height);
                }
            }
        });

        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, []);

    // Scroll Handler
    const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
        // Set scrolling flag
        isScrollingRef.current = true;
        if (scrollTimeoutRef.current) {
            clearTimeout(scrollTimeoutRef.current);
        }
        scrollTimeoutRef.current = setTimeout(() => {
            isScrollingRef.current = false;
        }, 150);

        const newScrollTop = e.currentTarget.scrollTop;
        setScrollTop(newScrollTop);
    };

    // Explicit Scroll Forwarding for Sticky Header
    const handleStickyWheel = (e: React.WheelEvent) => {
        if (containerRef.current) {
            containerRef.current.scrollTop += e.deltaY;
        }
    };

    // Binary Search
    const findStartIndex = (offset: number) => {
        let low = 0;
        let high = metadata.length - 1;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const item = metadata[mid];

            if (item.offset <= offset && item.offset + item.size > offset) {
                return mid;
            } else if (item.offset < offset) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return Math.max(0, Math.min(low, metadata.length - 1));
    };

    // Virtualization Calculations
    const exactStartIndex = findStartIndex(scrollTop);
    const startIndex = Math.max(0, exactStartIndex - OVERSCAN);

    const scrollBottom = scrollTop + containerHeight;
    const exactEndIndex = findStartIndex(scrollBottom);
    const endIndex = Math.min(metadata.length, exactEndIndex + OVERSCAN + 1);

    const visibleNodes = flatNodes.slice(startIndex, endIndex);

    const paddingTop = metadata.length > 0 ? metadata[startIndex].offset : 0;
    const paddingBottom = metadata.length > 0 && endIndex > 0
        ? totalHeight - (metadata[endIndex - 1].offset + metadata[endIndex - 1].size)
        : 0;


    // Sticky Header Calculation - Collision Resolved
    const stickyHeaderItems = useMemo(() => {
        const visibleStartIndex = exactStartIndex;

        if (visibleStartIndex < 0 || visibleStartIndex >= flatNodes.length) return [];

        const naiveNode = flatNodes[visibleStartIndex];
        const naiveTop = metadata[visibleStartIndex].offset - scrollTop;

        // Pre-Scan: Identify Files with Visible Content (Matches).
        const activeFilePaths = new Set<string>();
        for (const node of visibleNodes) {
            const raw = node.node as any;
            if (raw.type === 'match' && raw.parentFile) {
                activeFilePaths.add(raw.parentFile.absolutePath);
            }
        }

        // 1. Context Identification (Primary Sticky Set)
        // We do basic detection. If overlap at top, we might need normalization.
        // But mainly we rely on "Context Normalization" to select the right stack base.

        let invaderAtTop: any = null; // Legacy support for normalization trigger
        if (visibleStartIndex > 0) {
            const prevIndex = visibleStartIndex - 1;
            const prevNode = flatNodes[prevIndex];
            const prevStackHeight = prevNode.depth * ROW_HEIGHT;
            const isChild = naiveNode.depth > prevNode.depth;

            // Use exact naïve top from metadata
            if (naiveTop < prevStackHeight && !isChild && naiveTop > 0) {
                invaderAtTop = naiveNode;
            }
        }

        // 2. Build Sticky List
        let effectiveContextIndex = (invaderAtTop) ? (visibleStartIndex - 1) : visibleStartIndex;
        let contextNode = flatNodes[effectiveContextIndex];

        // Normalization I: Inactive File Drop
        if (contextNode) {
            const rawCtx = contextNode.node as any;
            if (rawCtx.type === 'file' && !activeFilePaths.has(rawCtx.absolutePath)) {
                for (let k = effectiveContextIndex - 1; k >= 0; k--) {
                    if (flatNodes[k].depth < contextNode.depth) {
                        effectiveContextIndex = k;
                        contextNode = flatNodes[k];
                        break;
                    }
                }
            }
        }

        // Normalization II: Sibling/Deep Replacement (Invader Priority)
        if (invaderAtTop && contextNode) {
            let candidate = contextNode;
            let candidateIndex = effectiveContextIndex;

            while (candidate.depth >= invaderAtTop.depth && candidateIndex > 0) {
                let foundParent = false;
                for (let k = candidateIndex - 1; k >= 0; k--) {
                    if (flatNodes[k].depth < candidate.depth) {
                        candidateIndex = k;
                        candidate = flatNodes[k];
                        foundParent = true;
                        break;
                    }
                }
                if (!foundParent) break;
            }
            contextNode = candidate;
            effectiveContextIndex = candidateIndex;
        }

        if (!contextNode) return [];

        // Collect Ancestors
        const ancestorItems: { node: any, index: number }[] = [];
        const isContextMatch = (contextNode.node as any).type === 'match';
        if (!isContextMatch) {
            ancestorItems.unshift({ node: contextNode, index: effectiveContextIndex });
        }

        let currentDepth = contextNode.depth;
        for (let i = effectiveContextIndex - 1; i >= 0; i--) {
            const node = flatNodes[i];
            const isMatch = (node.node as any).type === 'match';
            if (node.depth < currentDepth && !isMatch) {
                ancestorItems.unshift({ node: node, index: i });
                currentDepth = node.depth;
                if (currentDepth === 0) break;
            }
        }

        // Collect Pinned Visible Items
        const pageSize = Math.ceil(containerHeight / ROW_HEIGHT) + 2;
        const endScan = Math.min(flatNodes.length, visibleStartIndex + pageSize);
        const pinnedItems: { node: any, index: number }[] = [];

        for (let i = visibleStartIndex; i < endScan; i++) {
            const node = flatNodes[i];
            const raw = node.node as any;
            const isMatch = raw.type === 'match';
            const isFile = raw.type === 'file';

            if (!isMatch) {
                if (isFile && !activeFilePaths.has(raw.absolutePath)) {
                    continue;
                }
                const naturalTop = metadata[i].offset - scrollTop;
                const staticTop = node.depth * ROW_HEIGHT;
                if (naturalTop <= staticTop + 1) {
                    pinnedItems.push({ node: node, index: i });
                }
            }
        }

        // Merge
        const combined = new Map<number, { node: any, index: number }>();
        ancestorItems.forEach(item => combined.set(item.index, item));
        pinnedItems.forEach(item => combined.set(item.index, item));
        const sortedItems = Array.from(combined.values()).sort((a, b) => a.index - b.index);

        interface ProcessedItem { node: any, index: number, currentTop: number };

        let processedItems: ProcessedItem[] = sortedItems.map(item => {
            const staticTop = item.node.depth * ROW_HEIGHT;
            const naturalTop = metadata[item.index].offset - scrollTop;
            const initialTop = Math.max(staticTop, naturalTop);
            return {
                ...item,
                currentTop: initialTop
            };
        });

        // 3. Robust Collision Resolution (Multi-Pusher)
        // Scan visible nodes for potential pushers
        processedItems.forEach(victim => {
            const victimDepth = victim.node.depth;
            const victimBottom = victim.currentTop + ROW_HEIGHT;

            for (let i = 0; i < visibleNodes.length; i++) {
                const node = visibleNodes[i];
                const realIndex = startIndex + i;
                // Wait, visibleNodes is slice.

                if (realIndex >= metadata.length) continue;

                const meta = metadata[realIndex];

                // Pusher must be visually BELOW (or AT) the victim
                if (realIndex <= victim.index) continue;

                const nodeTop = meta.offset - scrollTop;

                // Push condition: Overlap + Rank
                if (node.depth <= victimDepth) {
                    if (nodeTop < victimBottom) {
                        // Detected physical overlap with a stronger node.
                        // Force Victim to retract.
                        const pushLimit = nodeTop - ROW_HEIGHT;
                        if (victim.currentTop > pushLimit) {
                            victim.currentTop = pushLimit;
                        }
                    }
                }
            }
        });

        // 3c. Cascade Folding (Top-Down Parent Drag)
        for (let i = 0; i < processedItems.length; i++) {
            const item = processedItems[i];

            let parentItem: ProcessedItem | null = null;
            for (let k = i - 1; k >= 0; k--) {
                if (processedItems[k].node.depth < item.node.depth) {
                    parentItem = processedItems[k];
                    break;
                }
            }

            if (parentItem) {
                const depthDiff = item.node.depth - parentItem.node.depth;
                const maxAllowedTop = parentItem.currentTop + (depthDiff * ROW_HEIGHT);

                if (item.currentTop > maxAllowedTop) {
                    item.currentTop = maxAllowedTop;
                }
            }
        }

        // 4. Map to Render
        return processedItems
            .map((item) => {
                return {
                    node: item.node,
                    depth: item.node.depth,
                    top: item.currentTop,
                    zIndex: 100 - item.node.depth
                };
            });

    }, [scrollTop, flatNodes, containerHeight, startIndex, visibleNodes, metadata, exactStartIndex]);

    // Intercept Folder Click for Scroll-to-Top behavior
    const handleFolderClick = (path: string) => {
        const isExpanded = expandedFolders.has(path);
        if (isExpanded) {
            // Find index of this folder
            const index = flatNodes.findIndex(n => (n.node as any).relativePath === path);
            if (index !== -1) {
                // Check if it is at the top
                const currentScrollTop = containerRef.current?.scrollTop || 0;
                const targetScrollTop = index * ROW_HEIGHT;

                // Allow some tolerance (e.g. 5px)
                if (Math.abs(currentScrollTop - targetScrollTop) > 5) {
                    // It is NOT at the top -> Scroll to it
                    // Calculate "Sticky Offset": How many parents are sticky?
                    // We can estimate depth * ROW_HEIGHT.
                    const depth = flatNodes[index].depth;
                    const stickyOffset = depth * ROW_HEIGHT;

                    const adjustedScrollTop = Math.max(0, targetScrollTop - stickyOffset);

                    containerRef.current?.scrollTo({ top: adjustedScrollTop, behavior: 'smooth' });
                    return; // Do NOT close
                }
            }
        }
        // If closed, or already at top -> Toggle (Close/Open)
        toggleFolderExpansion(path);
    };

    return (
        <div className="relative flex-grow w-full h-full overflow-hidden">
            {/* Sticky Header Overlay */}
            <div
                className="absolute top-0 left-0 w-full z-20 pointer-events-none"
                onWheel={handleStickyWheel}
            >
                {/* Headers themselves must capture events to be clickable, but should not block scroll. 
                    pointer-events: auto on children overrides parent none. 
                    Wheel event on children will bubble to this parent. */}
                {stickyHeaderItems.map((item: any, index: number) => {
                    const isLast = index === stickyHeaderItems.length - 1;
                    return (
                        <div
                            key={`sticky-${item.node.node.relativePath || item.node.node.absolutePath}-${item.top}`}
                            className="absolute left-0 w-full shadow-sm pointer-events-auto"
                            style={{
                                height: ROW_HEIGHT,
                                top: item.top,
                                zIndex: item.zIndex
                            }}
                        >
                            <TreeViewRow
                                node={item.node.node}
                                depth={item.node.depth}
                                style={{ height: ROW_HEIGHT, width: '100%' }}
                                expandedFolders={expandedFolders}
                                toggleFolderExpansion={toggleFolderExpansion}
                                handleFolderClick={handleFolderClick}
                                expandedFiles={expandedFiles}
                                toggleFileExpansion={toggleFileExpansion}
                                handleFileClick={handleFileClick}
                                handleResultItemClick={handleResultItemClick}
                                handleReplace={handleReplace}
                                handleExcludeFile={handleExcludeFile}
                                currentSearchValues={currentSearchValues}
                                onDragStart={handleNodeDragStart}
                                onDragOver={onDragOver}
                                onDrop={onDrop}
                                isSticky={true}
                            />
                            {isLast && (
                                <div className="absolute bottom-0 left-0 w-full h-[1px] bg-[var(--vscode-tree-tableColumnsBorder)]" />
                            )}
                        </div>
                    )
                })}
            </div>

            <div
                ref={containerRef}
                onScroll={handleScroll}
                className="w-full h-full overflow-y-auto overflow-x-hidden relative will-change-transform"
                style={{
                    width: '100%',
                    height: '100%'
                }}
            >
                <div key="top-spacer" style={{ height: paddingTop, width: '100%', flexShrink: 0 }} />

                <div
                    ref={isDragActive ? animationParent : null}
                    className="flex flex-col w-full relative"
                >
                    {visibleNodes.map((flatNode, i) => {
                        const node = flatNode.node as any;
                        let key = node.absolutePath || node.relativePath;
                        if (!key && node.type === 'match') {
                            // Stable key for match nodes
                            key = `${node.parentFile.absolutePath}-match-${node.resultIndex}-${node.matchIndex}`;
                        }
                        if (!key) {
                            key = `node-${Math.random()}`; // Fallback should ideally never be reached
                        }

                        const metaIndex = startIndex + i;
                        const meta = metadata[metaIndex];
                        const height = meta ? meta.size : ROW_HEIGHT;

                        return (
                            <div
                                key={key}
                                style={{
                                    height: height,
                                    width: '100%',
                                }}
                            >
                                <TreeViewRow
                                    node={node}
                                    depth={flatNode.depth}
                                    style={{ height: height, width: '100%' }}
                                    expandedFolders={expandedFolders}
                                    toggleFolderExpansion={toggleFolderExpansion}
                                    isDragActive={isDragActive}
                                    // handleFolderClick -- REMOVED for regular items, forcing default toggle behavior
                                    expandedFiles={expandedFiles}
                                    toggleFileExpansion={toggleFileExpansion}
                                    handleFileClick={handleFileClick}
                                    handleResultItemClick={handleResultItemClick}
                                    handleReplace={handleReplace}
                                    handleExcludeFile={handleExcludeFile}
                                    currentSearchValues={currentSearchValues}
                                    onDragStart={handleNodeDragStart}
                                    onDragOver={onDragOver}
                                    onDrop={onDrop}
                                />
                            </div>
                        );
                    })}
                </div>

                <div key="bottom-spacer" style={{ height: paddingBottom, width: '100%', flexShrink: 0 }} />
            </div>
        </div>
    );
};
