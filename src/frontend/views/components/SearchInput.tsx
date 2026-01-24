import React from 'react';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { useSearchItem } from '../context/SearchItemContext';

export const SearchInput = () => {
    const {
        find, setFind,
        matchCase, toggleMatchCase,
        wholeWord, toggleWholeWord,
        searchMode, toggleRegex,
        inputRef
    } = useSearchItem();

    return (
        <div className="relative flex items-center bg-[var(--vscode-input-background)] border border-[var(--vscode-input-border)] rounded-[2px] focus-within:border-[var(--vscode-focusBorder)]">
            <Textarea
                ref={inputRef}
                placeholder="search"
                aria-label="Search Pattern"
                name="search"
                rows={1}
                value={find}
                onChange={(e) => setFind(e.target.value)}
                className="border-none focus-visible:ring-0 pl-[6px] py-[4px] pr-[70px] bg-transparent min-h-[26px] overflow-x-hidden overflow-y-hidden resize-none whitespace-pre-wrap break-all"
                onInput={(e) => {
                    const target = e.target as HTMLTextAreaElement;
                    target.style.height = 'auto'; // Reset height
                    target.style.height = `${target.scrollHeight}px`; // Set to scrollHeight
                }}
            />
            <div className="absolute right-[2px] top-[2px] flex items-center gap-[1px]">
                <Button
                    onClick={toggleMatchCase}
                    title="Match Case (Alt+C)"
                    variant="icon"
                    size="icon"
                    active={matchCase}
                    className="w-[20px] h-[20px] p-0"
                >
                    <span className="codicon codicon-case-sensitive text-[14px]" />
                </Button>
                <Button
                    onClick={toggleWholeWord}
                    title="Match Whole Word (Alt+W)"
                    variant="icon"
                    size="icon"
                    active={wholeWord}
                    className="w-[20px] h-[20px] p-0"
                >
                    <span className="codicon codicon-whole-word text-[14px]" />
                </Button>
                <Button
                    onClick={toggleRegex}
                    title="Use Regular Expression (Alt+R)"
                    variant="icon"
                    size="icon"
                    active={searchMode === 'regex'}
                    className="w-[20px] h-[20px] p-0"
                >
                    <span className="codicon codicon-regex text-[14px]" />
                </Button>
            </div>
        </div>
    );
};
