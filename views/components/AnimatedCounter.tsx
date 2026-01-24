import React, { useState, useEffect, useRef } from 'react';
import { cn } from "../../utils";

interface AnimatedCounterProps {
    value: number;
    className?: string;
    prefix?: string;
    suffix?: string;
}

// 0-9 repeated 3 times: [0..9] [0..9] [0..9]
// This gives us a safe buffer to scroll in either direction and snap back to the center.
const STRIP = Array.from({ length: 30 }, (_, i) => i % 10);

function Digit({ char, direction }: { char: string, direction: number }) {
    const isNumber = /^\d$/.test(char);
    const targetDigit = isNumber ? parseInt(char) : 0;

    // Position 15 is the center "5".
    // 0 [0..9] 10 [0..9] 20 [0..9]
    // We ideally want to stay in the range [10, 19].
    const [position, setPosition] = useState(10 + targetDigit);
    const [isAnimating, setIsAnimating] = useState(false);

    // We store the current target digit to detect changes
    const prevCharRef = useRef(char);

    useEffect(() => {
        if (prevCharRef.current === char) {
            // Ensure position is correct on mount/steady state
            setPosition(10 + targetDigit);
            return;
        }
        prevCharRef.current = char;

        if (!isNumber) {
            // Non-numeric handling: just reset
            return;
        }

        setPosition(prevPos => {
            const currentDigit = prevPos % 10;
            let diff = targetDigit - currentDigit;

            // Adjust diff to match desired direction
            if (direction > 0) {
                // Moving UP (increasing value) = Index increases (strip moves up)
                while (diff <= 0) diff += 10;
            } else if (direction < 0) {
                // Moving DOWN (decreasing value) = Index decreases (strip moves down)
                while (diff >= 0) diff -= 10;
            }

            const nextPos = prevPos + diff;
            setIsAnimating(true);
            return nextPos;
        });
    }, [char, targetDigit, direction, isNumber]);

    const handleTransitionEnd = () => {
        setIsAnimating(false);
        // Snap back to the center range [10..19]
        setPosition(prev => {
            const digit = prev % 10;
            // JS modulo of negative numbers can be negative, ensure positive index
            const positiveDigit = (digit + 10) % 10;
            return 10 + positiveDigit;
        });
    };

    if (!isNumber) {
        return <span className="inline-block relative">{char}</span>;
    }

    return (
        <span className="inline-flex relative h-[1.3em] w-[0.8ch] overflow-hidden items-center justify-center -mb-[0.1em]">
            <span
                className={cn(
                    "absolute left-0 w-full flex flex-col will-change-transform",
                    isAnimating ? "transition-transform duration-500 ease-in-out" : "transition-none"
                )}
                style={{ transform: `translateY(-${(position / 30) * 100}%)`, top: 0 }}
                onTransitionEnd={handleTransitionEnd}
            >
                {STRIP.map((n, i) => (
                    <span key={i} className="h-[1.3em] flex items-center justify-center leading-none">
                        {n}
                    </span>
                ))}
            </span>
            {/* Spacer to hold width/height */}
            <span className="opacity-0 pointer-events-none font-mono">0</span>
        </span>
    );
}

export function AnimatedCounter({
    value,
    className = "",
    prefix = "",
    suffix = ""
}: AnimatedCounterProps) {
    const displayValue = Number.isFinite(value) ? value : 0;
    const chars = displayValue.toLocaleString().split('');

    // Track direction based on total value change
    const prevValueRef = useRef(displayValue);
    const directionRef = useRef(0);

    // Update direction only when value changes
    if (displayValue !== prevValueRef.current) {
        directionRef.current = displayValue > prevValueRef.current ? 1 : -1;
        prevValueRef.current = displayValue;
    }
    const direction = directionRef.current;

    return (
        <span className={cn("inline-flex items-center", className)} style={{ fontVariantNumeric: 'tabular-nums' }}>
            {prefix && <span className="mr-0.5">{prefix}</span>}
            {chars.map((char, index) => {
                return <Digit key={index} char={char} direction={direction} />;
            })}
            {suffix && <span className="ml-1">{suffix}</span>}
        </span>
    );
}
