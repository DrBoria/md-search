import { useCallback, useRef, useState, useEffect } from 'react';

// Animation constants
export const ANIMATION_DURATION = 200;
export const ANIMATION_EASING = 'ease-out';

/**
 * Custom settings for @formkit/auto-animate to inhibit add/remove animations.
 * We ONLY want to animate moves (reordering).
 */
export const createVirtualListAnimatePlugin = (isScrollingRef: { current: boolean }) => {
    return (el: Element, action: string, oldCoords: any, newCoords: any) => {
        // Guard: Do not animate if scrolling (prevents fighting against scroll)
        if (isScrollingRef.current) {
            return new KeyframeEffect(el, [], { duration: 0 });
        }

        // Disable ADD and REMOVE animations to prevent glitches
        if (action === 'add' || action === 'remove') {
            return new KeyframeEffect(el, [], { duration: 0 });
        }

        // Handle moves (remain) - FLIP animation
        if (action === 'remain') {
            const deltaX = (oldCoords.left || 0) - (newCoords.left || 0);
            const deltaY = (oldCoords.top || 0) - (newCoords.top || 0);

            // If no movement, no animation
            if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) {
                return new KeyframeEffect(el, [], { duration: 0 });
            }

            const start: Record<string, string> = { transform: `translate(${deltaX}px, ${deltaY}px)` };
            const end: Record<string, string> = { transform: 'translate(0, 0)' };

            // Handle size changes if needed
            if (oldCoords.width !== newCoords.width) {
                start.width = `${oldCoords.width}px`;
                end.width = `${newCoords.width}px`;
            }
            if (oldCoords.height !== newCoords.height) {
                start.height = `${oldCoords.height}px`;
                end.height = `${newCoords.height}px`;
            }

            return new KeyframeEffect(el, [start, end], { duration: ANIMATION_DURATION, easing: ANIMATION_EASING });
        }

        return new KeyframeEffect(el, [], { duration: 0 });
    };
};
