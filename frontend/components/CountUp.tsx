import React, { useEffect, useRef, useState } from 'react';
import { atelierMotion } from '../appStyle';

/**
 * A figure that counts up to its value (and on to each new value) under the
 * Atelier style; in Classic, or with reduced motion, just the value.
 */
export const CountUp: React.FC<{ value: number; format?: (n: number) => string }> = ({ value, format = n => String(Math.round(n)) }) => {
    const [shown, setShown] = useState(() => (atelierMotion() ? 0 : value));
    const shownRef = useRef(shown);

    useEffect(() => {
        if (!atelierMotion()) {
            shownRef.current = value;
            setShown(value);
            return;
        }
        const from = shownRef.current;
        const start = performance.now();
        let frame = 0;
        const step = (now: number) => {
            const p = Math.min(1, (now - start) / 900);
            const next = from + (value - from) * (1 - (1 - p) ** 3);
            shownRef.current = next;
            setShown(next);
            if (p < 1) frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
        return () => cancelAnimationFrame(frame);
    }, [value]);

    return <>{format(shown)}</>;
};
