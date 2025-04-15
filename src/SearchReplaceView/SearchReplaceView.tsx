import React, { useState, useCallback, useMemo, useEffect } from 'react'
import '@vscode/codicons/dist/codicon.css'
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
  Message,
  MessageToWebview,
  MessageFromWebview,
  SerializedTransformResultEvent,
  SearchReplaceViewStatus,
  SearchReplaceViewValues,
  InitialDataFromExtension,
} from './SearchReplaceViewTypes'
import path from 'path-browserify' // Use path-browserify for web compatibility
import { URI } from 'vscode-uri'; // Import URI library

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

// --- Types for File Tree ---
interface FileTreeNodeBase {
  name: string
  relativePath: string
}

interface FolderNode extends FileTreeNodeBase {
  type: 'folder'
  children: FileTreeNode[]
}

interface FileNode extends FileTreeNodeBase {
  type: 'file'
  absolutePath: string
  results: SerializedTransformResultEvent[]
}

type FileTreeNode = FolderNode | FileNode

// Helper function to convert file URI to path, handling potential Windows drive letters
function uriToPath(uriString: string | undefined): string | undefined {
    if (!uriString) return undefined;
    try {
        const uri = URI.parse(uriString);
        if (uri.scheme === 'file') {
            // fsPath handles drive letters correctly (e.g., /c:/Users -> c:\Users)
            return uri.fsPath; 
        }
        // Return original string if it's not a file URI or parsing fails
        return uriString; 
    } catch (e) {
        // console.error("Error parsing URI:", uriString, e);
        // Fallback to returning the original string on error
        return uriString; 
    }
}

// --- Helper Function to Build File Tree ---
function buildFileTree(
  resultsByFile: Record<string, SerializedTransformResultEvent[]>,
  workspacePathUri: string | undefined // Expect URI or path string
): FolderNode {
  const root: FolderNode = { name: '', relativePath: '', type: 'folder', children: [] }
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
    if (!absoluteFilePath) {
      // console.error("Could not determine absolute path for:", absoluteFilePathOrUri);
      return; // Skip if path conversion fails
    }

    // Calculate relative path if workspacePath is available
    const displayPath = workspacePath 
        ? path.relative(workspacePath, absoluteFilePath) 
        : absoluteFilePath; // Fallback to absolute if no workspace

    // Ensure consistent POSIX separators for internal logic
    const posixDisplayPath = displayPath.replace(/\\/g, '/'); // Replace backslashes with forward slashes
    const segments = posixDisplayPath.split('/').filter(Boolean);
    let currentNode = root;
    let currentRelativePath = '';

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
       // Sort children again after filtering
       filteredChildren.sort((a, b) => {
           if (a.type !== b.type) {
               return a.type === 'folder' ? -1 : 1;
           }
           return a.name.localeCompare(b.name);
       });
      return { ...node, children: filteredChildren };
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

// Helper to extract filename (basename)
const getFilename = (filePathOrUri: string): string => {
  const filePath = uriToPath(filePathOrUri) || filePathOrUri; // Convert first
  return path.basename(filePath); 
}

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
    logToExtension: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
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
    logToExtension,
}) => {
    const indent = level * 15 // Indentation level

    if (node.type === 'folder') {
        const isExpanded = expandedFolders.has(node.relativePath);
        return (
            <div className={css`margin-bottom: 1px;`}>
                <div
                    className={css`
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        padding: 2px 5px;
                        cursor: pointer;
                        padding-left: ${indent + 5}px; /* Indent folder */
                        &:hover { background-color: var(--vscode-list-hoverBackground); }
                    `}
                    onClick={() => toggleFolderExpansion(node.relativePath)}
                    title={`Click to ${isExpanded ? 'collapse' : 'expand'} ${node.name}`}
                >
                    <span className={`codicon codicon-chevron-${isExpanded ? 'down' : 'right'}`} />
                    <span className="codicon codicon-folder" style={{ marginRight: '4px' }} />
                    <span>{node.name}</span>
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
                                logToExtension={logToExtension}
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

        // Log path info for tree node files
        logToExtension('info', 'Processing file path for tree node:', {
          fileResults: fileResults[0]?.matches,
          isExpanded,
          totalMatches,
          hasError,
          canExpand
        });

        return (
            <div key={node.relativePath} className={css` margin-bottom: 1px; `}>
                {/* File Entry */}
                <div
                    className={css`
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        padding: 2px 5px;
                        cursor: pointer;
                        padding-left: ${indent + 5}px; /* Indent file */
                        &:hover { background-color: var(--vscode-list-hoverBackground); }
                    `}
                     // Click toggles expansion only if there are matches, otherwise opens file
                    onClick={() => canExpand ? toggleFileExpansion(node.relativePath) : handleFileClick(node.absolutePath)} 
                    title={canExpand ? `Click to ${isExpanded ? 'collapse' : 'expand'} matches in ${node.name}` : `Click to open ${node.name}`}
                >
                    {/* Chevron only visible if there are matches to expand */}
                    <span className={`codicon codicon-chevron-${isExpanded ? 'down' : 'right'}`}
                          style={{ visibility: canExpand ? 'visible' : 'hidden' }}/>
                    <span className="codicon codicon-file" style={{ marginRight: '4px' }} />
                    {/* Make filename itself always clickable to open file */}
                    <span className={css`font-weight: bold; flex-grow: 1; cursor: pointer;`} 
                          onClick={(e) => { e.stopPropagation(); handleFileClick(node.absolutePath); }} 
                          title={`Click to open ${node.name}`}>{node.name}</span> 
                    <span className={css`color: var(--vscode-descriptionForeground);`}>
                       {/* Prioritize match count, then check for error */}
                       {totalMatches > 0
                         ? `${totalMatches} matches`
                         : (hasError ? 'Error' : 'Changed')}
                    </span>
                    {/* Show (Error) indicator only if there are no matches AND there is an error */}
                    {totalMatches === 0 && hasError && 
                      <span className={css`margin-left: 8px; color: var(--vscode-errorForeground);`}>(Error)</span>}
                </div>
                {/* Expanded Matches */}
                {isExpanded && canExpand && (
                    <div className={css` margin-left: ${indent + 25}px; /* Further indent matches */ padding: 2px 0; `}>
                        {fileResults.map((res, idx) => (
                            res.matches?.map((match, matchIdx) => (
                                <div key={`${idx}-${matchIdx}`}
                                    className={css`
                                        padding: 1px 5px;
                                        cursor: pointer;
                                        font-family: var(--vscode-editor-font-family);
                                        font-size: var(--vscode-editor-font-size);
                                        &:hover { background-color: var(--vscode-list-hoverBackground); }
                                    `}
                                    onClick={() => handleResultItemClick(node.absolutePath, { start: match.start, end: match.end })}
                                    title={`Click to open match in ${node.name}`}
                                >
                                    {/* Display highlighted context */}
                                    {getHighlightedMatchContext(res.source, match.start, match.end)}
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

export default function SearchReplaceView({ vscode }: SearchReplaceViewProps): React.ReactElement {
    // --- State Initialization using VS Code Webview API ---
    const initialState = vscode.getState() || {};
    const [values, setValues] = useState<SearchReplaceViewValues>({
        // Default values first
        find: '', replace: '', paused: false, include: '', exclude: '',
        parser: 'babel', prettier: true, babelGeneratorHack: false, preferSimpleReplacement: false,
        searchMode: 'text', matchCase: false, wholeWord: false,
        // Then override with loaded state if available
        ...(initialState.values || {}),
    });
    const [status, setStatus] = useState<SearchReplaceViewStatus>(initialState.status || {
        running: false, completed: 0, total: 0, numMatches: 0,
        numFilesThatWillChange: 0, numFilesWithMatches: 0, numFilesWithErrors: 0,
    });
    // Store results keyed by absolute path initially
    const [resultsByFile, setResultsByFile] = useState<Record<string, SerializedTransformResultEvent[]>>(initialState.resultsByFile || {}); 
    const [workspacePath, setWorkspacePath] = useState<string | undefined>(initialState.workspacePath);

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
    
    // --- Nested Search (Find in Found) States ---
    const [showNestedSearch, setShowNestedSearch] = useState(initialState.showNestedSearch ?? false);
    const [nestedSearchValues, setNestedSearchValues] = useState<SearchReplaceViewValues>({
        find: '', replace: '', paused: false, include: '', exclude: '',
        parser: 'babel', prettier: true, babelGeneratorHack: false, preferSimpleReplacement: false,
        searchMode: 'text', matchCase: false, wholeWord: false,
    });
    const [nestedResultsByFile, setNestedResultsByFile] = useState<Record<string, SerializedTransformResultEvent[]>>({});
    const [nestedMatchCase, setNestedMatchCase] = useState(false);
    const [nestedWholeWord, setNestedWholeWord] = useState(false);
    const [nestedSearchMode, setNestedSearchMode] = useState<SearchReplaceViewValues['searchMode']>('text');
    const [isNestedReplaceVisible, setIsNestedReplaceVisible] = useState(false);

    // --- Save State Effect ---
    useEffect(() => {
        vscode.setState({ 
            values, status, resultsByFile, workspacePath, isReplaceVisible, 
            showSettings, viewMode, 
            // Convert Sets to Arrays for storage
            expandedFiles: Array.from(expandedFiles), 
            expandedFolders: Array.from(expandedFolders),
            // Nested search state
            showNestedSearch, nestedSearchValues, nestedResultsByFile,
         });
    }, [values, status, resultsByFile, workspacePath, isReplaceVisible, showSettings, viewMode, 
        expandedFiles, expandedFolders, vscode, showNestedSearch, nestedSearchValues, nestedResultsByFile]);

    // --- Message Listener ---
    useEffect(() => {
        const handleMessage = (event: MessageEvent<MessageToWebview>) => {
            const message = event.data;
            logToExtension('info', 'Received message from extension', message); // Log received message
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
                    break;
                case 'addResult': {
                    const newResult = message.data;
                    setResultsByFile(prev => ({
                        ...prev,
                        // Use original absolute path/URI as key
                        [newResult.file]: [...(prev[newResult.file] || []), newResult] 
                    }));
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
    }, [vscode]); // Only depends on vscode api

    // --- Logging Helper ---
    const logToExtension = useCallback((
        level: 'info' | 'warn' | 'error',
        message: string,
        data?: unknown
    ) => {
        vscode.postMessage({ type: 'log', level, message, data });
    }, [vscode]);

    // --- Log viewMode when results or mode change ---
    useEffect(() => {
        const resultsCount = Object.keys(resultsByFile).length;
        if (resultsCount > 0) { // Only log if there are results
            logToExtension('info', 'Results view state:', { viewMode, hasResults: true, resultsCount });
        }
    }, [viewMode, resultsByFile, logToExtension]); // Dependencies: viewMode, results, and the log function itself

    // --- Callbacks ---
    const postValuesChange = useCallback((changed: Partial<SearchReplaceViewValues>) => {
        // Immediately update local state for responsiveness
        setValues(prev => {
            const next = { ...prev, ...changed };
             // Update dependent local state right away
            if (changed.searchMode !== undefined) setCurrentSearchMode(changed.searchMode);
            if (changed.matchCase !== undefined) setMatchCase(changed.matchCase);
            if (changed.wholeWord !== undefined) setWholeWord(changed.wholeWord);
            // Post the complete updated values
            vscode.postMessage({ type: 'values', values: next }); 
            return next;
        });
    }, [vscode]);

    const toggleReplace = useCallback(() => setIsReplaceVisible((v: boolean) => !v), []);
    const toggleSettings = useCallback(() => setShowSettings((v: boolean) => !v), []);

    const handleFindChange = useCallback((e: any) => {
        postValuesChange({ find: e.target.value });
    }, [postValuesChange]);

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
         vscode.postMessage({ type: 'replace' });
    }, [vscode]);

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
        logToExtension('info', `Requesting to open file: ${absolutePathOrUri}`);
        vscode.postMessage({ type: 'openFile', filePath: absolutePathOrUri });
    }, [vscode, logToExtension]);

    // Open file to specific match (uses absolute path/URI)
    const handleResultItemClick = useCallback((absolutePathOrUri: string, range?: { start: number; end: number }) => {
        logToExtension('info', `Requesting to open file to range: ${absolutePathOrUri}`, range);
        vscode.postMessage({ type: 'openFile', filePath: absolutePathOrUri, ...(range && { range }) });
    }, [vscode, logToExtension]);

    // --- Memoized Data ---
    // Build the initial, unfiltered tree
    const unfilteredFileTree = useMemo(() => {
         // logToExtension('info', 'Building unfiltered file tree', { resultsCount: Object.keys(resultsByFile).length, workspacePath });
         return buildFileTree(resultsByFile, workspacePath);
    }, [resultsByFile, workspacePath]);

    // Filter the tree for nodes with matches
    const filteredFileTree = useMemo(() => {
        // logToExtension('info', 'Filtering file tree');
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
        numFilesWithMatches, numFilesWithErrors, numFilesThatWillChange
    } = status;
    const hasResults = filteredFileTree.children.length > 0;

    // --- Derived State ---
    const isAstxMode = currentSearchMode === 'astx';
    const isTextMode = currentSearchMode === 'text';
    const canReplace = isAstxMode && numFilesThatWillChange > 0 && !running;

    // --- Effect to expand all folders AND FILES in FILTERED Tree View by default ---
    useEffect(() => {
        if (viewMode === 'tree' && filteredFileTree && filteredFileTree.children.length > 0) {
            const allFolderPaths = getAllFolderPaths(filteredFileTree);
            const allFilePaths = getAllFilePaths(filteredFileTree); // <-- Get file paths
            setExpandedFolders(new Set(allFolderPaths));
            setExpandedFiles(new Set(allFilePaths)); // <-- Set expanded files
        }
    }, [filteredFileTree, viewMode, logToExtension]); // Depend on filteredFileTree

    // --- Find in Found Handlers ---
    const handleFindInFound = useCallback(() => {
        setShowNestedSearch(true);
        setNestedSearchValues({
            ...values,
            find: '',
            replace: '',
        });
        setNestedResultsByFile({});
        setNestedMatchCase(false);
        setNestedWholeWord(false);
        setNestedSearchMode('text');
        setIsNestedReplaceVisible(false);
    }, [values]);

    const handleCloseNestedSearch = useCallback(() => {
        setShowNestedSearch(false);
        setNestedResultsByFile({});
    }, []);

    const handleNestedFindChange = useCallback((e: any) => {
        setNestedSearchValues(prev => ({
            ...prev,
            find: e.target.value
        }));
    }, []);

    const handleNestedReplaceChange = useCallback((e: any) => {
        setNestedSearchValues(prev => ({
            ...prev,
            replace: e.target.value
        }));
    }, []);

    const toggleNestedMatchCase = useCallback(() => {
        setNestedMatchCase(prev => !prev);
        setNestedSearchValues(prev => ({
            ...prev,
            matchCase: !nestedMatchCase
        }));
    }, [nestedMatchCase]);

    const toggleNestedWholeWord = useCallback(() => {
        setNestedWholeWord(prev => !prev);
        setNestedSearchValues(prev => ({
            ...prev,
            wholeWord: !nestedWholeWord
        }));
    }, [nestedWholeWord]);

    const handleNestedModeChange = useCallback((newMode: SearchReplaceViewValues['searchMode']) => {
        const finalMode = (newMode === nestedSearchMode && newMode !== 'text') ? 'text' : newMode;
        setNestedSearchMode(finalMode);
        setNestedSearchValues(prev => ({
            ...prev,
            searchMode: finalMode
        }));
    }, [nestedSearchMode]);

    const toggleNestedReplace = useCallback(() => {
        setIsNestedReplaceVisible(prev => !prev);
    }, []);

    // Perform the nested search when find term changes
    useEffect(() => {
        if (showNestedSearch && nestedSearchValues.find) {
            // Create search regex based on current settings
            const pattern = nestedSearchMode === 'regex' 
                ? nestedSearchValues.find 
                : escapeRegExp(nestedSearchValues.find);
                
            const modifiedPattern = nestedWholeWord && nestedSearchMode === 'text' 
                ? `\\b${pattern}\\b` 
                : pattern;
                
            const flags = nestedMatchCase ? 'g' : 'gi';
            const regex = new RegExp(modifiedPattern, flags);
            
            // Search through existing results
            const newResults: Record<string, SerializedTransformResultEvent[]> = {};
            
            Object.entries(resultsByFile).forEach(([filePath, fileResults]) => {
                const fileMatches: SerializedTransformResultEvent[] = [];
                
                fileResults.forEach(result => {
                    if (result.source) {
                        const matches: Array<{ start: number; end: number }> = [];
                        let match;
                        
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
            
            setNestedResultsByFile(newResults);
        }
    }, [showNestedSearch, nestedSearchValues.find, nestedMatchCase, nestedWholeWord, nestedSearchMode, resultsByFile]);

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
          {showNestedSearch && (
            <div className={css`
              background-color: var(--vscode-editor-background);
              padding: 5px;
              border-radius: 3px;
              margin-bottom: 10px;
              position: relative;
              z-index: 10;
              box-shadow: 0 2px 5px rgba(0, 0, 0, 0.3);
            `}>
              {/* Close Button for nested search */}
              <div className={css`
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 5px;
              `}>
                <span className={css`color: var(--vscode-descriptionForeground);`}>
                  Find in Found Results
                </span>
                <VSCodeButton appearance="icon" onClick={handleCloseNestedSearch} title="Close Find in Found">
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
                            placeholder="search within results"
                            aria-label="Nested Search Pattern"
                            name="nestedSearch"
                            rows={1}
                            value={nestedSearchValues.find}
                            onInput={handleNestedFindChange}
                            className={css` flex-grow: 1; `} // Make text area grow
                         />
                         {/* Search Options Buttons */}
                         <VSCodeButton 
                            appearance={nestedMatchCase ? "secondary" : "icon"} 
                            onClick={toggleNestedMatchCase} 
                            title="Match Case (Aa)"
                         >
                             <span className="codicon codicon-case-sensitive" />
                         </VSCodeButton>
                         <VSCodeButton 
                            appearance={nestedWholeWord ? "secondary" : "icon"} 
                            onClick={toggleNestedWholeWord} 
                            title="Match Whole Word (Ab)"
                         >
                             <span className="codicon codicon-whole-word" />
                         </VSCodeButton>
                         <VSCodeButton 
                            appearance={nestedSearchMode === 'regex' ? "secondary" : "icon"} 
                            onClick={() => handleNestedModeChange('regex')} 
                            title="Use Regular Expression (.*)"
                         >
                             <span className="codicon codicon-regex" />
                         </VSCodeButton>
                         <VSCodeButton 
                            appearance={nestedSearchMode === 'astx' ? "secondary" : "icon"} 
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
                                value={nestedSearchValues.replace}
                                onInput={handleNestedReplaceChange}
                                className={css` flex-grow: 1; `} // Make textarea grow
                            />
                        </div>
                    )}
                </div>
              </div>
            </div>
          )}
          
          {/* Original Search Interface */}
          <div className={css`
            ${showNestedSearch ? 'opacity: 0.7;' : ''}
            ${showNestedSearch ? 'pointer-events: none;' : ''}
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
                              title={!hasResults || running ? "Replace All" : `Replace ${values.replace} in ${numFilesWithMatches} files` }
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
                       >
                           <span className="codicon codicon-search-new-file"></span> 
                       </VSCodeButton>
                       {/* Tree View Button */}
                       <VSCodeButton 
                           appearance={viewMode === 'list' ? 'icon' : 'secondary'} 
                           onClick={() => setViewMode('tree')} 
                           title="View as tree"
                       >
                           <span className="codicon codicon-list-tree"></span> 
                       </VSCodeButton>
                       {/* List View Button */}
                       <VSCodeButton 
                           appearance={viewMode === 'tree' ? 'icon' : 'secondary'} 
                           onClick={() => setViewMode('list')} 
                           title="View as list"
                       >
                           <span className="codicon codicon-list-flat"></span>
                       </VSCodeButton>
                   </div>
                )}
            </div>
            
            {/* --- Collapsible Settings Panel --- */} 
            {!showNestedSearch && showSettings && (
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

                {/* Show either nested results or regular results based on state */}
                {showNestedSearch ? (
                    // Nested search results view
                    Object.keys(nestedResultsByFile).length > 0 ? (
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
                                                logToExtension={logToExtension}
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
                                    {Object.entries(nestedResultsByFile).map(([filePath, results]) => {
                                        const displayPath = workspacePath 
                                            ? path.relative(uriToPath(workspacePath) || '', uriToPath(filePath) || filePath)
                                            : getFilename(filePath);
                                        
                                        const totalMatches = results.reduce((sum, r) => sum + (r.matches?.length || 0), 0);
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
                                                                    title={`Click to open match in ${getFilename(filePath)}`}
                                                                >
                                                                    {getHighlightedMatchContext(result.source, match.start, match.end)}
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
                    ) : nestedSearchValues.find ? (
                        <div className={css`
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            height: 100px;
                            color: var(--vscode-descriptionForeground);
                        `}>
                            No matches found for "{nestedSearchValues.find}"
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
                                            logToExtension={logToExtension}
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
                                            ? path.relative(uriToPath(workspacePath) || '', uriToPath(filePath) || filePath) 
                                            : getFilename(filePath);
                                        
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
                                                                    title={`Click to open match in ${getFilename(filePath)}`}
                                                                >
                                                                    {getHighlightedMatchContext(result.source, match.start, match.end)}
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
