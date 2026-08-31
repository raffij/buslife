import { useCallback, useMemo, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { Map } from 'react-map-gl/maplibre';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import 'maplibre-gl/dist/maplibre-gl.css';

import { useReplayList, useReplay } from './useReplay.js';
import { useClock } from './useClock.js';
import { fleetStateAt, trailFor, rawFixesFor } from './replay/position.js';
import { formatClock } from './replay/time.mjs';

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

const SPEEDS = [30, 60, 120, 300, 900];
const TRAIL_SECONDS = 15 * 60;

const TOWARD_END = [63, 214, 194];
const TOWARD_START = [180, 124, 255];
const OFF_ROUTE = [139, 147, 163];

function colorFor(dir) {
  if (dir > 0) return TOWARD_END;
  if (dir < 0) return TOWARD_START;
  return OFF_ROUTE;
}

function initialViewFor(route) {
  const lons = route.coordinates.map((c) => c[0]);
  const lats = route.coordinates.map((c) => c[1]);
  const lonSpan = Math.max(...lons) - Math.min(...lons);
  // The console panel sits over the left ~30% of the screen on desktop, so
  // the route's center is nudged east to keep both termini clear of it.
  const cLon = (Math.min(...lons) + Math.max(...lons)) / 2 + lonSpan * 0.14;
  const cLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  return { longitude: cLon, latitude: cLat, zoom: 10.4, pitch: 0, bearing: 0 };
}

export default function App() {
  const { manifest } = useReplayList();
  const [selected, setSelected] = useState(null);
  const file = selected ?? manifest?.[0]?.file ?? null;
  const { replay, shape } = useReplay(file);

  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(120);
  const [showTrails, setShowTrails] = useState(true);
  const [showRaw, setShowRaw] = useState(false);
  // Only consulted below the mobile breakpoint (see styles.css) — on desktop
  // the console panel is always shown regardless of this value, so it starts
  // false purely so a phone opens onto the map rather than a full sheet.
  const [expanded, setExpanded] = useState(false);

  const window = replay?.window ?? [0, 1];
  const { t, seek, nudge } = useClock({ from: window[0], to: window[1], speed, playing: playing && !!replay });

  const fleet = useMemo(() => {
    if (!replay || !shape) return null;
    return fleetStateAt(replay, shape, t);
  }, [replay, shape, t]);

  const viewState = useMemo(() => (replay ? initialViewFor(replay.route) : null), [replay?.route?.id]);

  const layers = useMemo(() => {
    if (!replay || !shape || !fleet) return [];
    const out = [];

    out.push(
      new PathLayer({
        id: 'route',
        data: [{ path: replay.route.coordinates }],
        getPath: (d) => d.path,
        getColor: [70, 82, 100, 140],
        getWidth: 3,
        widthUnits: 'pixels',
      }),
    );

    if (showTrails) {
      const trails = fleet.active
        .filter((a) => a.state.status === 'in-service')
        .map((a) => ({
          path: trailFor(a.vehicle, shape, t, TRAIL_SECONDS),
          color: colorFor(a.state.dir),
        }))
        .filter((d) => d.path.length >= 2);
      out.push(
        new PathLayer({
          id: 'trails',
          data: trails,
          getPath: (d) => d.path,
          getColor: (d) => [...d.color, 150],
          getWidth: 3,
          widthUnits: 'pixels',
        }),
      );
    }

    if (showRaw) {
      const pings = fleet.active.flatMap((a) =>
        rawFixesFor(a.vehicle, t, TRAIL_SECONDS).map((p) => ({ position: p })),
      );
      out.push(
        new ScatterplotLayer({
          id: 'raw-pings',
          data: pings,
          getPosition: (d) => d.position,
          getRadius: 2.5,
          radiusUnits: 'pixels',
          getFillColor: [255, 255, 255, 90],
        }),
      );
    }

    out.push(
      new ScatterplotLayer({
        id: 'buses',
        data: fleet.active,
        getPosition: (d) => [d.state.lon, d.state.lat],
        getRadius: (d) => (d.state.status === 'in-service' ? 7 : 5),
        radiusUnits: 'pixels',
        getFillColor: (d) =>
          d.state.status === 'in-service' ? [...colorFor(d.state.dir), 255] : [...OFF_ROUTE, 200],
        getLineColor: [10, 13, 18, 255],
        lineWidthUnits: 'pixels',
        getLineWidth: 1.5,
        stroked: true,
        pickable: true,
      }),
    );

    return out;
  }, [replay, shape, fleet, t, showTrails, showRaw]);

  const getTooltip = useCallback(({ object }) => {
    if (!object) return null;
    const { vehicle, state } = object;
    const dest = state.run?.destination;
    const lines = [`<div class="ref">${vehicle.ref ?? vehicle.id}</div>`];
    if (dest) lines.push(`<div>towards ${dest}</div>`);
    lines.push(
      `<div class="dim">${state.status === 'in-service' ? `${(state.speedMps * 2.237).toFixed(0)} mph` : 'off route'}</div>`,
    );
    return { html: lines.join(''), className: 'tip' };
  }, []);

  if (!replay || !shape || !fleet) {
    return <div className="loading">loading replay…</div>;
  }

  const isSynthetic = replay.source.kind === 'synthetic';

  return (
    <div className="app" data-expanded={expanded}>
      <div className="map">
        <DeckGL
          initialViewState={viewState}
          controller={{ dragRotate: false, touchRotate: false }}
          layers={layers}
          getTooltip={getTooltip}
        >
          <Map mapStyle={MAP_STYLE} reuseMaps />
        </DeckGL>
      </div>

      {/* Mobile only (see styles.css): a compact bar over the map, the
          default view on a phone so the map is visible first. Tapping it
          swaps in the full panel below. */}
      <div
        className="peek-bar"
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(true)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setExpanded(true)}
      >
        <span className="peek-clock">{formatClock(replay.dayStartUnix, t, replay.timeZone)}</span>
        <span className="peek-tally">
          <b>{fleet.inService}</b> running · {replay.route.line} {replay.route.name}
        </span>
        <button
          type="button"
          className="peek-play"
          onClick={(e) => {
            e.stopPropagation();
            setPlaying((p) => !p);
          }}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="peek-chevron" aria-hidden="true">
          ▲
        </span>
      </div>

      <div className="console">
        <div className="grab" aria-hidden="true" />
        <div className="masthead">
          <span className="route-badge">{replay.route.line}</span>
          <span className="route-name">{replay.route.name}</span>
          <button
            type="button"
            className="close-detail"
            onClick={() => setExpanded(false)}
            aria-label="Collapse details"
          >
            ▾
          </button>
        </div>
        <div className="route-meta">
          {replay.route.operator} · {replay.date}
          {manifest && manifest.length > 1 && (
            <>
              {' · '}
              <select value={file} onChange={(e) => setSelected(e.target.value)}>
                {manifest.map((m) => (
                  <option key={m.file} value={m.file}>
                    {m.date}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>

        <div className="clock">{formatClock(replay.dayStartUnix, t, replay.timeZone)}</div>

        <div className="tallies">
          <span>
            <b>{fleet.inService}</b> in service
          </span>
          <span className="sep">·</span>
          <span>
            <b>{fleet.offRoute}</b> off-route
          </span>
          <span className="sep">·</span>
          <span>
            <b>{fleet.tracked}</b> vehicles all day
          </span>
        </div>

        <div className="transport">
          <button className="play" data-playing={playing} onClick={() => setPlaying((p) => !p)}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <select className="speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
          <button className="step" onClick={() => nudge(-300)} title="Back 5 minutes">
            −5m
          </button>
          <button className="step" onClick={() => nudge(300)} title="Forward 5 minutes">
            +5m
          </button>
        </div>

        <input
          className="scrub"
          type="range"
          min={window[0]}
          max={window[1]}
          step={10}
          value={t}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <div className="scrub-ends">
          <span>{formatClock(replay.dayStartUnix, window[0], replay.timeZone)}</span>
          <span>{formatClock(replay.dayStartUnix, window[1], replay.timeZone)}</span>
        </div>

        <div className="options">
          <label>
            <input type="checkbox" checked={showTrails} onChange={(e) => setShowTrails(e.target.checked)} />
            trails (last 15 min)
          </label>
          <label>
            <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
            raw GPS pings
          </label>
        </div>

        <div className="legend">
          <div className="row">
            <span className="swatch" style={{ background: `rgb(${TOWARD_END.join(',')})` }} />
            towards {replay.route.terminals.end}
          </div>
          <div className="row">
            <span className="swatch" style={{ background: `rgb(${TOWARD_START.join(',')})` }} />
            towards {replay.route.terminals.start}
          </div>
          <div className="row">
            <span className="swatch" style={{ background: `rgb(${OFF_ROUTE.join(',')})` }} />
            off-route / depot run
          </div>
        </div>

        {isSynthetic && (
          <div className="banner">
            <b>Synthetic demo data.</b> This day is generated, not recorded — it ships so the
            replayer works before you've recorded a real one. Run <code>npm run record</code>{' '}
            against the live BODS feed, then <code>npm run compile</code>, to replay a real day.
          </div>
        )}
        {replay.route.approximateShape && (
          <div className="banner">
            <b>Approximate route.</b> This shape is hand-traced, accurate to a few hundred
            metres — good enough to demo, not the real published geometry.
          </div>
        )}

        <div className="footnote">
          Positions are BODS SIRI-VM snapshots, map-matched to the route. Buses only appear where
          they were actually tracked that day.
        </div>
      </div>
    </div>
  );
}
