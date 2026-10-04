'use client';

import { useEffect, useRef, useState } from 'react';

const DURATION = 700;

interface AnimatedNumberProps {
  value: number;
  format: (value: number) => string;
  /** Where to count from when the number first appears; its own value (no animation) if not given. */
  from?: number;
}

/** A number that counts to its new value when it changes, so an update is seen, not just read. */
export function AnimatedNumber({ value, format, from: initial }: AnimatedNumberProps) {
  const [shown, setShown] = useState(initial ?? value);
  const from = useRef(initial ?? value);

  useEffect(() => {
    const start = from.current;
    if (start === value) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      from.current = value;
      setShown(value);
      return;
    }
    let frame = 0;
    const began = performance.now();
    const step = (now: number) => {
      const t = Math.min((now - began) / DURATION, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = start + (value - start) * eased;
      from.current = current;
      setShown(current);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return <>{format(shown)}</>;
}
