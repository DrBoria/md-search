
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';

import { cn } from '../utils';
import { SearchInputSection } from './SearchInputSection';
import SearchNestedView from './SearchNestedView';
import { Button } from '../components/ui/button';
import { FindInFoundButton } from './components/FindInFoundButton';
import { SearchGlobalProvider, useSearchGlobal } from './context/SearchGlobalContext';
import { SearchItemProvider, useSearchItemController } from './context/SearchItemContext';
import { MessageFromWebview, MessageToWebview, SerializedTransformResultEvent, SearchLevel } from '../../model/SearchReplaceViewTypes';
import { URI } from 'vscode-uri';
import * as path from 'path-browserify';
import { FileTreeNode, FileNode, FolderNode } from './TreeView';
import { VirtualTreeView } from './TreeView/VirtualTreeView';

import { AnimatedCounter } from './components/AnimatedCounter';
import { NotificationBanner } from './components/NotificationBanner';

// --- Interfaces ---

interface SearchReplaceViewProps {
    vscode: {
        postMessage(message: MessageFromWebview): void;
        getState(): { [key: string]: any } | undefined;
        setState(newState: { [key: string]: any }): void;
    };
}



// --- Helper Functions ---

function uriToPath(uriString: string | undefined): string {
    if (!uriString) return '';
    try {
        const uri = URI.parse(uriString);
        if (uri.scheme === 'file') {
            return uri.fsPath;
        }
        return uriString;
    } catch (e) {
        return uriString;
    }
}

function buildFileTree(
    resultsByFile: Record<string, SerializedTransformResultEvent[]>,
    workspacePathUri: string,
    customOrder?: { [key: string]: number },
): FolderNode {
    const workspacePath = uriToPath(workspacePathUri);
    const root: FolderNode = { name: '', relativePath: '', type: 'folder', absolutePath: workspacePath || '', children: [], stats: { numMatches: 0, numFilesWithMatches: 0 } };

    const findOrCreateFolder = (
        parent: FolderNode,
        segment: string,
        currentRelativePath: string
    ): FolderNode => {
        const existing = parent.children?.find(
            (child) => child.type === 'folder' && child.name === segment
        ) as FolderNode | undefined;
        if (existing) {
            return existing;
        }

        const safeAbsolutePath = parent.absolutePath && !parent.absolutePath.endsWith('/')
            ? `${parent.absolutePath}/${segment}`
            : `${parent.absolutePath}${segment}`;

        const newFolder: FolderNode = {
            name: segment,
            relativePath: currentRelativePath,
            type: 'folder',
            absolutePath: safeAbsolutePath, // Store absolute path
            children: [],
            stats: { numMatches: 0, numFilesWithMatches: 0 }
        };
        parent.children.push(newFolder);
        return newFolder;
    };

    Object.entries(resultsByFile).forEach(([absoluteFilePathOrUri, fileResults]) => {
        const absoluteFilePath = uriToPath(absoluteFilePathOrUri);
        const displayPath = workspacePath
            ? path.relative(workspacePath, absoluteFilePath)
            : absoluteFilePath;

        const posixDisplayPath = displayPath.replace(/\\/g, '/');
        const segments = posixDisplayPath.split('/').filter(Boolean);
        let currentNode = root;
        let currentRelativePath = '';

        const fileMatches = fileResults?.length > 0 && fileResults[0]?.matches
            ? fileResults.reduce((sum, r) => sum + (r.matches?.length || 0), 0)
            : 0;
        const hasMatches = fileMatches > 0;

        if (hasMatches) {
            root.stats!.numMatches += fileMatches;
            root.stats!.numFilesWithMatches += 1;
        }

        segments.forEach((segment, index) => {
            currentRelativePath = currentRelativePath ? path.posix.join(currentRelativePath, segment) : segment;
            if (index === segments.length - 1) {
                const fileNode: FileNode = {
                    name: path.basename(absoluteFilePath),
                    relativePath: posixDisplayPath,
                    absolutePath: absoluteFilePathOrUri,
                    type: 'file',
                    results: fileResults
                };
                currentNode.children.push(fileNode);
            } else {
                currentNode = findOrCreateFolder(currentNode, segment, currentRelativePath);
                if (hasMatches) {
                    currentNode.stats!.numMatches += fileMatches;
                    currentNode.stats!.numFilesWithMatches += 1;
                }
            }
        });
    });

    if (customOrder) {
        const sortNodeChildren = (node: FolderNode) => {
            node.children.sort((a, b) => {
                const aPath = (a as any).absolutePath || a.relativePath;
                const bPath = (b as any).absolutePath || b.relativePath;
                const aOrder = customOrder[aPath] ?? 999999;
                const bOrder = customOrder[bPath] ?? 999999;

                if (aOrder !== bOrder) {
                    return aOrder - bOrder;
                }
                if (a.type !== b.type) {
                    return a.type === 'folder' ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            });
            node.children.forEach(child => {
                if (child.type === 'folder') {
                    sortNodeChildren(child);
                }
            });
        };
        sortNodeChildren(root);
    } else {
        const sortNodeChildren = (node: FolderNode) => {
            node.children.sort((a, b) => {
                if (a.type !== b.type) {
                    return a.type === 'folder' ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            });
            node.children.forEach(child => {
                if (child.type === 'folder') {
                    sortNodeChildren(child);
                }
            });
        };
        sortNodeChildren(root);
    }

    return root;
}

function filterTreeForMatches(node: FileTreeNode): FileTreeNode | null {
    if (node.type === 'file') {
        const hasMatches = node.results.some(r => r.matches && r.matches.length > 0);
        return hasMatches ? node : null;
    } else {
        const filteredChildren = node.children
            .map(filterTreeForMatches)
            .filter(Boolean) as FileTreeNode[];

        if (filteredChildren.length > 0) {
            const stats = {
                numMatches: 0,
                numFilesWithMatches: 0
            };
            filteredChildren.forEach(child => {
                if (child.type === 'folder' && child.stats) {
                    stats.numMatches += child.stats.numMatches;
                    stats.numFilesWithMatches += child.stats.numFilesWithMatches;
                } else if (child.type === 'file') {
                    const fileMatches = child.results && child.results.length > 0
                        ? child.results.reduce((sum, r) => sum + (r.matches?.length || 0), 0)
                        : 0;
                    stats.numMatches += fileMatches;
                    if (fileMatches > 0) {
                        stats.numFilesWithMatches += 1;
                    }
                }
            });
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

// --- Tree View Component ---



// --- Styles & Keyframes ---
// Moved outside to avoid re-creation

const RootSearchSection = () => {
    const searchInputRef = useRef<HTMLTextAreaElement>(null);

    const {
        values,
        setSearchLevels,
        postValuesChange,
        status,
        vscode,
        resultsByFile,
        staleResultsByFile,
        staleLevel,
        valuesRef,
        setValues,
        customFileOrder, // Added
        setCustomFileOrder, // Added
        setResultsByFile // Need setter to remove items on Cut
    } = useSearchGlobal();

    // -- Clipboard Overlay State --
    const [feedbackState, setFeedbackState] = useState<{
        visible: boolean;
        message: string;
        subMessage?: string;
        type: 'copy' | 'cut' | 'paste' | 'info';
    }>({ visible: false, message: '', type: 'info' });

    const showFeedback = useCallback((message: string, subMessage: string | undefined, type: 'copy' | 'cut' | 'paste' | 'info') => {
        setFeedbackState({ visible: true, message, subMessage, type });
    }, []);

    // -- Handlers --

    // -- Keybindings moved to SearchReplaceViewLayout / SearchReplaceViewInner to access sortedFilePaths --


    const handleFindInFound = useCallback(() => {
        // Read from ref to get the LATEST values, not stale closure values
        const currentValues = valuesRef.current;
        // ... (rest of logic same) ...
        const currentSearchInResults = currentValues.searchInResults; // captured for closure if needed, but safer to use valuesRef or updater

        console.log('=== handleFindInFound START ===');
        console.log('Current values.searchInResults:', currentValues.searchInResults);
        console.log('Current values.find:', currentValues.find);

        // ... (omitting huge block logs for brevity in replacement if possible, but ReplaceFileContent replaces exact block)
        // I will just copy the existing Logic since I am replacing the surrounding block.

        // Create new level
        setSearchLevels(prev => {
            // ... existing logic ...
            const currentLevel = prev[currentValues.searchInResults];
            if (!currentLevel) {
                return prev;
            }

            // Sync the current global values.find into this level before transitioning
            const currentLevelWithStats = {
                ...currentLevel,
                values: { ...currentLevel.values, find: currentValues.find },
                stats: { numMatches: status.numMatches, numFilesWithMatches: status.numFilesWithMatches },
                label: currentValues.find || currentLevel.label || 'Root'
            };

            const updatedLevels = [...prev];
            updatedLevels[currentValues.searchInResults] = currentLevelWithStats;

            const newLevel: SearchLevel = {
                values: { ...currentValues, find: '', replace: '', matchCase: false, wholeWord: false, searchMode: 'text' },
                viewMode: 'tree',
                resultsByFile: {},
                matchCase: false, wholeWord: false, searchMode: 'text',
                isReplaceVisible: false,
                expandedFiles: new Set<string>(),
                expandedFolders: new Set<string>(),
                label: '' // Will be populated by user input
            };

            if (updatedLevels.length <= currentValues.searchInResults + 1) updatedLevels.push(newLevel);
            else updatedLevels[currentValues.searchInResults + 1] = newLevel;

            // Optimistic update to prevent "ghosting" of previous level results during transition
            const nextValues = {
                ...currentValues,
                searchInResults: currentValues.searchInResults + 1,
                find: '',
                replace: '',
                matchCase: false,
                wholeWord: false,
                searchMode: 'text' as const
            };
            setValues(nextValues);

            setTimeout(() => {
                postValuesChange(nextValues);
            }, 0);
            return updatedLevels;
        });

        if (status.running) vscode.postMessage({ type: 'stop' });
        console.log('=== handleFindInFound END ===');
    }, [postValuesChange, status, setSearchLevels, vscode, valuesRef, setValues]);

    const handleCopyFileNames = useCallback(() => {
        // Use custom order for copy file names too? User didn't specify but likely yes.
        // If resultsByFile is used by backend, we should pass order.
        // 'copyFileNames' message unfortunately doesn't accept order in current Type def, 
        // BUT we can update the type or just let it depend on resultsByFile keys.
        // Actually, backend usually iterates map. Map iteration order is insertion order? 
        // Or if it iterates `Object.keys`, it's not guaranteed.
        // Let's check `SearchReplaceViewProvider.ts` -> it doesn't handle `copyFileNames` logic, `MessageHandler.ts` does.
        // For now, standard copy.
        vscode.postMessage({ type: 'copyFileNames' });
    }, [vscode]);

    const hasResults = Object.keys(resultsByFile || {}).length > 0;
    const isStale = Object.keys(resultsByFile).length === 0 && staleResultsByFile !== null && (staleLevel === 0 || staleLevel === null || staleLevel === undefined);

    const extraActions = (
        <>
            <FindInFoundButton
                onClick={handleFindInFound}
                visible={hasResults || isStale}
                forceHide={!values.find}
            />
            <Button
                onClick={handleCopyFileNames}
                title="Copy file names"
                variant="ghost"
                size="icon"
                disabled={!hasResults && !isStale}
                className={cn("transition-opacity duration-300", (hasResults || isStale) ? "opacity-100" : "opacity-0 pointer-events-none")}
            >
                <span className="codicon codicon-copy" />
            </Button>
        </>
    );

    // ... (rest of logic same)

    // Note: We removed the local feedbackState from here since it is now managed in the parent (for banner integration)
    // However, if RootSearchSection needs to TRIGGER feedback, it should use the context or props?
    // Actually, trigger mechanism is via postMessage -> Backend -> Message Listener in Parent.
    // So RootSearchSection just posts messages.
    // The previous implementation had feedbackState LOCALLY in RootSearchSection, but the `useEffect` listener was ALSO there.
    // I moved the listener to `SearchReplaceViewInner`. 
    // So RootSearchSection should NOT have the listener anymore.
    // It just renders the Input Section.
    // The InputSection needs `useSearchItem` context.

    // NOTE: `RootSearchSection` was defining the `SearchItemProvider`.
    // We should keep that structure or move it up?
    // User wants "notification banner... above tree view". If I put it in root, it pushes input? 
    // "above tree view or list view... push down the tree view". 
    // This implies it should be BETWEEN Input and Tree.
    // So `RootSearchSection` (Input) stays as is, `NotificationBanner` is sibling below it.

    // So RootSearchSection can be simplified to just providing the context and input section.

    const controller = useSearchItemController({
        levelIndex: 0,
        extraActions,
        inputRef: searchInputRef
    });

    return (
        <SearchItemProvider value={controller}>
            <SearchInputSection
                className="flex-grow"
                summary={<SearchResultSummary />}
            />
            {/* Overlay Removed - handled by NotificationBanner in parent */}
        </SearchItemProvider>
    );


};

const SearchResultSummary = () => {
    const { status, staleStatus, values, vscode } = useSearchGlobal();

    // Use stale status if current status has 0 matches (e.g. during a re-search) to prevent flickering
    const effectiveStatus = (status.numMatches === 0 && staleStatus) ? staleStatus : status;

    if (!effectiveStatus.numMatches || effectiveStatus.numMatches === 0) return null;

    const handleOpenInEditor = () => {
        // Need to collect all file paths to open? Or just open a new search editor?
        // The screenshot says "Open in editor". In standard VS Code this usually opens a search editor.
        // For now, we might not have 'open search editor' capability easily, but let's implement the UI.
        // If the user meant "Open in editor" as a specific command, we might need to send a message.
        vscode.postMessage({ type: 'openNewSearchEditor' } as any);
    };

    return (
        <div className="px-0 py-1 text-xs text-[var(--vscode-descriptionForeground)] flex items-center justify-between">
            <span>
                <AnimatedCounter value={effectiveStatus.numMatches} suffix="results in" />
                &nbsp;
                <AnimatedCounter value={effectiveStatus.numFilesWithMatches} suffix=" files" />
            </span>
            {/* Open in editor link - mimicing VS Code style */}
            {/* <span
                className="cursor-pointer hover:text-[var(--vscode-textLink-activeForeground)] ml-2"
                onClick={handleOpenInEditor}
             >
                - Open in editor
             </span> */}
            {/* Commented out open in editor until backed support is confirmed/requested */}
        </div>
    );
};

// --- Styles & Keyframes ---
const STYLES = `
@keyframes slideInRight { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes slideInLeft { from { transform: translateX(-100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes slideOutRight { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100%); opacity: 0; } }
@keyframes slideOutLeft { from { transform: translateX(0); opacity: 1; } to { transform: translateX(-100%); opacity: 0; } }

.animate-slide-in-right { animation: slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
.animate-slide-in-left { animation: slideInLeft 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
.animate-slide-out-right { animation: slideOutRight 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
.animate-slide-out-left { animation: slideOutLeft 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }

/* TreeView Styles */
@keyframes fadeIn { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: translateY(0); } }
.animate-fade-in { animation: fadeIn 0.2s ease-out forwards; }
/* Fix for Sticky Jump: behaviors sticky elements as relative during animation */
.collapsible-animating .tree-node-sticky-header {
    position: relative !important;
    top: auto !important;
}
`;

const ViewSlideTransition = ({ showNested, children }: { showNested: boolean, children: [React.ReactNode, React.ReactNode] }) => {
    // We track the "active" view index (0=root, 1=nested)
    // and the "previous" view index to handle the exit animation.
    const targetIndex = showNested ? 1 : 0;
    const [currentIndex, setCurrentIndex] = useState(targetIndex);
    const [prevIndex, setPrevIndex] = useState<number | null>(null);
    const [animating, setAnimating] = useState(false);

    useEffect(() => {
        if (targetIndex !== currentIndex) {
            setPrevIndex(currentIndex);
            setCurrentIndex(targetIndex);
            setAnimating(true);
        }
    }, [targetIndex, currentIndex]);

    useEffect(() => {
        if (animating) {
            const timer = setTimeout(() => {
                setAnimating(false);
                setPrevIndex(null);
            }, 300); // Match CSS duration
            return () => clearTimeout(timer);
        }
    }, [animating]);

    // Direction:
    // If going to Nested (1) -> Forward (Root exits Left, Nested enters Right)
    // If going to Root (0)   -> Backward (Nested exits Right, Root enters Left)
    const direction = targetIndex === 1 ? 'forward' : 'backward';

    return (
        <div className="relative w-full h-full overflow-hidden bg-[var(--vscode-sideBar-background)]">
            {/* Exiting View (Absolute) - Stays beneath or above? 
                If we want standard "Push":
                Forward: Old slides LEFT (out), New slides LEFT (in).
                Backward: Old slides RIGHT (out), New slides RIGHT (in).
            */}
            {animating && prevIndex !== null && (
                <div
                    key={`exiting-${prevIndex}`}
                    className={cn(
                        "absolute inset-0 w-full h-full pointer-events-none z-0",
                        direction === 'forward' ? 'animate-slide-out-left' : 'animate-slide-out-right'
                    )}
                >
                    {children[prevIndex]}
                </div>
            )}

            {/* Current/Entering View - Z-index higher to slide OVER if needed, or just same layer.
                Since both animate, Z-index matters less unless they overlap with transparency.
            */}
            <div
                key={`entering-${currentIndex}`}
                className={cn(
                    "w-full h-full z-10 relative",
                    animating
                        ? (direction === 'forward' ? 'animate-slide-in-right' : 'animate-slide-in-left')
                        : ""
                )}
            >
                {children[currentIndex]}
            </div>
        </div>
    );
};

// --- Main Inner Component ---

function SearchReplaceViewInner({ vscode }: SearchReplaceViewProps) {
    const {
        values,
        resultsByFile,
        staleResultsByFile,
        setResultsByFile,
        setSearchLevels,
        handleMessage,
        isInNestedSearch,
        viewMode,
        searchLevels,
        isSearchRequested, // From Global Context
        setStatus, // Needed for updating stats on exclude
        status, // Needed for reading current stats for update
        staleLevel, // FROM CONTEXT
        customFileOrder,
        setCustomFileOrder
    } = useSearchGlobal();

    // Local UI State
    const [workspacePath, setWorkspacePath] = useState<string>('');
    const [animationState, setAnimationState] = useState<{ type: 'copy' | 'cut' | 'paste' | null, timestamp: number }>({ type: null, timestamp: 0 });

    // -- Notification Banner State --
    const [feedbackState, setFeedbackState] = useState<{
        visible: boolean;
        message: string;
        subMessage?: string;
        type: 'copy' | 'cut' | 'paste' | 'info';
    }>({ visible: false, message: '', type: 'info' });

    const showFeedback = useCallback((message: string, subMessage: string | undefined, type: 'copy' | 'cut' | 'paste' | 'info') => {
        setFeedbackState({ visible: true, message, subMessage, type });
    }, []);

    // Determine effective results (current or stale)
    const effectiveResultsByFile = useMemo(() => {
        // ... (existing logic)
        const hasCurrent = Object.keys(resultsByFile).length > 0;
        if (hasCurrent) return resultsByFile;
        // ...
        if (staleResultsByFile && Object.keys(staleResultsByFile).length > 0 && (staleLevel === 0 || staleLevel === undefined || staleLevel === null)) {
            return staleResultsByFile;
        }
        return resultsByFile;
    }, [resultsByFile, staleResultsByFile, staleLevel]);

    const isStale = Object.keys(resultsByFile).length === 0 && staleResultsByFile !== null && (staleLevel === 0 || staleLevel === null || staleLevel === undefined);

    // Use Absolute Paths for the map since we now track them in FolderNode
    const customOrderMap = useMemo(() => {
        if (!customFileOrder || customFileOrder.length === 0) return {};
        const map: { [key: string]: number } = {};

        customFileOrder.forEach((path, index) => {
            map[path] = index;
            map[uriToPath(path)] = index;
        });
        return map;
    }, [customFileOrder]);

    // Derived
    // 1. Build the Tree first (it handles sorting internally: Custom > Folders > Files > Alpha)
    const fullFileTree = useMemo(() => {
        const resultKeys = Object.keys(effectiveResultsByFile || {});
        if (!effectiveResultsByFile || resultKeys.length === 0) return null;
        // buildFileTree handles the sorting logic internally based on customOrderMap or default alpha
        return buildFileTree(effectiveResultsByFile, workspacePath, customOrderMap);
    }, [effectiveResultsByFile, workspacePath, customOrderMap]);

    // 2. Flatten the Tree to get the exact linear visual order for List View and Copy/Cut operations
    const sortedFilePaths = useMemo(() => {
        if (!fullFileTree) return [];

        const flatten = (nodes: FileTreeNode[]): string[] => {
            let paths: string[] = [];
            nodes.forEach(node => {
                if (node.type === 'file') {
                    // Use absolute path if available, or relative
                    const p = (node as any).absolutePath || node.relativePath;
                    // Only add if it exists in results (it should, based on buildFileTree)
                    paths.push(p);
                } else if (node.type === 'folder' && node.children) {
                    paths = paths.concat(flatten(node.children));
                }
            });
            return paths;
        };
        return flatten(fullFileTree.children);
    }, [fullFileTree]);



    const [pausedState, setPausedState] = useState<{ limit: number; count: number } | null>(null);
    const [skippedCount, setSkippedCount] = useState<number>(0);

    // --- Command Handlers using Sorted Order ---
    const handleCopyMatches = useCallback(() => {
        const order = sortedFilePaths && sortedFilePaths.length > 0 ? sortedFilePaths : Object.keys(effectiveResultsByFile);

        console.log('[SearchReplaceViewLayout] handleCopyMatches EXECUTION STARTED');
        console.log(`[SearchReplaceViewLayout] Visual Order Length: ${order.length}`);
        console.log('[SearchReplaceViewLayout] Visual Order First 5:', JSON.stringify(order.slice(0, 5), null, 2));

        if (order.length === 0) {
            console.log('[SearchReplaceViewLayout] Order empty, skipping copy');
            return;
        }

        vscode.postMessage({
            type: 'copyMatches',
            fileOrder: order
        });
    }, [sortedFilePaths, effectiveResultsByFile, vscode]);

    const handleCutMatches = useCallback(() => {
        const order = sortedFilePaths && sortedFilePaths.length > 0 ? sortedFilePaths : Object.keys(effectiveResultsByFile);

        console.log('[SearchReplaceViewLayout] handleCutMatches EXECUTION STARTED');
        console.log(`[SearchReplaceViewLayout] Visual Order Length: ${order.length}`);
        console.log('[SearchReplaceViewLayout] Visual Order First 5:', JSON.stringify(order.slice(0, 5), null, 2));

        if (order.length === 0) {
            console.log('[SearchReplaceViewLayout] Order empty, skipping cut');
            return;
        }

        vscode.postMessage({
            type: 'cutMatches',
            fileOrder: order
        });
    }, [sortedFilePaths, effectiveResultsByFile, vscode]);

    const handlePasteMatches = useCallback(() => {
        const order = sortedFilePaths && sortedFilePaths.length > 0 ? sortedFilePaths : Object.keys(effectiveResultsByFile);

        console.log('[SearchReplaceViewLayout] handlePasteMatches EXECUTION STARTED');
        console.log(`[SearchReplaceViewLayout] Visual Order Length: ${order.length}`);

        vscode.postMessage({
            type: 'pasteToMatches',
            fileOrder: order
        });
    }, [sortedFilePaths, effectiveResultsByFile, vscode]);


    // Effect: Mount/Unmount & Blur - Runs once (or when vscode changes)
    useEffect(() => {
        vscode.postMessage({ type: 'mount' });
        const handleBlur = () => vscode.postMessage({ type: 'unmount' });
        window.addEventListener('blur', handleBlur);
        return () => {
            window.removeEventListener('blur', handleBlur);
        };
    }, [vscode]);

    // Effect 2: Message Listener - Re-binds when handlers change (to capture fresh state)
    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            const message = event.data as MessageToWebview;

            if (['initialData', 'status', 'values', 'clearResults', 'addBatchResults', 'fileUpdated', 'replacementComplete', 'focusReplaceInput'].includes(message.type)) {
                handleMessage(message);
            }

            switch (message.type) {
                case 'initialData':
                    if (message.workspacePath) setWorkspacePath(message.workspacePath);
                    setSkippedCount(0);
                    setPausedState(null);
                    break;
                case 'clearResults':
                    setSkippedCount(0);
                    setPausedState(null);
                    break;
                case 'search-paused':
                    setPausedState({ limit: message.limit, count: message.count });
                    break;
                case 'stop':
                    setPausedState(null);
                    break;
                case 'skipped-large-files':
                    setSkippedCount(message.count);
                    break;

                // --- Command Triggers (from Backend via Shortcut) ---
                case 'triggerAction':
                    if (message.action === 'copy') handleCopyMatches();
                    if (message.action === 'cut') handleCutMatches();
                    if (message.action === 'paste') handlePasteMatches();
                    break;

                // --- Animation & Feedback Handlers ---
                case 'copyMatchesComplete':
                    showFeedback(`Copied ${message.count} matches`, undefined, 'copy');
                    setAnimationState({ type: 'copy', timestamp: Date.now() });
                    // Reset animation state after duration
                    setTimeout(() => setAnimationState({ type: null, timestamp: 0 }), 1000);
                    break;

                case 'cutMatchesComplete':
                    showFeedback(`Cut ${message.count} matches`, '(Undo: Ctrl+Shift+Z)', 'cut');
                    setAnimationState({ type: 'cut', timestamp: Date.now() });
                    // Wait for animation (e.g. 400ms) BEFORE clearing results
                    setTimeout(() => {
                        setResultsByFile({});
                        setAnimationState({ type: null, timestamp: 0 });
                    }, 400);
                    break;

                case 'pasteToMatchesComplete':
                    showFeedback(`Pasted ${message.count} matches`, '(Undo: Ctrl+Shift+Z)', 'paste');
                    setAnimationState({ type: 'paste', timestamp: Date.now() });
                    setTimeout(() => setAnimationState({ type: null, timestamp: 0 }), 1000);
                    break;

                case 'undoComplete':
                    showFeedback(message.restored ? 'Undo performed' : 'Nothing to undo', undefined, 'info');
                    // Reset results logic is handled by 'status'/'addBatchResults' which typically follow a re-run in backend?
                    // Extension.ts calls runSoon() after undo, so results will stream in.
                    break;

                case 'copyFileNamesComplete':
                    showFeedback(`Copied ${message.count} file paths`, undefined, 'copy');
                    break;
            }
        };

        window.addEventListener('message', onMessage);
        return () => {
            window.removeEventListener('message', onMessage);
        };
    }, [handleMessage, vscode, showFeedback, setResultsByFile, handleCopyMatches, handleCutMatches, handlePasteMatches]);

    // -- Global Keybindings REMOVED --
    // We now rely on 'triggerAction' messages from the backend (VS Code Keybindings -> Command -> Message)


    // Handlers
    // Handlers

    const handleFileClick = useCallback((absolutePathOrUri: string) => {
        vscode.postMessage({ type: 'openFile', filePath: absolutePathOrUri });
    }, [vscode]);

    const handleResultItemClick = useCallback((absolutePathOrUri: string, range?: { start: number; end: number }) => {
        vscode.postMessage({ type: 'openFile', filePath: absolutePathOrUri, ...(range && { range }) });
    }, [vscode]);

    const handleReplaceSelectedFiles = useCallback((filePaths: string[]) => {
        console.log('[SearchReplaceViewLayout] handleReplaceSelectedFiles called with:', filePaths);
        console.log('[SearchReplaceViewLayout] Values:', { find: values?.find, replace: values?.replace });
        if (!values?.find || values.replace === undefined || filePaths.length === 0) {
            console.error('[SearchReplaceViewLayout] Replace aborted: validations failed', { find: !!values?.find, replace: values?.replace, paths: filePaths.length });
            return;
        }
        vscode.postMessage({ type: 'replace', filePaths });
    }, [values.find, values.replace, vscode]);

    const handleExcludeFile = useCallback((filePath: string) => {
        vscode.postMessage({ type: 'excludeFile', filePath });

        let removedMatchesCount = 0;
        let removedFileCount = 0;

        if (isInNestedSearch && values.searchInResults > 0) {
            setSearchLevels(prev => {
                const newLevels = [...prev];
                const currentLevel = newLevels[values.searchInResults];
                if (currentLevel) {
                    const newResults = { ...currentLevel.resultsByFile };
                    Object.keys(newResults).forEach(key => {
                        // Check if key equals filePath (file) or starts with filePath/ (folder)
                        // keys are absolute paths
                        if (key === filePath || key.startsWith(filePath + path.sep)) {
                            const fileEvents = newResults[key];
                            const matches = fileEvents?.reduce((sum: number, e: any) => sum + (e.matches?.length || 0), 0) || 0;
                            removedMatchesCount += matches;
                            removedFileCount += 1;
                            delete newResults[key];
                        }
                    });
                    newLevels[values.searchInResults] = { ...currentLevel, resultsByFile: newResults };
                }
                return newLevels;
            });
        } else {
            setResultsByFile(prev => {
                const newResults = { ...prev };
                Object.keys(newResults).forEach(key => {
                    // Check if key equals filePath (file) or starts with filePath/ (folder)
                    if (key === filePath || key.startsWith(filePath + path.sep)) {
                        const fileEvents = newResults[key];
                        const matches = fileEvents?.reduce((sum, e) => sum + (e.matches?.length || 0), 0) || 0;
                        removedMatchesCount += matches;
                        removedFileCount += 1;
                        delete newResults[key];
                    }
                });
                return newResults;
            });
        }

        // Update global status for immediate UI feedback (Animation)
        if (removedMatchesCount > 0 || removedFileCount > 0) {
            setStatus(prev => ({
                ...prev,
                numMatches: Math.max(0, prev.numMatches - removedMatchesCount),
                numFilesWithMatches: Math.max(0, prev.numFilesWithMatches - removedFileCount)
            }));
        }

    }, [vscode, isInNestedSearch, values.searchInResults, setSearchLevels, setResultsByFile, setStatus]);

    const toggleFileExpansion = useCallback((relativePath: string) => {
        setSearchLevels(prev => {
            const index = isInNestedSearch ? values.searchInResults : 0;
            const newLevels = [...prev];
            if (newLevels[index]) {
                const newSet = new Set(newLevels[index].expandedFiles);
                if (newSet.has(relativePath)) newSet.delete(relativePath);
                else newSet.add(relativePath);
                newLevels[index] = { ...newLevels[index], expandedFiles: newSet };
            }
            return newLevels;
        });
    }, [isInNestedSearch, values.searchInResults, setSearchLevels]);

    const toggleFolderExpansion = useCallback((relativePath: string) => {
        setSearchLevels(prev => {
            const index = isInNestedSearch ? values.searchInResults : 0;
            const newLevels = [...prev];
            if (newLevels[index]) {
                const newSet = new Set(newLevels[index].expandedFolders);
                if (newSet.has(relativePath)) newSet.delete(relativePath);
                else newSet.add(relativePath);
                newLevels[index] = { ...newLevels[index], expandedFolders: newSet };
            }
            return newLevels;
        });
    }, [isInNestedSearch, values.searchInResults, setSearchLevels]);

    const handleDragStart = useCallback((e: React.DragEvent, node: FileTreeNode) => {
        const path = (node as any).absolutePath || node.relativePath;
        e.dataTransfer.setData('text/plain', path);
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent, targetNode: FileTreeNode) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }, []);


    const handleDrop = useCallback((e: React.DragEvent, targetNode: FileTreeNode) => {
        console.error('[SearchReplaceViewLayout] handleDrop ENTERED');
        try {
            e.preventDefault();
            const sourcePath = e.dataTransfer.getData('text/plain');

            // Try to get absolute path from target node
            const targetPath = (targetNode as any).absolutePath || targetNode.relativePath;

            console.error('[SearchReplaceViewLayout] Handle Drop Data:', {
                sourcePath,
                targetPath,
                targetNodeType: targetNode.type,
                targetNodePath: targetNode.relativePath
            });

            if (!sourcePath || !targetPath || sourcePath === targetPath) {
                console.error('[SearchReplaceViewLayout] Drop ignored: validation failed or same source/target');
                return;
            }

            // Helper to flatten the current visual tree
            const flattenTree = (nodes: FileTreeNode[]): string[] => {
                let paths: string[] = [];
                nodes.forEach(node => {
                    const p = (node as any).absolutePath || node.relativePath;
                    paths.push(p);
                    if (node.type === 'folder' && node.children) {
                        paths = paths.concat(flattenTree(node.children));
                    }
                });
                return paths;
            };

            const currentVisualOrder = fullFileTree ? flattenTree(fullFileTree.children) : [];

            // If the tree is empty or doesn't contain our items (edge case), fallback
            if (currentVisualOrder.length === 0) {
                const currentFilePaths = Object.keys(effectiveResultsByFile);
                currentVisualOrder.push(...currentFilePaths.sort());
            }

            // Ensure source and target are in the list (they should be if they were dragged)
            if (!currentVisualOrder.includes(sourcePath)) currentVisualOrder.push(sourcePath);
            if (!currentVisualOrder.includes(targetPath)) currentVisualOrder.push(targetPath);


            const sourceIndex = currentVisualOrder.indexOf(sourcePath);
            const targetIndex = currentVisualOrder.indexOf(targetPath);

            if (sourceIndex === -1 || targetIndex === -1) {
                console.error('[SearchReplaceViewLayout] Source or Target index not found');
                return;
            }

            // Reorder Logic on the Visual List
            currentVisualOrder.splice(sourceIndex, 1);
            let adjustedTargetIndex = currentVisualOrder.indexOf(targetPath);

            // Adjust insertion point based on direction
            if (sourceIndex < targetIndex) {
                // Dragging Down: Insert AFTER target
                adjustedTargetIndex += 1;
            }
            currentVisualOrder.splice(adjustedTargetIndex, 0, sourcePath);

            // Merge with existing hidden items
            let finalOrder = currentVisualOrder;
            if (customFileOrder && customFileOrder.length > 0) {
                const hiddenItems = customFileOrder.filter(p => !currentVisualOrder.includes(p));
                finalOrder = [...currentVisualOrder, ...hiddenItems];
            }

            console.error('[SearchReplaceViewLayout] NEW ORDER Generated:', finalOrder.slice(0, 5));
            setCustomFileOrder(finalOrder);
        } catch (err) {
            console.error('[SearchReplaceViewLayout] DATA DROP ERROR:', err);
        }
    }, [customFileOrder, effectiveResultsByFile, setCustomFileOrder, fullFileTree]);

    const handleContinueSearch = useCallback(() => {
        setPausedState(null);
        vscode.postMessage({ type: 'continue-search' });
    }, [vscode]);

    const handleSearchLargeFiles = useCallback(() => {
        setSkippedCount(0); // Clear notification
        vscode.postMessage({ type: 'search-large-files' });
    }, [vscode]);

    // Render Helpers
    const currentExpandedFiles = useMemo((): Set<string> => {
        const level = searchLevels[isInNestedSearch ? values.searchInResults : 0];
        const files = level?.expandedFiles;
        return files instanceof Set ? files : new Set<string>(files || []);
    }, [searchLevels, isInNestedSearch, values.searchInResults]);

    const currentExpandedFolders = useMemo((): Set<string> => {
        const level = searchLevels[isInNestedSearch ? values.searchInResults : 0];
        const folders = level?.expandedFolders;
        return folders instanceof Set ? folders : new Set<string>(folders || []);
    }, [searchLevels, isInNestedSearch, values.searchInResults]);

    const renderRootView = () => (
        <div className="flex flex-col h-full">
            <div className="flex flex-col gap-1.5 mb-2">
                <div className="flex items-start gap-1">
                    <RootSearchSection />
                </div>
            </div>

            {/* Notification Banner - Pushes content down */}
            <NotificationBanner
                visible={feedbackState.visible}
                message={feedbackState.message}
                subMessage={feedbackState.subMessage}
                type={feedbackState.type}
                onClose={() => setFeedbackState(prev => ({ ...prev, visible: false }))}
            />

            {/* Pause Warning Banner */}
            {pausedState && (
                <div className="bg-[var(--vscode-inputValidation-warningBackground)] border border-[var(--vscode-inputValidation-warningBorder)] p-2 mb-2 rounded-sm flex flex-col gap-2 animate-in fade-in slide-in-from-top-1 duration-300">
                    <div className="flex items-center gap-2 text-[var(--vscode-inputValidation-warningForeground)]">
                        <span className="codicon codicon-warning" />
                        <span className="font-semibold text-xs">
                            Search paused at {pausedState.count.toLocaleString()} matches.
                        </span>
                    </div>
                    <div className="text-xs opacity-90">
                        Continuing may cause high CPU usage or instability.
                    </div>
                    <div className="flex gap-2 justify-end mt-1">
                        <button
                            className="bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)] px-3 py-1 rounded-sm text-xs border border-[var(--vscode-button-border)] cursor-pointer"
                            onClick={() => setPausedState(null)}
                        >
                            Stop
                        </button>
                        <button
                            className="bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] px-3 py-1 rounded-sm text-xs border border-[var(--vscode-button-border)] cursor-pointer font-medium"
                            onClick={handleContinueSearch}
                        >
                            Continue
                        </button>
                    </div>
                </div>
            )}

            <div className={cn("flex-grow overflow-hidden relative", isStale ? "opacity-50 transition-opacity duration-200" : "transition-opacity duration-200")}>
                <div className="flex flex-col h-full overflow-hidden">
                    {(() => {
                        // Consolidate View Data Logic
                        const nodesToShow: FileTreeNode[] = viewMode === 'list' && sortedFilePaths
                            ? sortedFilePaths.map(filePath => {
                                const workspacePathStr = uriToPath(workspacePath);
                                const displayPath = workspacePathStr
                                    ? path.relative(workspacePathStr, uriToPath(filePath))
                                    : uriToPath(filePath);

                                let cleanDisplayPath = displayPath;
                                if (cleanDisplayPath.startsWith('/') || cleanDisplayPath.startsWith('\\')) {
                                    cleanDisplayPath = cleanDisplayPath.substring(1);
                                }

                                const node: FileNode = {
                                    type: 'file',
                                    name: path.basename(filePath),
                                    description: path.dirname(cleanDisplayPath) !== '.' ? path.dirname(cleanDisplayPath) : undefined,
                                    relativePath: cleanDisplayPath,
                                    absolutePath: filePath,
                                    results: effectiveResultsByFile[filePath] || []
                                };
                                return node;
                            })
                            : (fullFileTree ? fullFileTree.children : []);

                        if (nodesToShow.length === 0) {
                            return isSearchRequested ? (
                                <div className="p-[10px] text-[var(--vscode-descriptionForeground)] text-center flex justify-center items-center gap-2">
                                    <span className="codicon codicon-loading codicon-modifier-spin"></span><span>Searching...</span>
                                </div>
                            ) : (
                                <div className="p-[10px] text-[var(--vscode-descriptionForeground)] text-center">No matches found.</div>
                            );
                        }

                        return (
                            <VirtualTreeView
                                fileTree={nodesToShow}
                                expandedFolders={currentExpandedFolders}
                                toggleFolderExpansion={toggleFolderExpansion}
                                expandedFiles={currentExpandedFiles}
                                toggleFileExpansion={toggleFileExpansion}
                                handleFileClick={handleFileClick}
                                handleResultItemClick={handleResultItemClick}
                                handleReplace={handleReplaceSelectedFiles}
                                handleExcludeFile={handleExcludeFile}
                                currentSearchValues={values}
                                onDragStart={handleDragStart}
                                onDragOver={handleDragOver}
                                onDrop={handleDrop}
                                animationState={animationState}
                            />
                        );
                    })()}
                </div>
            </div>

            {/* Skipped Files Notification */}
            {skippedCount > 0 && (
                <div className="p-2 text-xs flex justify-between items-center border-t border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)] animate-in slide-in-from-bottom-2 fade-in duration-300">
                    <span className="opacity-80">Skipped {skippedCount} large files (&gt;1MB).</span>
                    <button
                        onClick={handleSearchLargeFiles}
                        className="text-[var(--vscode-textLink-foreground)] hover:underline cursor-pointer bg-transparent border-none p-0"
                    >
                        Search them
                    </button>
                </div>
            )}
        </div>
    );

    return (
        <div className="flex flex-col h-screen p-[5px] box-border overflow-hidden relative" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
            <style>{STYLES}</style>

            <div className="flex-grow overflow-hidden relative">
                <ViewSlideTransition showNested={isInNestedSearch}>
                    {renderRootView()}
                    <SearchNestedView animationState={animationState} />
                </ViewSlideTransition>
            </div>
        </div>
    );
}

export default function SearchReplaceView({ vscode }: SearchReplaceViewProps): React.ReactElement {
    return (
        <SearchGlobalProvider vscode={vscode}>
            <SearchReplaceViewInner vscode={vscode} />
        </SearchGlobalProvider>
    );
}

