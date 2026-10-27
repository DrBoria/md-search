import React from 'react';
import { Button } from '../../components/ui/button';

interface FindInFoundButtonProps {
    onClick: () => void;
    visible: boolean;
    forceHide?: boolean; // New prop for immediate hiding
}

export const FindInFoundButton: React.FC<FindInFoundButtonProps> = ({ onClick, visible, forceHide }) => {
    const [render, setRender] = React.useState(visible && !forceHide);
    const [animating, setAnimating] = React.useState(false);

    const unmountTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
    const debounceTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);

    React.useEffect(() => {
        if (forceHide) {
            // Immediate animatable hide - Skip debounce, but play exit animation
            if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
            if (unmountTimeoutRef.current) clearTimeout(unmountTimeoutRef.current);

            setAnimating(false); // Trigger exit animation

            // Unmount after animation duration
            unmountTimeoutRef.current = setTimeout(() => {
                setRender(false);
            }, 300);
            return;
        }

        if (visible) {
            // Cancel pending hide sequence
            if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
            if (unmountTimeoutRef.current) clearTimeout(unmountTimeoutRef.current);

            setRender(true);
            // Small delay to ensure render happens before opacity transition
            setTimeout(() => setAnimating(true), 10);
        } else {
            // Start debounce timer
            if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);

            debounceTimeoutRef.current = setTimeout(() => {
                // First fade out
                setAnimating(false);

                // Then unmount after animation duration (300ms)
                if (unmountTimeoutRef.current) clearTimeout(unmountTimeoutRef.current);
                unmountTimeoutRef.current = setTimeout(() => {
                    setRender(false);
                }, 300);

            }, 500); // 500ms debounce
        }

        return () => {
            if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
            if (unmountTimeoutRef.current) clearTimeout(unmountTimeoutRef.current);
        };
    }, [visible, forceHide]);

    if (!render) return null;

    return (
        <div className={`overflow-hidden transition-all duration-300 ease-in-out ${animating ? 'max-w-[30px] opacity-100 scale-100' : 'max-w-0 opacity-0 scale-0'
            }`}>
            <Button
                onClick={onClick}
                title="Search within these results"
                variant="ghost"
                size="icon"
            >
                <span className="codicon codicon-search" />
            </Button>
        </div>
    );
};
