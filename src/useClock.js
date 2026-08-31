import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The replay clock.
 *
 * Time advances off requestAnimationFrame rather than an interval, so a
 * 120x replay stays smooth and a backgrounded tab does not accumulate hours
 * of drift while nobody is watching. The clock is a value in replay seconds;
 * everything else in the app is a pure function of it.
 */
export function useClock({ from, to, speed, playing }) {
  const [t, setT] = useState(from);
  const frame = useRef(0);
  const last = useRef(0);

  // Keep the current speed and bounds in refs so changing them does not tear
  // down and restart the animation loop mid-frame.
  const config = useRef({ from, to, speed });
  config.current = { from, to, speed };

  useEffect(() => {
    if (!playing) return undefined;
    last.current = performance.now();

    const tick = (now) => {
      const { from: lo, to: hi, speed: rate } = config.current;
      const elapsed = (now - last.current) / 1000;
      last.current = now;
      setT((current) => {
        const next = current + elapsed * rate;
        // Loop rather than stop: the interesting bit is usually not the end
        // of the day, and stopping dead means reaching for the slider.
        return next >= hi ? lo : next;
      });
      frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [playing]);

  // Landing on a new replay whose day starts later should not leave the clock
  // stranded outside it.
  useEffect(() => {
    setT((current) => (current < from || current > to ? from : current));
  }, [from, to]);

  const seek = useCallback(
    (value) => setT(Math.max(from, Math.min(to, value))),
    [from, to],
  );
  const nudge = useCallback((seconds) => setT((c) => Math.max(from, Math.min(to, c + seconds))), [from, to]);

  return { t, seek, nudge };
}
