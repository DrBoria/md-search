import React from 'react';
import { Button } from '../../components/ui/button';
import { useSearchItem } from '../context/SearchItemContext';

export const SearchActions = () => {
    const {
        isSearching, stopSearch,
        viewMode, toggleViewMode,
        extraActions
    } = useSearchItem();

    const [showStop, setShowStop] = React.useState(false);

    React.useEffect(() => {
        let timer: NodeJS.Timeout;
        if (isSearching) {
            // Delay appearance by 1s
            timer = setTimeout(() => {
                setShowStop(true);
            }, 1000);
        } else {
            // Hide immediately (or with slight delay for smooth exit? User said: "slow animation disappearing")
            // The CSS transition will handle the visual "slow disappearance".
            // We turn off the state, and let CSS opacity fade it out.
            setShowStop(false);
        }
        return () => clearTimeout(timer);
    }, [isSearching]);

    return (
        <div className="flex items-center gap-1">
            {/* Stop Button (Animated) */}
            <div className={`overflow-hidden transition-all duration-700 ease-in-out ${showStop ? 'max-w-[24px] opacity-100 scale-100' : 'max-w-0 opacity-0 scale-75'
                }`}>
                <Button
                    onClick={stopSearch}
                    title="Stop search"
                    variant="ghost"
                    size="icon"
                    className="flex-shrink-0"
                >
                    <span className="codicon codicon-debug-pause"></span>
                </Button>
            </div>

            {/* Extra Actions from Parent (Animated) */}
            <div className={`flex items-center transition-all duration-300 ease-in-out transform origin-right ${extraActions ? 'translate-x-0 opacity-100 scale-100 max-w-[100px]' : 'translate-x-2 opacity-0 scale-75 max-w-0'
                }`}>
                {extraActions}
            </div>

            {/* View Mode Toggle */}
            <Button
                onClick={toggleViewMode}
                title={viewMode === 'tree' ? 'Switch to list view' : 'Switch to tree view'}
                variant="ghost"
                size="icon"
            >
                <span className={`codicon ${viewMode === 'tree' ? 'codicon-list-flat' : 'codicon-list-tree'}`}></span>
            </Button>
        </div>
    );
};
