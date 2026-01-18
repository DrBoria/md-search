import React from 'react';
import { Button } from '../../components/ui/button';

interface FindInFoundButtonProps {
    onClick: () => void;
    visible: boolean;
}

export const FindInFoundButton: React.FC<FindInFoundButtonProps> = ({ onClick, visible }) => {
    const [render, setRender] = React.useState(visible);
    const [animating, setAnimating] = React.useState(false);

    React.useEffect(() => {
        if (visible) {
            setRender(true);
            setTimeout(() => setAnimating(true), 10);
        } else {
            setAnimating(false);
            const timer = setTimeout(() => setRender(false), 300); // match duration
            return () => clearTimeout(timer);
        }
    }, [visible]);

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
