import React from 'react';
import { Button } from '../components/ui/button';
import { useSearchItem } from './context/SearchItemContext';
import { SearchInput } from './components/SearchInput';
import { ReplaceInput } from './components/ReplaceInput';
import { SearchActions } from './components/SearchActions';
import { IndeterminateProgressBar } from './components/IndeterminateProgressBar';

interface SearchInputSectionProps {
    className?: string;
    summary?: React.ReactNode;
}

export const SearchInputSection: React.FC<SearchInputSectionProps> = ({ className = "", summary }) => {
    const {
        isReplaceVisible, toggleReplaceVisible,
        include, setInclude,
        exclude, setExclude,
        isSearching
    } = useSearchItem();
    const [isDetailsOpen, setIsDetailsOpen] = React.useState(false);

    return (
        <div className={`flex flex-col gap-1 ${className} relative`}> {/* Added relative */}

            {/* Row 1: Find Input + Toggle + Actions (Collapsible) */}
            <div className="flex items-start gap-1 relative">
                <div className="flex-shrink-0 w-[24px] flex justify-center mt-[4px]">
                    <Button
                        onClick={toggleReplaceVisible}
                        title="Toggle Replace"
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 p-0"
                    >
                        <span className={`codicon codicon-chevron-${isReplaceVisible ? 'down' : 'right'}`}></span>
                    </Button>
                </div>

                <div className="flex-grow min-w-0 transition-all duration-300 ease-in-out">
                    <SearchInput />
                </div>

                {/* Actions in Row 1: Visible only when Replace is CLOSED */}
                <div className={`flex-shrink-0 overflow-hidden transition-all duration-300 ease-in-out ${!isReplaceVisible ? 'max-w-[200px] opacity-100 mt-[2px]' : 'max-w-0 opacity-0 mt-[2px]'
                    }`}>
                    <SearchActions />
                </div>
            </div>

            {/* Row 2: Replace Input (Animated) */}
            <div
                className={`grid transition-all duration-300 ease-in-out ${isReplaceVisible ? 'grid-rows-[1fr] opacity-100 mt-1' : 'grid-rows-[0fr] opacity-0 mt-0'
                    }`}
            >
                <div className="overflow-hidden">
                    <div className="flex items-start gap-1">
                        {/* Indent - MUST MATCH Toggle Button width */}
                        <div className="flex-shrink-0 w-[24px]" />

                        <div className="flex-grow min-w-0 transition-all duration-300 ease-in-out">
                            <ReplaceInput />
                        </div>

                        {/* Actions in Row 2: Visible only when Replace is OPEN */}
                        <div className={`flex-shrink-0 overflow-hidden transition-all duration-300 ease-in-out ${isReplaceVisible ? 'max-w-[200px] opacity-100 mt-[2px]' : 'max-w-0 opacity-0 mt-[2px]'
                            }`}>
                            <div className="pl-1"> {/* Tiny padding to separate from input */}
                                <SearchActions />
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Row 3: Toggle Row (Contains Summary [Closed] OR Inputs [Open] + Toggle Button) */}
            <div className="flex items-start gap-1 mt-1">

                {/* Left Side Container: Swaps between Summary and Inputs */}
                <div className="flex-grow min-w-0 flex flex-col">

                    {/* Mode A: Summary (Visible when CLOSED) */}
                    <div
                        className={`grid transition-all duration-300 ease-in-out ${!isDetailsOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                            }`}
                    >
                        <div className="overflow-hidden min-h-0">
                            <div className="pt-1 select-none"> {/* Align center with button roughly */}
                                {summary}
                            </div>
                        </div>
                    </div>

                    {/* Mode B: Inputs (Visible when OPEN) */}
                    <div
                        className={`grid transition-all duration-300 ease-in-out ${isDetailsOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                            }`}
                    >
                        <div className="overflow-hidden min-h-0">
                            <div className="flex flex-col gap-2 w-full pt-1">
                                <div className="flex flex-col gap-1 w-full">
                                    <span className="text-xs font-bold text-[var(--vscode-input-placeholderForeground)] truncate leading-4 block">files to include</span>
                                    <input
                                        type="text"
                                        className="w-full bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded-[2px] h-[26px] px-1 focus:outline-none focus:border-[var(--vscode-focusBorder)]"
                                        value={include || ''}
                                        onChange={(e) => setInclude(e.target.value)}
                                    />
                                </div>
                                <div className="flex flex-col gap-1 w-full">
                                    <span className="text-xs font-bold text-[var(--vscode-input-placeholderForeground)] truncate leading-4 block">files to exclude</span>
                                    <input
                                        type="text"
                                        className="w-full bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded-[2px] h-[26px] px-1 focus:outline-none focus:border-[var(--vscode-focusBorder)]"
                                        value={exclude || ''}
                                        onChange={(e) => setExclude(e.target.value)}
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                </div>

                {/* Right Side: Toggle Button */}
                <div className={`flex-shrink-0 pt-1 transition-all duration-300 ease-in-out ${isDetailsOpen ? 'mt-[20px]' : 'mt-0'}`}>
                    <Button
                        onClick={() => setIsDetailsOpen(!isDetailsOpen)}
                        title="Toggle Search Details"
                        variant="icon"
                        size="icon"
                        active={isDetailsOpen}
                        className="h-[26px] w-[26px]"
                    >
                        <span className="codicon codicon-ellipsis" />
                    </Button>
                </div>
            </div>

            {/* Row 4: Summary (Moved down when OPEN) */}
            <div
                className={`transition-all duration-300 ease-in-out overflow-hidden ${isDetailsOpen ? 'grid grid-rows-[1fr] opacity-100 mt-1' : 'grid grid-rows-[0fr] opacity-0 mt-0'
                    }`}
            >
                <div className="overflow-hidden min-h-0">
                    {summary}
                </div>
            </div>

            {/* Progress Bar - Absolute positioning to stick to bottom or just below Row 1/2? 
                Actually, simpler to allow it to push content or overlay.
                Overlay at bottom of section.
            */}
            {/* Progress Bar - Only valid if searching AND not paused (handled by isSearching) */}
            {isSearching && (
                <div className="absolute bottom-[-1px] left-0 right-0 z-20 h-[2px]">
                    <IndeterminateProgressBar />
                </div>
            )}
        </div>
    );
};
