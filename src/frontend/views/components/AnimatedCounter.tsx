import React, { useEffect, useState, useRef } from 'react';

interface AnimatedCounterProps {
    value: number;
    className?: string;
    prefix?: string;
    suffix?: string;
}

// OdometerDigit handles the animation of a single digit
const OdometerDigit = ({ digit, direction }: { digit: number; direction: 'up' | 'down' }) => {
    const [prevDigit, setPrevDigit] = useState(digit);
    const [animating, setAnimating] = useState(false);
    const [animationKey, setAnimationKey] = useState(0); // Force re-render for restart

    useEffect(() => {
        if (digit !== prevDigit) {
            setAnimating(true);
            // Reset animation state
            setAnimationKey(k => k + 1);

            const timer = setTimeout(() => {
                setAnimating(false);
                setPrevDigit(digit);
            }, 600); // 600ms match CSS
            return () => clearTimeout(timer);
        }
    }, [digit]);

    // If not animating, just show current digit
    if (!animating && prevDigit === digit) {
        return (
            <span className="inline-block relative overflow-hidden align-bottom" style={{ height: '1.5em', width: '0.6em', lineHeight: '1.5em', verticalAlign: 'bottom' }}>
                <span className="flex items-center justify-center h-full">{digit}</span>
            </span>
        );
    }

    // While animating, we render a strip of TWO digits: [Top, Bottom]
    // If direction UP: [Prev, Current]. Animate 0 -> -1.5em. (Move UP)
    // If direction DOWN: [Current, Prev]. Animate -1.5em -> 0. (Move DOWN)

    // Note: direction applies to the *counter* change. 
    // Increments (UP): Old rolls up and out. New rolls up and in. 
    //   Layout: [Old]
    //           [New]
    //   Transform: 0 -> -50%

    // Decrements (DOWN): Old rolls down and out. New rolls down and in.
    //   Layout: [New]
    //           [Old]
    //   Transform: -50% -> 0

    const topDigit = direction === 'up' ? prevDigit : digit;
    const bottomDigit = direction === 'up' ? digit : prevDigit;

    const startY = direction === 'up' ? '0%' : '-50%';
    const endY = direction === 'up' ? '-50%' : '0%';

    return (
        <div
            className="inline-block relative overflow-hidden align-bottom"
            style={{
                height: '1.5em',
                width: '0.6em',
                verticalAlign: 'bottom',
                lineHeight: '1.5em'
            }}
        >
            {/* Key ensures we reset the animation/element when Key changes */}
            <div
                key={animationKey}
                className="flex flex-col will-change-transform blur-[0.3px]"
                // We use animation instead of transition for reliable from->to reset
                style={{
                    height: '3em', // 2 items * 1.5em
                    animation: `slide-${direction} 0.6s cubic-bezier(0.45, 0.05, 0.55, 0.95) forwards`,
                }}
            >
                <style>
                    {`
                    @keyframes slide-up {
                        from { transform: translateY(0%); }
                        to { transform: translateY(-50%); }
                    }
                    @keyframes slide-down {
                        from { transform: translateY(-50%); }
                        to { transform: translateY(0%); }
                    }
                    `}
                </style>
                <div style={{ height: '1.5em', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {topDigit}
                </div>
                <div style={{ height: '1.5em', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {bottomDigit}
                </div>
            </div>
        </div>
    );
};

export const AnimatedCounter: React.FC<AnimatedCounterProps> = ({
    value,
    className = "",
    prefix = "",
    suffix = ""
}) => {
    const prevValueRef = useRef(value);
    const [direction, setDirection] = useState<'up' | 'down'>('up');

    // Update direction when value changes
    if (value !== prevValueRef.current) {
        setDirection(value > prevValueRef.current ? 'up' : 'down');
        prevValueRef.current = value;
    }

    const chars = value.toLocaleString().split('');

    return (
        <span className={`inline-flex items-center ${className}`} style={{ fontVariantNumeric: 'tabular-nums' }}>
            {prefix && <span className="mr-0.5">{prefix}</span>}
            {chars.map((char, index) => {
                if (/[0-9]/.test(char)) {
                    // Start from right to maintain key stability? 
                    // Actually index is fine for simple counter.
                    // If length changes (10 -> 9), keys shift?
                    // 10 (keys 0,1) -> 9 (key 0).
                    // key 0 (was 1) becomes 9. key 1 is removed.
                    // This is acceptable behavior.
                    return <OdometerDigit key={index} digit={parseInt(char)} direction={direction} />;
                } else {
                    return <span key={index} style={{ height: '1.5em', lineHeight: '1.5em' }}>{char}</span>;
                }
            })}
            {suffix && <span className="ml-0.5">{suffix}</span>}
        </span>
    );
};
