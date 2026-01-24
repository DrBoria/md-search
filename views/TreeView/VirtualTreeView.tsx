import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { FileTreeNode } from './index';
import { TreeViewRow } from './TreeViewRow';
import { flattenList } from './virtualizationUtils';
import { SearchReplaceViewValues } from '../../../model/SearchReplaceViewTypes';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { createVirtualListAnimatePlugin } from './animations';

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

    // State
    const [scrollTop, setScrollTop] = useState(0);
    const [containerHeight, setContainerHeight] = useState(500); // Initial guess
    const containerRef = useRef<HTMLDivElement>(null);

    // Animations - use extracted plugin from animations.ts
    const autoAnimatePlugin = useCallback(createVirtualListAnimatePlugin(), []);

    const [listParent, enableAnimations] = useAutoAnimate<HTMLDivElement>(autoAnimatePlugin);
    const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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
        const newScrollTop = e.currentTarget.scrollTop;
        setScrollTop(newScrollTop);

        // Disable animations while scrolling to prevent chaos
        enableAnimations(false);

        // Re-enable animations after scroll stops
        if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
        scrollTimeoutRef.current = setTimeout(() => {
            enableAnimations(true);
        }, 150);
    };

    // Virtualization Calculations
    const totalCount = flatNodes.length;
    const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const endIndex = Math.min(totalCount, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN);

    const visibleNodes = flatNodes.slice(startIndex, endIndex);

    const paddingTop = startIndex * ROW_HEIGHT;
    const paddingBottom = Math.max(0, (totalCount - endIndex) * ROW_HEIGHT);

    // Sticky Header Calculation - Stacked
    const stickyNodes = useMemo(() => {
        if (startIndex === 0 || !flatNodes[startIndex] || flatNodes.length === 0) return []; // No sticky header if at top

        const currentFirstNode = flatNodes[startIndex].node as any;
        // Robustly determine the path of the current visible item (for strict ancestry check)
        const currentData = currentFirstNode.type === 'match' ? currentFirstNode.parentFile : currentFirstNode;
        const currentAbsPath = currentData.absolutePath || '';
        const currentRelPath = currentData.relativePath || '';

        const potentialParents: any[] = [];
        let minDepthFound = flatNodes[startIndex].depth;

        // Search backwards to find the chain of parents
        for (let i = startIndex - 1; i >= 0; i--) {
            const flatNode = flatNodes[i];
            const node = flatNode.node as any;

            // Check strictly for ancestry to prevent "cousin" folders from appearing
            if (node.type === 'folder' && expandedFolders.has(node.relativePath)) {
                // Hybrid Check: Absolute preferred, Relative fallback
                const parentAbsPath = node.absolutePath || '';
                const parentRelPath = node.relativePath || '';

                let isAncestor = false;

                if (currentAbsPath && parentAbsPath) {
                    const sep = currentAbsPath.includes('\\') ? '\\' : '/';
                    isAncestor = currentAbsPath.startsWith(parentAbsPath + sep);
                } else if (currentRelPath && parentRelPath) {
                    // Ensure we don't match "src/auth" -> "src/authen"
                    // Add separator check if not root
                    const sep = '/';
                    isAncestor = currentRelPath.startsWith(parentRelPath + sep);
                }

                if (isAncestor && flatNode.depth < minDepthFound) {
                    potentialParents.unshift(flatNode); // Add to beginning (Top -> Down order)
                    minDepthFound = flatNode.depth; // Next parent must be strictly shallower

                    if (minDepthFound === 0) break; // Reached root
                }
            }
        }
        return potentialParents;
    }, [startIndex, flatNodes, expandedFolders]);

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
            {/* Sticky Header Overlay - MOVED OUTSIDE SCROLL CONTAINER */}
            <div className="absolute top-0 left-0 w-full z-20 pointer-events-none">
                {/* Pointer events none by default, but children (headers) need pointer-events-auto */}
                {stickyNodes.map((stickyNode: any, i) => (
                    <div
                        key={`sticky-${stickyNode.node.relativePath}`}
                        className="w-full shadow-sm pointer-events-auto"
                        style={{
                            height: ROW_HEIGHT,
                            // Static position! 
                        }}
                    >
                        <TreeViewRow
                            node={stickyNode.node}
                            depth={stickyNode.depth}
                            style={{ height: ROW_HEIGHT, width: '100%' }}
                            expandedFolders={expandedFolders}
                            toggleFolderExpansion={toggleFolderExpansion} // Stickies always toggle on click? Or should strictly follow new logic?
                            // Actually, Stickies are just proxies.
                            // Logic: If I click sticky header name -> Scroll to it (it's already at top... so close?)
                            // Yes, if I click sticky header name, it should close if open.
                            handleFolderClick={handleFolderClick}
                            expandedFiles={expandedFiles}
                            toggleFileExpansion={toggleFileExpansion}
                            handleFileClick={handleFileClick}
                            handleResultItemClick={handleResultItemClick}
                            handleReplace={handleReplace}
                            handleExcludeFile={handleExcludeFile}
                            currentSearchValues={currentSearchValues}
                            onDragStart={onDragStart}
                            onDragOver={onDragOver}
                            onDrop={onDrop}
                        />
                        <div className="absolute bottom-0 left-0 w-full h-[1px] bg-[var(--vscode-tree-tableColumnsBorder)]" />
                    </div>
                ))}
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
                {/* Top Spacer */}
                <div key="top-spacer" style={{ height: paddingTop, width: '100%', flexShrink: 0 }} />

                {/* Content Container - Animated */}
                <div ref={listParent} className="flex flex-col w-full relative">
                    {visibleNodes.map((flatNode) => {
                        const node = flatNode.node as any;
                        // Use absolute path or relative path or constructed ID as key
                        let uniqueKey = node.absolutePath || node.relativePath;

                        if (node.type === 'match') {
                            // Matches don't have absolutePath on their own, but have parentFile
                            uniqueKey = `${node.parentFile.absolutePath}-match-${node.match?.start}-${node.match?.end}`;
                        }

                        if (!uniqueKey) {
                            uniqueKey = `node-${flatNode.index}`;
                        }

                        return (
                            <TreeViewRow
                                key={uniqueKey}
                                node={flatNode.node}
                                depth={flatNode.depth}
                                style={{
                                    height: ROW_HEIGHT,
                                    width: '100%',
                                    boxSizing: 'border-box'
                                }}
                                expandedFolders={expandedFolders}
                                toggleFolderExpansion={toggleFolderExpansion} // Pass Raw Toggle
                                handleFolderClick={handleFolderClick} // Pass Smart Click
                                expandedFiles={expandedFiles}
                                toggleFileExpansion={toggleFileExpansion}
                                handleFileClick={handleFileClick}
                                handleResultItemClick={handleResultItemClick}
                                handleReplace={handleReplace}
                                handleExcludeFile={handleExcludeFile}
                                currentSearchValues={currentSearchValues}
                                onDragStart={onDragStart}
                                onDragOver={onDragOver}
                                onDrop={onDrop}
                            />
                        );
                    })}
                </div>

                {/* Bottom Spacer */}
                <div key="bottom-spacer" style={{ height: paddingBottom, width: '100%', flexShrink: 0 }} />
            </div>
        </div>
    );
};
