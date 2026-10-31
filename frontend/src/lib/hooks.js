import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Poll `fetcher` every `intervalMs`. Tracks the offset between the server clock
 * (`server_now` in every response) and the browser clock, so countdowns stay
 * correct even if the user's clock is wrong.
 */
export function usePolling(fetcher, intervalMs) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(async () => {
    const sentAt = Date.now();
    try {
      const result = await fetcherRef.current();
      const receivedAt = Date.now();
      // Assume the server stamped the response halfway through the round trip.
      setOffsetMs(new Date(result.server_now).getTime() - (sentAt + receivedAt) / 2);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);

  return { data, error, refresh, offsetMs };
}

/** Current server time in ms, re-rendering every second. */
export function useServerNow(offsetMs) {
  const [now, setNow] = useState(() => Date.now() + offsetMs);
  useEffect(() => {
    setNow(Date.now() + offsetMs);
    const id = setInterval(() => setNow(Date.now() + offsetMs), 1000);
    return () => clearInterval(id);
  }, [offsetMs]);
  return now;
}

/** True for `ms` after `value` changes (not on first render). */
export function useFlashOnChange(value, ms = 3000) {
  const [flash, setFlash] = useState(false);
  const previous = useRef(value);
  useEffect(() => {
    if (previous.current !== undefined && value !== undefined && previous.current !== value) {
      setFlash(true);
      const id = setTimeout(() => setFlash(false), ms);
      previous.current = value;
      return () => clearTimeout(id);
    }
    previous.current = value;
  }, [value, ms]);
  return flash;
}
