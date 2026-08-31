import { useEffect, useMemo, useState } from 'react';
import { buildShape } from './replay/geo.js';

/**
 * Fetches the replay manifest, then the selected replay file, and builds the
 * route shape once per replay so every frame of playback reuses it.
 */
export function useReplayList() {
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('./replays/index.json')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setManifest)
      .catch((e) => setError(e.message));
  }, []);

  return { manifest, error };
}

export function useReplay(file) {
  const [replay, setReplay] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!file) return;
    setReplay(null);
    setError(null);
    fetch(`./replays/${file}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setReplay)
      .catch((e) => setError(e.message));
  }, [file]);

  const shape = useMemo(() => (replay ? buildShape(replay.route.coordinates) : null), [replay]);

  return { replay, shape, error };
}
