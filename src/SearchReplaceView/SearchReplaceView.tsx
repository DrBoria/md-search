import React, { useState, useCallback, useMemo } from 'react'
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
  MessageFromWebview,
  SerializedTransformResultEvent,
  SearchReplaceViewStatus,
  SearchReplaceViewValues,
} from './SearchReplaceViewTypes'

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

// Helper to extract filename from full path string
const getFilename = (path: string): string => {
  // Basic implementation, might need adjustment based on actual path formats
  return path.substring(path.lastIndexOf('/') + 1)
}

// Define props including the vscode api from controller
interface SearchReplaceViewProps {
  status: SearchReplaceViewStatus
  values: SearchReplaceViewValues
  results: SerializedTransformResultEvent[]
  onValuesChange: (values: Partial<SearchReplaceViewValues>) => unknown
  onReplaceAllClick: (e: React.SyntheticEvent<any>) => unknown
  vscode: {
    postMessage(message: MessageFromWebview): void
  }
}

export default function SearchReplaceView({
  status,
  values,
  results,
  onValuesChange,
  onReplaceAllClick,
  vscode, // Get vscode api from props
}: SearchReplaceViewProps): React.ReactElement {
  const {
    running,
    completed,
    total,
    numMatches,
    numFilesWithMatches,
    numFilesWithErrors,
    numFilesThatWillChange,
  } = status

  // --- State for Search Options ---
  const [isReplaceVisible, setIsReplaceVisible] = useState(false)
  const [showSettings, setShowSettings] = useState(true)
  const [viewMode, setViewMode] = useState<'list' | 'tree'>('list')
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  // Use values from props for initial state, default to false/text if not provided
  const [currentSearchMode, setCurrentSearchMode] = useState<SearchReplaceViewValues['searchMode']>(values.searchMode ?? 'text')
  const [matchCase, setMatchCase] = useState(values.matchCase ?? false)
  const [wholeWord, setWholeWord] = useState(values.wholeWord ?? false)

  const toggleReplace = useCallback(() => setIsReplaceVisible((v) => !v), [])
  const toggleSettings = useCallback(() => setShowSettings((v) => !v), [])

  const handleFindChange = useCallback((e: any) => {
    onValuesChange({ find: e.target.value })
  }, [onValuesChange])

  const handleReplaceChange = useCallback((e: any) => {
    onValuesChange({ replace: e.target.value })
  }, [onValuesChange])

  // --- Handlers for new options ---
  const toggleMatchCase = useCallback(() => {
    const next = !matchCase;
    setMatchCase(next);
    onValuesChange({ matchCase: next });
  }, [matchCase, onValuesChange]);

  const toggleWholeWord = useCallback(() => {
    const next = !wholeWord;
    setWholeWord(next);
    onValuesChange({ wholeWord: next });
  }, [wholeWord, onValuesChange]);

  const handleModeChange = useCallback((newMode: SearchReplaceViewValues['searchMode']) => {
      // If clicking the currently active mode button (excluding text), switch back to text mode
      const finalMode = (newMode === currentSearchMode && newMode !== 'text') ? 'text' : newMode;
      setCurrentSearchMode(finalMode);
      onValuesChange({ searchMode: finalMode });
  }, [currentSearchMode, onValuesChange]);

  const handleRerunAutomaticallyChange = useCallback((e: any) => {
    onValuesChange({ paused: !e.target.checked })
  }, [onValuesChange])

  const handleIncludeChange = useCallback((e: any) => {
    onValuesChange({ include: e.target.value })
  }, [onValuesChange])

  const handleExcludeChange = useCallback((e: any) => {
    onValuesChange({ exclude: e.target.value })
  }, [onValuesChange])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleParserChange = useCallback((e: any) => {
    onValuesChange({ parser: e.target.value })
  }, [onValuesChange])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlePrettierChange = useCallback((e: any) => {
    onValuesChange({ prettier: e.target.checked })
  }, [onValuesChange])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleBabelGeneratorHackChange = useCallback((e: any) => {
    onValuesChange({ babelGeneratorHack: e.target.checked })
  }, [onValuesChange])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlePreferSimpleReplacementChange = useCallback((e: any) => {
    onValuesChange({ preferSimpleReplacement: e.target.checked })
  }, [onValuesChange])

  const handleKeyDown = useEvent((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) {
      // Potential future use for shortcuts
    }
  })

  const toggleFileExpansion = useCallback((filePath: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(filePath)) {
        next.delete(filePath)
      } else {
        next.add(filePath)
      }
      return next
    })
  }, [])

  const handleFileClick = useCallback(
    (filePath: string) => {
      vscode.postMessage({ type: 'openFile', filePath })
    },
    [vscode]
  )

  // Modified click handler to optionally include range start
  const handleResultItemClick = useCallback(
    (filePath: string, range?: { start: number; end: number }) => {
      vscode.postMessage({ 
        type: 'openFile', 
        filePath, 
        // Use property shorthand if range exists
        ...(range && { range })
      });
    },
    [vscode]
  );

  // Group results by file for tree view
  const resultsByFile = useMemo(() => {
    return results.reduce((acc, result) => {
      if (!acc[result.file]) {
        acc[result.file] = []
      }
      acc[result.file].push(result)
      // For tree view, we might only care about the *first* result object for a file
      // if we list matches separately. Or keep all if needed.
      return acc
    }, {} as Record<string, SerializedTransformResultEvent[]>)
  }, [results])

  // Determine if replacement should be enabled (only for ASTX mode for now)
  // We'll assume ASTX mode corresponds to !useRegex for this example
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
            onClick={onReplaceAllClick}
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
             {results.length > 0 && (
                <span className={css` color: var(--vscode-descriptionForeground); `}>
                    {`${numMatches} results in ${numFilesWithMatches} files`}
                </span>
             )}
          </div>
          {/* View Mode Toggle Buttons */}
          {results.length > 0 && (
             <div className={css` display: flex; align-items: center; gap: 4px; `}>
                 <VSCodeButton appearance={viewMode === 'tree' ? 'icon' : 'secondary'} onClick={() => setViewMode('list')} title="View as list">
                     <span className="codicon codicon-list-flat"></span>
                 </VSCodeButton>
                 <VSCodeButton appearance={viewMode === 'list' ? 'icon' : 'secondary'} onClick={() => setViewMode('tree')} title="View as tree">
                     <span className="codicon codicon-list-tree"></span>
                 </VSCodeButton>
             </div>
          )}
      </div>

      {/* --- Collapsible Settings Panel --- */} 
      {showSettings && (
        <div
          className={css`
            display: flex;
            flex-direction: column;
            gap: 5px;
          `}
        >
          <VSCodeTextField
            name="filesToInclude"
            value={values.include}
            onInput={handleIncludeChange}
          >
            files to include
          </VSCodeTextField>
          <VSCodeTextField
            name="filesToExclude"
            value={values.exclude}
            onInput={handleExcludeChange}
          >
            files to exclude
          </VSCodeTextField>
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
      {results.length > 0 && (
        <div className={css`
            margin-top: 5px; // Reduced margin
            border-top: 1px solid var(--vscode-editorGroup-border, #ccc);
            padding-top: 8px; // Increased padding
            max-height: 40vh; // Use viewport height
            overflow-y: auto;
        `}>
          {viewMode === 'list' ? (
            // --- List View --- 
            results.map((result, index) => (
              <div 
                key={`${result.file}-${index}`}
                className={css` 
                  margin-bottom: 4px; 
                  padding: 2px 5px;
                  cursor: pointer;
                  &:hover { background-color: var(--vscode-list-hoverBackground); }
                `}
                onClick={() => handleResultItemClick(result.file)} 
                title={`Click to open ${getFilename(result.file)}`}
              >
                <span className={css`font-weight: bold;`}>{getFilename(result.file)}</span>
                <span className={css`margin-left: 8px; color: var(--vscode-descriptionForeground);`}>
                  {/* Prioritize match count, then check for error */}
                  {result.matches && result.matches.length > 0
                    ? `${result.matches.length} matches`
                    : (result.error != null ? 'Error' : 'Changed')}
                </span>
                 {/* Show (Error) indicator only if there are no matches AND there is an error */}
                 {(!result.matches || result.matches.length === 0) && result.error != null && 
                   <span className={css`margin-left: 8px; color: var(--vscode-errorForeground);`}>(Error)</span>}
              </div>
            ))
          ) : (
            // --- Tree View --- 
            Object.entries(resultsByFile).map(([filePath, fileResults]) => {
              const firstResult = fileResults[0] // Use first result for file-level info
              const isExpanded = expandedFiles.has(filePath)
              const totalMatches = fileResults.reduce((sum, r) => sum + (r.matches?.length || 0), 0)
              const hasError = fileResults.some(r => r.error)

              return (
                <div key={filePath} className={css` margin-bottom: 2px; `}>
                  {/* File Entry */}
                  <div 
                     className={css` 
                       display: flex; 
                       align-items: center; 
                       gap: 4px; 
                       padding: 2px 5px;
                       cursor: pointer;
                       &:hover { background-color: var(--vscode-list-hoverBackground); }
                     `}
                     onClick={() => totalMatches > 0 ? toggleFileExpansion(filePath) : handleResultItemClick(filePath)} // Expand if matches, otherwise open
                     title={totalMatches > 0 ? `Click to ${isExpanded ? 'collapse' : 'expand'}` : `Click to open ${getFilename(filePath)}`}
                  >
                    <span className={`codicon codicon-chevron-${isExpanded ? 'down' : 'right'}`} 
                          style={{ visibility: totalMatches > 0 ? 'visible' : 'hidden' }}/>
                    <span className={css`font-weight: bold; flex-grow: 1; cursor: pointer;`} 
                          onClick={(e) => { e.stopPropagation(); handleResultItemClick(filePath); }} 
                          title={`Click to open ${getFilename(filePath)}`}>{getFilename(filePath)}</span> 
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
                  {/* Expanded Matches/Details (Simplified) */}
                  {isExpanded && (
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
                               onClick={() => handleResultItemClick(filePath, { start: match.start, end: match.end })} 
                               title={`Click to open match in ${getFilename(filePath)}`}
                          >
                            {/* TODO: Display actual match context instead of just position */}
                            Match at {match.start}...{match.end}
                          </div>
                        ))
                      ))}
                      {/* Display error if present and no matches shown */}
                      {hasError && totalMatches === 0 && (
                           <div className={css` color: var(--vscode-errorForeground); padding: 1px 5px; `}>
                              {/* Display actual error message if available */}
                              {String(firstResult.error?.message || firstResult.error || 'Error occurred')}
                           </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}

      {/* --- Progress Bar --- */} 
      {running && (
        <div
          className={css`
            position: relative;
            width: 100%;
            height: 4px;
            background-color: var(--vscode-progressBar-background);
            overflow: hidden;
            margin-top: 5px;
          `}
        >
          <div
            className={css`
              position: absolute;
              top: 0;
              bottom: 0;
              left: 0;
              background-color: var(--vscode-progressBar-background);
              animation: ${leftAnim} 2s linear infinite;
            `}
          />
          <div
            className={css`
              position: absolute;
              top: 0;
              bottom: 0;
              right: 0;
              background-color: var(--vscode-progressBar-background);
              animation: ${rightAnim} 2s linear infinite;
            `}
          />
        </div>
      )}
    </div>
  )
}
