import React from 'react';
import { Button } from '../components/ui/button';
import { useSearchItem } from './context/SearchItemContext';
import { SearchInput } from './components/SearchInput';
import { ReplaceInput } from './components/ReplaceInput';
import { SearchActions } from './components/SearchActions';

interface SearchInputSectionProps {
    className?: string;
}

export const SearchInputSection: React.FC<SearchInputSectionProps> = ({ className = "" }) => {
    const {
        isReplaceVisible, toggleReplaceVisible,
        include, setInclude,
        exclude, setExclude
    } = useSearchItem();
    const [isDetailsOpen, setIsDetailsOpen] = React.useState(false);

    return (
        <div className={`flex flex-col gap-1 ${className}`}>

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

            {/* Row 3: Toggle Search Details Button */}
            <div className="flex justify-end px-1 mt-1">
                <Button
                    onClick={() => setIsDetailsOpen(!isDetailsOpen)}
                    title="Toggle Search Details"
                    variant="icon"
                    size="icon"
                    active={isDetailsOpen}
                >
                    <span className="codicon codicon-ellipsis" />
                </Button>
            </div>

            {/* Row 4: Include/Exclude Inputs */}
            <div
                className={`grid transition-all duration-300 ease-in-out ${isDetailsOpen ? 'grid-rows-[1fr] opacity-100 mt-1' : 'grid-rows-[0fr] opacity-0 mt-0'
                    }`}
            >
                <div className="overflow-hidden ml-[24px]">
                    <div className="flex flex-col gap-1 pb-1">
                        <div className="flex flex-col gap-1">
                            <span className="text-xs font-bold text-[var(--vscode-input-placeholderForeground)]">files to include</span>
                            <input
                                type="text"
                                className="bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded-[2px] h-[26px] px-1 focus:outline-none focus:border-[var(--vscode-focusBorder)]"
                                value={include || ''}
                                onChange={(e) => setInclude(e.target.value)}
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <span className="text-xs font-bold text-[var(--vscode-input-placeholderForeground)]">files to exclude</span>
                            <div className="flex items-center gap-1">
                                <input
                                    type="text"
                                    className="flex-grow bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded-[2px] h-[26px] px-1 focus:outline-none focus:border-[var(--vscode-focusBorder)]"
                                    value={exclude || ''}
                                    onChange={(e) => setExclude(e.target.value)}
                                />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
