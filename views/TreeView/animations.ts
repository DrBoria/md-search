import { useCallback, useRef, useState, useEffect } from 'react';

// Animation constants
export const ANIMATION_DURATION = 200;
export const ANIMATION_EASING = 'ease-out';

/**
 * Custom plugin for @formkit/auto-animate in virtualized lists.
 * Handles add/remove/remain animations for list items.
 */
export const createVirtualListAnimatePlugin = () => {
    // Using 'any' for coords to match auto-animate's flexible typing
    return (el: Element, action: string, oldCoords: any, newCoords: any) => {
        let keyframes: Keyframe[] = [];

        // Guard against undefined coordinates
        if (!oldCoords || !newCoords) {
            return new KeyframeEffect(el, [], { duration: 0 });
        }

        if (action === 'add') {
            keyframes = [
                { transform: 'translateY(10px)', opacity: 0 },
                { transform: 'translateY(0)', opacity: 1 }
            ];
            return new KeyframeEffect(el, keyframes, { duration: 150, easing: ANIMATION_EASING });
        }

        if (action === 'remove') {
            if (!oldCoords.height) {
                return new KeyframeEffect(el, [], { duration: 0 });
            }
            keyframes = [
                { height: `${oldCoords.height}px`, opacity: 1, transform: 'scale(1)' },
                { height: '0px', opacity: 0, transform: 'scale(0.98)' }
            ];
            return new KeyframeEffect(el, keyframes, { duration: ANIMATION_DURATION, easing: ANIMATION_EASING });
        }

        if (action === 'remain') {
            const deltaX = (oldCoords.left || 0) - (newCoords.left || 0);
            const deltaY = (oldCoords.top || 0) - (newCoords.top || 0);

            const start: Record<string, string> = { transform: `translate(${deltaX}px, ${deltaY}px)` };
            const end: Record<string, string> = { transform: 'translate(0, 0)' };

            if (oldCoords.width !== newCoords.width) {
                start.width = `${oldCoords.width}px`;
                end.width = `${newCoords.width}px`;
            }
            if (oldCoords.height !== newCoords.height) {
                start.height = `${oldCoords.height}px`;
                end.height = `${newCoords.height}px`;
            }

            return new KeyframeEffect(el, [start, end], { duration: 150, easing: ANIMATION_EASING });
        }

        return new KeyframeEffect(el, keyframes, { duration: 150, easing: ANIMATION_EASING });
    };
};

/**
 * Hook for height-based collapse/expand animation.
 * Returns state and ref needed to animate a container's height.
 */
export const useCollapseAnimation = (isOpen: boolean) => {
    const [height, setHeight] = useState<number | 'auto'>(isOpen ? 'auto' : 0);
    const [overflow, setOverflow] = useState<'hidden' | 'visible'>(isOpen ? 'visible' : 'hidden');
    const [isVisible, setIsVisible] = useState(isOpen);
    const [isAnimating, setIsAnimating] = useState(false);

    const ref = useRef<HTMLDivElement | null>(null);
    const timeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
    const isFirstRender = useRef(true);

    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }

        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
        }

        setIsAnimating(true);

        if (isOpen) {
            setIsVisible(true);
            setOverflow('hidden');
            setHeight(0);

            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (ref.current) {
                        setHeight(ref.current.scrollHeight);
                        timeoutRef.current = setTimeout(() => {
                            setHeight('auto');
                            setOverflow('visible');
                            setIsAnimating(false);
                        }, ANIMATION_DURATION + 50);
                    }
                });
            });
        } else {
            const el = ref.current;
            if (el) {
                setHeight(el.scrollHeight);
                setOverflow('hidden');

                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        setHeight(0);
                        timeoutRef.current = setTimeout(() => {
                            setIsVisible(false);
                            setIsAnimating(false);
                        }, ANIMATION_DURATION + 50);
                    });
                });
            }
        }

        return () => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
        };
    }, [isOpen]);

    const handleTransitionEnd = useCallback((e: React.TransitionEvent) => {
        if (e.target !== e.currentTarget) return;

        if (timeoutRef.current) clearTimeout(timeoutRef.current);

        if (isOpen) {
            setHeight('auto');
            setOverflow('visible');
        } else {
            setIsVisible(false);
        }
        setIsAnimating(false);
    }, [isOpen]);

    return {
        ref,
        height,
        overflow,
        isVisible,
        isAnimating,
        handleTransitionEnd
    };
};

/**
 * Configuration for auto-animate based on item count.
 * Disables animation for large lists to prevent performance issues.
 */
export const getAutoAnimateConfig = (itemCount: number) => {
    if (itemCount < 100) {
        return { duration: 150, easing: 'ease-in-out' as const };
    }
    return { duration: 0 };
};
