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
                                    {/* TODO: Display actual match context instead of just position */}
                                    Match at {match.start}...{match.end}
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

export default function SearchReplaceView({ vscode }: SearchReplaceViewProps): React.ReactElement {
    // --- State Initialization using VS Code Webview API ---
    const initialState = vscode.getState() || {};
    const [values, setValues] = useState<SearchReplaceViewValues>(initialState.values || {
        // Default values if no state saved
        find: '', replace: '', paused: false, include: '', exclude: '',
        parser: 'babel', prettier: true, babelGeneratorHack: false, preferSimpleReplacement: false,
        searchMode: 'text', matchCase: false, wholeWord: false,
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

    // --- Save State Effect ---
    useEffect(() => {
        vscode.setState({ 
            values, status, resultsByFile, workspacePath, isReplaceVisible, 
            showSettings, viewMode, 
            // Convert Sets to Arrays for storage
            expandedFiles: Array.from(expandedFiles), 
            expandedFolders: Array.from(expandedFolders), 
         });
    }, [values, status, resultsByFile, workspacePath, isReplaceVisible, showSettings, viewMode, expandedFiles, expandedFolders, vscode]);

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
    // Build file tree structure (used for tree view)
    const fileTree = useMemo(() => {
         logToExtension('info', 'Rebuilding file tree', { resultsCount: Object.keys(resultsByFile).length, workspacePath });
         return buildFileTree(resultsByFile, workspacePath);
    }, [resultsByFile, workspacePath, logToExtension]); // Rebuild only when results or workspacePath change

    // Calculate result counts from status
     const {
        running, completed, total, numMatches, 
        numFilesWithMatches, numFilesWithErrors, numFilesThatWillChange
    } = status;
    const hasResults = Object.keys(resultsByFile).length > 0;

    // --- Derived State ---
    const isAstxMode = currentSearchMode === 'astx';
    const isTextMode = currentSearchMode === 'text';
    const canReplace = isAstxMode && numFilesThatWillChange > 0 && !running;

    return (
        <div
          onKeyDown={handleKeyDown}
          className={css`
            display: flex;
            flex-direction: column;
          `}
        >
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
                    <VSCodeTextArea
                        placeholder={isAstxMode ? "replace" : "replace (AST mode only)"}
                        aria-label="Replace Pattern"
                        name="replace"
                        rows={1}
                        value={values.replace}
                        onInput={handleReplaceChange}
                        disabled={!isAstxMode} // Disable if not AST mode
                    />
                )}
            </div>
            {/* Action Buttons (Replace All) */}
             <VSCodeButton
                appearance="icon"
                onClick={handleReplaceAllClick}
                disabled={!canReplace} 
                title={canReplace ? `Replace All (${numFilesThatWillChange} files)` : "Replace All (AST mode only)"}
                className={css` margin-top: 2px; /* Adjust alignment */ flex-shrink: 0; `}
              >
                <span className="codicon codicon-replace-all" />
              </VSCodeButton>
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
              {/* View Mode Toggle Buttons - LOGIC SWAPPED */}
              {hasResults && (
                 <div className={css` display: flex; align-items: center; gap: 4px; `}>
                     {/* This button now activates 'tree' mode (folder hierarchy) */}
                     <VSCodeButton 
                         appearance={viewMode === 'list' ? 'icon' : 'secondary'} 
                         onClick={() => setViewMode('tree')} 
                         title="View as tree"
                     >
                         <span className="codicon codicon-list-tree"></span> 
                     </VSCodeButton>
                     {/* This button now activates 'list' mode (grouped by file) */}
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
          {showSettings && (
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

          {/* --- Results Section --- */}
          {hasResults && (
            <div className={css`
                margin-top: 5px; // Reduced margin
                border-top: 1px solid var(--vscode-editorGroup-border, #ccc);
                padding-top: 8px; // Increased padding
                max-height: 40vh; // Use viewport height
                overflow-y: auto;
            `}>
              {/* === LIST VIEW (Grouped by file) === */}
              {viewMode === 'list' && (
                Object.entries(resultsByFile).map(([absoluteFilePathOrUri, fileResults]) => {
                  const firstResult = fileResults[0] 
                  const absoluteFilePath = uriToPath(absoluteFilePathOrUri); // Convert for path operations
                  const currentWorkspacePath = uriToPath(workspacePath); // Convert for path operations

                  // Calculate display path carefully
                  const displayPath = currentWorkspacePath && absoluteFilePath
                      ? path.relative(currentWorkspacePath, absoluteFilePath) 
                      : absoluteFilePath || absoluteFilePathOrUri; // Fallback

                  // Use POSIX path for internal state keys (expansion)
                  const posixDisplayPath = (absoluteFilePath ? displayPath.replace(/\\/g, '/') : displayPath);

                  const isExpanded = expandedFiles.has(posixDisplayPath)
                  const totalMatches = fileResults.reduce((sum, r) => sum + (r.matches?.length || 0), 0)
                  const hasError = fileResults.some(r => r.error)
                  const canExpand = totalMatches > 0;
                  const fileName = getFilename(absoluteFilePathOrUri); // Use helper for consistent display name

                  return (
                    <div key={absoluteFilePathOrUri} className={css` margin-bottom: 2px; `}>
                      <div 
                         className={css` display: flex; align-items: center; gap: 4px; padding: 2px 5px; cursor: pointer; &:hover { background-color: var(--vscode-list-hoverBackground); } `}
                         onClick={() => canExpand ? toggleFileExpansion(posixDisplayPath) : handleFileClick(absoluteFilePathOrUri)} // Use original URI/path for actions
                         title={canExpand ? `Click to ${isExpanded ? 'collapse' : 'expand'} matches in ${fileName}` : `Click to open ${fileName}`}
                      >
                        <span className={`codicon codicon-chevron-${isExpanded ? 'down' : 'right'}`} style={{ visibility: canExpand ? 'visible' : 'hidden' }}/>
                        <span className="codicon codicon-file" style={{ marginRight: '4px' }} />
                        {/* Use original URI/path for click action */}
                        <span className={css`font-weight: bold; flex-grow: 1; cursor: pointer;`} onClick={(e) => { e.stopPropagation(); handleFileClick(absoluteFilePathOrUri); }} title={`Click to open ${fileName}`}>{fileName}</span> 
                        <span className={css`color: var(--vscode-descriptionForeground);`}>
                           {totalMatches > 0 ? `${totalMatches} matches` : (hasError ? 'Error' : 'Changed')}
                        </span>
                        {/* Show (Error) indicator only if there are no matches AND there is an error */}
                        {totalMatches === 0 && hasError && 
                          <span className={css`margin-left: 8px; color: var(--vscode-errorForeground);`}>(Error)</span>}
                      </div>
                      {/* Expanded Matches */}
                      {isExpanded && canExpand && (
                        <div className={css` margin-left: 25px; /* Indent */ padding: 2px 0; `}>
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
                                        // Use original URI/path for click action
                                        onClick={() => handleResultItemClick(absoluteFilePathOrUri, { start: match.start, end: match.end })}
                                        title={`Click to open match in ${fileName}`}
                                    >
                                        {/* TODO: Display actual match context instead of just position */}
                                        Match at {match.start}...{match.end}
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
                  )
                })
              )}
              {/* === TREE VIEW (Folder hierarchy) === */}
              {viewMode === 'tree' && (
                 <div>
                    {fileTree.children.length > 0 ? (
                        fileTree.children.map(node => (
                            <TreeViewNode
                                key={node.relativePath} // relativePath is now POSIX
                                node={node}
                                level={0} // Start at level 0 for root children
                                expandedFolders={expandedFolders}
                                toggleFolderExpansion={toggleFolderExpansion} // Expects POSIX paths
                                expandedFiles={expandedFiles}
                                toggleFileExpansion={toggleFileExpansion} // Expects POSIX paths
                                handleFileClick={handleFileClick} // Expects original URI/path
                                handleResultItemClick={handleResultItemClick} // Expects original URI/path
                            />
                        ))
                    ) : (
                        <p style={{ paddingLeft: '5px', color: 'var(--vscode-descriptionForeground)' }}>No results found.</p>
                    )}
                </div>
              )}
            </div>
          )}

          {/* --- Progress Bar --- */} 
          {running && (
            <div className={css` position: relative; width: 100%; height: 4px; background-color: var(--vscode-progress-background, var(--vscode-progressBar-background)); overflow: hidden; margin-top: 5px; `}>
                <div className={css` position: absolute; top: 0; bottom: 0; left: 0; width: 50%; background: var(--vscode-progressBar-background); animation: ${leftAnim} 2s linear infinite; `} />
                <div className={css` position: absolute; top: 0; bottom: 0; right: 0; width: 50%; background: var(--vscode-progressBar-background); animation: ${rightAnim} 2s linear infinite; `} />
            </div>
          )}
        </div>
    )
}
