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
                className="border-none focus-visible:ring-0 px-[6px] py-[4px] bg-transparent"
            />
            <div className="flex items-center gap-[2px] pr-[4px]">
                <Button
                    onClick={toggleMatchCase}
                    title="Match Case (Alt+C)"
                    variant="icon"
                    size="icon"
                    active={matchCase}
                >
                    <span className="codicon codicon-case-sensitive" />
                </Button>
                <Button
                    onClick={toggleWholeWord}
                    title="Match Whole Word (Alt+W)"
                    variant="icon"
                    size="icon"
                    active={wholeWord}
                >
                    <span className="codicon codicon-whole-word" />
                </Button>
                <Button
                    onClick={toggleRegex}
                    title="Use Regular Expression (Alt+R)"
                    variant="icon"
                    size="icon"
                    active={searchMode === 'regex'}
                >
                    <span className="codicon codicon-regex" />
                </Button>
            </div>
        </div>
    );
};
