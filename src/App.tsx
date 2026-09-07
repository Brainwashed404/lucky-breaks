import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useAudioEngineContext } from './context/AudioContext';
import { PAD_GENRE_MAP, PAD_LABELS, type PadLabel, stations, stationInGenre } from './data/stations';
import { DisplayScreen } from './components/DisplayScreen/DisplayScreen';
import { GravityVisualiser } from './components/GravityVisualiser/GravityVisualiser';
import { TransportControls } from './components/TransportControls/TransportControls';
import { VibePads } from './components/VibePads/VibePads';
import { StationIndexModal } from './components/StationIndexModal/StationIndexModal';
import { InfoModal } from './components/InfoModal/InfoModal';
import { LoopBankPanel } from './components/LoopBankPanel/LoopBankPanel';
import { useFavourites } from './hooks/useFavourites';
import { useDarkMode } from './hooks/useDarkMode';
import { useStationNotifications } from './hooks/useStationNotifications';
import { useMidiSurface } from './hooks/useMidiSurface';
import { FX_ACTION_EFFECT, FX_SECONDARY_ACTION_EFFECT, type MidiActionId } from './lib/midi/bindings';
import { GENRE_VISUALISER_MODE } from './lib/genreVisualiserModes';
import styles from './App.module.css';

// Same order as the genre grid, so cycling through them (NOTE soft key) steps
// through in a stable, familiar sequence rather than an arbitrary one.
const VISUALISER_MODE_SEQUENCE: string[] = PAD_LABELS.map(
  (label) => GENRE_VISUALISER_MODE[PAD_GENRE_MAP[label]],
);

// SOOMFON Stream Controller Classic key map. These same shortcuts serve two
// paths: pressed directly while Lucky Breaks is focused, and driven from the
// background by ~/.hammerspoon/init.lua, which catches the deck's numpad
// keystrokes system-wide and re-posts the matching key straight at this app's
// process (delivered even when unfocused, without ever raising the window).
// Everything else was a dead end: a page can't receive keys unfocused, can't
// fetch localhost (Chrome blocks the loopback address space outright), and
// the installed PWA can't be scripted via AppleScript at all.
//
// '1' is the Favs/All toggle, then genres across the digit row plus
// dash/equals. GravityVisualiser has its own 1-9/0/a/b keydown listener for
// switching visualiser patterns: these win on purpose via
// stopImmediatePropagation, so a genre jump never also flips the visualiser
// pattern underneath it.
const SOOMFON_GENRE_KEYS: Partial<Record<string, PadLabel>> = {
  '2': 'AMBIENT + CHILL',
  '3': 'CLASSICAL',
  '4': 'DNB + RAVE',
  '5': 'DUB + REGGAE',
  '6': 'ECLECTIC',
  '7': 'HIP HOP + RNB',
  '8': 'HOUSE + UKG',
  '9': 'JAZZ + EXOTICA',
  '0': 'LEGENDS + ERAS',
  '-': 'ROCK + INDIE',
  '=': 'SOUL + FUNK',
};

const sortKey = (name: string) => {
  const stripped = name.replace(/^the\s+/i, '');
  return /^\d/.test(stripped) ? 'zzz_' + stripped.toLowerCase() : stripped.toLowerCase();
};

function App() {
  const [isIndexOpen, setIsIndexOpen] = useState(false);
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [isLoopBankOpen, setIsLoopBankOpen] = useState(false);
  const [shuffleMode, setShuffleMode] = useState(false);
  const [favsMode, setFavsMode] = useState(false);
  // Real values now (not discarded) - fed into useMidiSurface's state so the
  // three mute buttons can show their own on/off LED, same as favs/dark do.
  const [loopsMuted, setLoopsMutedState] = useState(false);
  const [radioMuted, setRadioMutedState] = useState(false);
  const [fxMuted, setFxMutedState] = useState(false);
  const [screenMessage, setScreenMessage] = useState<string | null>(null);
  const [vizRequest, setVizRequest] = useState<{ key: string; token: number } | null>(null);
  const vizTokenRef = useRef(0);
  const [closeVizRequest, setCloseVizRequest] = useState<{ token: number } | null>(null);
  const closeVizTokenRef = useRef(0);
  const [fullscreenViz, setFullscreenViz] = useState(false);
  // Which of the 12 visualiser patterns the NOTE soft key is currently on,
  // for it to step forward from next time. A ref, not state: nothing renders
  // off this value directly, it's read only inside the next NOTE press.
  const visualiserModeIndexRef = useRef(0);
  // DRUM on the APC cycles through three stages rather than a plain on/off:
  // pad view -> in-app visualiser (small screen, not fullscreen) -> fullscreen
  // visualiser -> back to pad view, specifically landing on the screen's own
  // default (station name) rather than leaving it parked on the visualiser.
  // Tracked separately from fullscreenViz/DisplayScreen's own tap-to-cycle state
  // since neither of those alone captures "which of the three stages CLIP STOP
  // is currently on". Real state now (not just a ref) since the MIDI surface's
  // LED feedback for CLIP STOP and SOLO both need to react to it.
  const [screenStage, setScreenStageState] = useState<'pad' | 'appViz' | 'fullscreen'>('pad');
  const screenStageRef = useRef<'pad' | 'appViz' | 'fullscreen'>('pad');
  const setScreenStage = useCallback((s: 'pad' | 'appViz' | 'fullscreen') => {
    screenStageRef.current = s;
    setScreenStageState(s);
  }, []);
  const engine = useAudioEngineContext();
  const { favourites, toggleFavourite, replaceFavourites } = useFavourites();
  const { dark, toggle: toggleDark } = useDarkMode();
  const stationNotifications = useStationNotifications(engine.currentStation);

  // The engine can now auto-mute the radio on its own (committing a
  // recording does this - see useFxAudioBridge's finishRecordingAndLoopPad),
  // not only ever in response to the VOLUME button below - mirror its own
  // reactive radioMuted into local state so the LED/UI picks that up too,
  // not just the audio graph underneath it.
  useEffect(() => {
    setRadioMutedState(engine.radioMuted);
  }, [engine.radioMuted]);

  // Auto-clear screenMessage after 3 seconds
  useEffect(() => {
    if (!screenMessage) return;
    const t = setTimeout(() => setScreenMessage(null), 3000);
    return () => clearTimeout(t);
  }, [screenMessage]);

  // A-Z sorted station list for linear navigation
  const sortedStations = useMemo(
    () => [...stations].sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name))),
    [],
  );

  // useFavs is passed explicitly rather than read from state so the APC's SHIFT
  // modifier can drop into a genre inside FAVS without a round trip through setState.
  const playGenre = useCallback((label: PadLabel, useFavs: boolean) => {
    const genre = PAD_GENRE_MAP[label];
    setShuffleMode(false);

    if (useFavs) {
      // In FAVS mode: only play favourited stations within this genre
      const allFavsInGenre = stations.filter((s) => favouritesRef.current.has(s.id) && stationInGenre(s, genre));
      if (allFavsInGenre.length === 0) {
        setScreenMessage('Fav a station in this genre');
        return;
      }
      const candidates = allFavsInGenre.filter((s) => s.id !== engineRef.current.currentStation?.id);
      const pool = candidates.length > 0 ? candidates : allFavsInGenre;
      setFavsMode(true);
      engineRef.current.setActiveGenre(genre);
      engineRef.current.playStation(pool[Math.floor(Math.random() * pool.length)]);
      return;
    }

    setFavsMode(false);
    engineRef.current.setActiveGenre(genre);
    engineRef.current.playNext(genre);
  }, []);

  const handlePadClick = (label: PadLabel) => playGenre(label, favsMode);

  const handleFavsShuffle = () => {
    if (favsMode) { setFavsMode(false); setShuffleMode(false); return; }
    // Enter FAVS mode in shuffle — play a random fav immediately
    const favsList = stations.filter((s) => favourites.has(s.id));
    if (favsList.length === 0) { setScreenMessage('Heart a station to build your FAVS'); return; }
    setFavsMode(true);
    setShuffleMode(true);
    const candidates = favsList.filter((s) => s.id !== engine.currentStation?.id);
    const pool = candidates.length > 0 ? candidates : favsList;
    engine.playStation(pool[Math.floor(Math.random() * pool.length)]);
  };

  // The SOOMFON's star key. Steps to the next favourite, alphabetically,
  // wrapping - same ordering `handleFwd` already uses for its favs-mode
  // filter, just always-on here regardless of genre. Deliberately NOT a
  // toggle: the deck has no way to read this app's state, so anything
  // stateful there ends up lying (the old favs/shuffle toggle drifted the
  // moment a genre key was pressed, since playGenre clears both). A key that
  // always does exactly one thing - "next favourite" - can't mislead.
  const handleFavsCycle = useCallback(() => {
    const sortedFavs = [...stations]
      .filter((s) => favourites.has(s.id))
      .sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));
    if (sortedFavs.length === 0) { setScreenMessage('Heart a station to build your FAVS'); return; }
    engineRef.current.setActiveGenre(null);
    setShuffleMode(false);
    setFavsMode(true);
    const idx = sortedFavs.findIndex((s) => s.id === engine.currentStation?.id);
    engine.playStation(sortedFavs[(idx + 1) % sortedFavs.length]);
  }, [engine, favourites]);

  const handleShuffle = useCallback(() => {
    // If a genre pad is active, this button acts as ALL — clear genre only, keep FAVS intact
    if (engineRef.current.activeGenre) {
      engineRef.current.setActiveGenre(null);
      setShuffleMode(false);
      return;
    }
    // Normal SHUFFLE toggle — works within FAVS if FAVS is active. Engine
    // calls must not happen inside the setShuffleMode updater below — React
    // invokes that updater while re-rendering THIS component to compute the
    // next state, so a setState call to a different component (the engine,
    // owned by AudioEngineProvider) from in there fires "Cannot update a
    // component while rendering a different component" and, under StrictMode,
    // runs twice.
    const next = !shuffleModeRef.current;
    if (next) {
      engineRef.current.setActiveGenre(null);
      if (favsRef.current) {
        const favPool = stations.filter((s) => favouritesRef.current.has(s.id) && s.id !== engineRef.current.currentStation?.id);
        const pool = favPool.length > 0 ? favPool : stations.filter((s) => favouritesRef.current.has(s.id));
        if (pool.length > 0) {
          engineRef.current.playStation(pool[Math.floor(Math.random() * pool.length)]);
          setShuffleMode(next);
          return;
        }
      }
      engineRef.current.shuffle();
    }
    setShuffleMode(next);
  }, []);

  // Forward always steps to the next station in alphabetical order, never a
  // random pick: "forward" should mean the one after this one, so NTS 1 goes to
  // NTS 2. It therefore also drops out of shuffle, rather than continuing to
  // jump around. Whatever genre and favs mode you're in is kept - the step just
  // happens within that narrowed pool.
  const handleFwd = useCallback(() => {
    if (shuffleMode) setShuffleMode(false);

    let pool = sortedStations;
    if (favsMode) pool = pool.filter((s) => favourites.has(s.id));
    if (engine.activeGenre) pool = pool.filter((s) => stationInGenre(s, engine.activeGenre!));

    if (pool.length === 0) {
      if (favsMode) setScreenMessage('Fav a station in this genre');
      return;
    }
    // findIndex returning -1 (current station not in this pool) lands on the
    // first entry, which is the sensible place to start from.
    const idx = pool.findIndex((s) => s.id === engine.currentStation?.id);
    engine.playStation(pool[(idx + 1) % pool.length]);
  }, [engine, shuffleMode, sortedStations, favsMode, favourites]);

  const handleRwd = useCallback(() => {
    if (favsMode) {
      const sortedFavs = [...stations]
        .filter((s) => favourites.has(s.id))
        .sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));
      if (sortedFavs.length === 0) return;
      const pool = engine.activeGenre
        ? sortedFavs.filter((s) => stationInGenre(s, engine.activeGenre!))
        : sortedFavs;
      if (pool.length === 0) return;
      const idx = pool.findIndex((s) => s.id === engine.currentStation?.id);
      engine.playStation(pool[(idx - 1 + pool.length) % pool.length]);
      return;
    }
    if (engine.activeGenre || shuffleMode) {
      engine.playPrev();
    } else {
      const idx = sortedStations.findIndex((s) => s.id === engine.currentStation?.id);
      const prev = sortedStations[(idx - 1 + sortedStations.length) % sortedStations.length];
      if (prev) engine.playStation(prev);
    }
  }, [engine, shuffleMode, sortedStations, favsMode, favourites]);

  const jumpToLetter = useCallback((letter: string) => {
    const pool = sortedStationsRef.current.filter((s) => {
      const stripped = s.name.replace(/^the\s+/i, '');
      return stripped.toLowerCase().startsWith(letter);
    });
    if (pool.length === 0) return;
    // Exclude current station so repeated presses always change
    const options = pool.length > 1
      ? pool.filter((s) => s.id !== engineRef.current.currentStation?.id)
      : pool;
    engineRef.current.playStation(options[Math.floor(Math.random() * options.length)]);
  }, []);

  // Keep stable refs for use inside event listeners
  const jumpToLetterRef = useRef(jumpToLetter);
  const handleFwdRef = useRef(handleFwd);
  const handleRwdRef = useRef(handleRwd);
  const togglePlayPauseRef = useRef(engine.togglePlayPause);
  const isIndexOpenRef = useRef(isIndexOpen);
  const sortedStationsRef = useRef(sortedStations);
  const engineRef = useRef(engine);
  const favsRef = useRef(favsMode);
  const favouritesRef = useRef(favourites);
  const shuffleModeRef = useRef(shuffleMode);
  const loopsMutedRef = useRef(loopsMuted);
  const radioMutedRef = useRef(radioMuted);
  const fxMutedRef = useRef(fxMuted);
  jumpToLetterRef.current = jumpToLetter;
  handleFwdRef.current = handleFwd;
  handleRwdRef.current = handleRwd;
  togglePlayPauseRef.current = engine.togglePlayPause;
  isIndexOpenRef.current = isIndexOpen;
  sortedStationsRef.current = sortedStations;
  shuffleModeRef.current = shuffleMode;
  loopsMutedRef.current = loopsMuted;
  radioMutedRef.current = radioMuted;
  fxMutedRef.current = fxMuted;
  engineRef.current = engine;
  favsRef.current = favsMode;
  favouritesRef.current = favourites;
  const fullscreenVizRef = useRef(fullscreenViz);
  fullscreenVizRef.current = fullscreenViz;

  // Shared exit path for every way out of fullscreen (Escape, the X button, the
  // visualiser's own onClose) so all of them land back on volumeStage 'pad' too,
  // keeping the next VOLUME press starting from the right place in its cycle.
  const exitFullscreen = useCallback(() => {
    setFullscreenViz(false);
    setScreenStage('pad');
  }, [setScreenStage]);
  const exitFullscreenRef = useRef(exitFullscreen);
  exitFullscreenRef.current = exitFullscreen;

  const handleFavsRef = useRef(handleFavsShuffle);
  const handleShuffleRef = useRef(handleShuffle);
  const handleFavsCycleRef = useRef(handleFavsCycle);
  handleFavsCycleRef.current = handleFavsCycle;
  const toggleDarkRef = useRef(toggleDark);
  handleFavsRef.current = handleFavsShuffle;
  handleShuffleRef.current = handleShuffle;
  toggleDarkRef.current = toggleDark;

  // ─── APC mini mk2 control surface ─────────────────────────────────────────
  // Scoped to that one device by an allowlist in lib/midi. Nothing here opens or
  // writes to any other controller on the bus.
  const handleMidiAction = useCallback((id: MidiActionId) => {
    switch (id) {
      case 'fwd': handleFwdRef.current(); break;
      case 'rwd': handleRwdRef.current(); break;
      case 'favs': handleFavsRef.current(); break;
      case 'shuffle': handleShuffleRef.current(); break;
      case 'index': setIsIndexOpen((open) => !open); break;
      case 'dark': toggleDarkRef.current(); break;
      case 'playPause': togglePlayPauseRef.current(); break;
      case 'cyclePadView': {
        const stage = screenStageRef.current;
        const next = stage === 'pad' ? 'appViz' : stage === 'appViz' ? 'fullscreen' : 'pad';
        setScreenStage(next);
        if (next === 'appViz') {
          setFullscreenViz(false);
          // Empty key: forces DisplayScreen into its viz screen mode without
          // also forcing GravityVisualiser onto a specific mode (an unknown
          // key is a safe no-op there) - the visualiser just stays on whatever
          // mode it's already on / the current genre's default.
          setVizRequest({ key: '', token: ++vizTokenRef.current });
        } else if (next === 'fullscreen') {
          setFullscreenViz(true);
        } else {
          setFullscreenViz(false);
          setCloseVizRequest({ token: ++closeVizTokenRef.current });
        }
        break;
      }
      case 'cycleVisualisation': {
        const next = (visualiserModeIndexRef.current + 1) % VISUALISER_MODE_SEQUENCE.length;
        visualiserModeIndexRef.current = next;
        setVizRequest({ key: VISUALISER_MODE_SEQUENCE[next], token: ++vizTokenRef.current });
        break;
      }
      case 'clearAll':
        engineRef.current.setActiveGenre(null);
        setShuffleMode(false);
        setFavsMode(false);
        break;
      case 'muteLoops': {
        // Engine calls must happen outside the state updater — see handleShuffle's
        // own comment for why calling AudioEngineProvider's setters from inside a
        // setState updater triggers React's cross-component render warning.
        const next = !loopsMutedRef.current;
        engineRef.current.setLoopsMuted(next);
        setLoopsMutedState(next);
        break;
      }
      case 'muteRadio': {
        const next = !radioMutedRef.current;
        engineRef.current.setRadioMuted(next);
        setRadioMutedState(next);
        break;
      }
      case 'muteFx': {
        const next = !fxMutedRef.current;
        engineRef.current.setFxMuted(next);
        setFxMutedState(next);
        break;
      }
      case 'exportLoops': setIsLoopBankOpen((open) => !open); break;
      case 'nextGenre': {
        // No genre active wraps to the first; stepping past the last wraps to the first too.
        const idx = engineRef.current.activeGenre ? PAD_LABELS.indexOf(engineRef.current.activeGenre as PadLabel) : -1;
        playGenre(PAD_LABELS[(idx + 1 + PAD_LABELS.length) % PAD_LABELS.length], favsRef.current);
        break;
      }
      case 'prevGenre': {
        // No genre active wraps to the last.
        const idx = engineRef.current.activeGenre ? PAD_LABELS.indexOf(engineRef.current.activeGenre as PadLabel) : 0;
        playGenre(PAD_LABELS[(idx - 1 + PAD_LABELS.length) % PAD_LABELS.length], favsRef.current);
        break;
      }
      case 'volume': break; // arrives on the fader path instead
    }
  }, [playGenre, setScreenStage]);

  const handleMidiFader = useCallback((id: MidiActionId, value: number) => {
    if (id === 'volume') { engineRef.current.setVolume(value); return; }
    const effectId = FX_ACTION_EFFECT[id];
    if (effectId) { engineRef.current.setEffectAmount(effectId, value); return; }
    const secondaryEffectIds = FX_SECONDARY_ACTION_EFFECT[id];
    if (secondaryEffectIds) {
      for (const eid of secondaryEffectIds) engineRef.current.setEffectSecondary(eid, value);
    }
  }, []);

  const activeGenreIndex = engine.activeGenre
    ? PAD_LABELS.indexOf(engine.activeGenre as PadLabel)
    : -1;

  const midi = useMidiSurface(
    {
      onGenre: (index, shift) => playGenre(PAD_LABELS[index], shift || favsRef.current),
      onAction: handleMidiAction,
      onFader: handleMidiFader,
      onLoopFader: (slotIndex, value) => engineRef.current.setLoopFaderVolume(slotIndex, value),
      onLooperPadPress: (padId, shiftHeld) => engineRef.current.looperPadPress(padId, shiftHeld),
      onLooperPadRelease: (padId) => engineRef.current.looperPadRelease(padId),
      onResetFx: () => engineRef.current.resetAllFx(),
      onResetLoopMacro: (which) => engineRef.current.resetSelectedLoopMacro(which),
    },
    {
      activeGenreIndex: activeGenreIndex >= 0 ? activeGenreIndex : null,
      loading: engine.status === 'loading',
      error: engine.status === 'error',
      playing: engine.status === 'playing',
      favsMode,
      shuffleMode,
      dark,
      loopStatuses: engine.loopStatuses,
      loopPlaying: engine.loopPlaying,
      loopsMuted,
      radioMuted,
      fxMuted,
      indexOpen: isIndexOpen,
      loopBankOpen: isLoopBankOpen,
      screenStage,
    },
  );

  // Keyboard controls (Space / Arrows / media keys / A-Z station jump)
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Space' || e.code === 'MediaPlayPause') {
        e.preventDefault();
        togglePlayPauseRef.current();
      } else if (e.code === 'ArrowRight' || e.code === 'MediaTrackNext') {
        e.preventDefault();
        handleFwdRef.current();
      } else if (e.code === 'ArrowLeft' || e.code === 'MediaTrackPrevious') {
        e.preventDefault();
        handleRwdRef.current();
      } else if (e.code === 'Escape' && !isIndexOpenRef.current) {
        e.preventDefault();
        if (fullscreenVizRef.current) {
          exitFullscreenRef.current();
          return;
        }
        engineRef.current.setActiveGenre(null);
        setShuffleMode(false);
        setFavsMode(false);
      } else if (
        !isIndexOpenRef.current &&
        e.key.length === 1 &&
        /[a-z]/i.test(e.key) &&
        !e.metaKey && !e.ctrlKey && !e.altKey
      ) {
        jumpToLetterRef.current(e.key.toLowerCase());
      } else if (
        !isIndexOpenRef.current && !e.metaKey && !e.ctrlKey && !e.altKey &&
        (e.key === '1' || e.key === '`' || SOOMFON_GENRE_KEYS[e.key])
      ) {
        // SOOMFON macro-deck shortcuts (see SOOMFON_GENRE_KEYS above).
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === '1') handleFavsCycleRef.current();
        else if (e.key === '`') handleShuffleRef.current();
        else playGenre(SOOMFON_GENRE_KEYS[e.key]!, favsRef.current);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []); // stable — uses refs

  // Media Session API — update metadata + re-register handlers on every station change.
  // iOS drops action handlers between tracks so they must be re-set each time.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: engine.currentStation?.name ?? 'Lucky Breaks',
      artist: engine.currentStation?.description ?? 'Serendipitous sampling',
      album: 'Lucky Breaks Radio',
      artwork: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });

    // 'play' uses togglePlayPause which reloads the stream — required for live radio
    navigator.mediaSession.setActionHandler('play',  () => togglePlayPauseRef.current());
    navigator.mediaSession.setActionHandler('pause', () => togglePlayPauseRef.current());
    navigator.mediaSession.setActionHandler('stop',  () => engineRef.current.audioRef.current?.pause());
    navigator.mediaSession.setActionHandler('nexttrack',     () => handleFwdRef.current());
    navigator.mediaSession.setActionHandler('previoustrack', () => handleRwdRef.current());

    // Disable seek controls — without this iOS shows ±10s buttons instead of ⏮⏭
    try { navigator.mediaSession.setActionHandler('seekforward',  null); } catch {}
    try { navigator.mediaSession.setActionHandler('seekbackward', null); } catch {}
    try { navigator.mediaSession.setActionHandler('seekto',       null); } catch {}
  }, [engine.currentStation]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep lock screen play/pause indicator in sync with actual audio state
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState =
      engine.status === 'playing' ? 'playing' :
      engine.status === 'loading' ? 'playing' :
      'paused';
  }, [engine.status]);

  // Clear the bogus duration/progress bar that ICY streams inject.
  // Some streams report a Content-Length header the browser reads as duration
  // (e.g. 37 hours). Calling setPositionState() with no args removes it.
  useEffect(() => {
    const audio = engine.audioRef.current;
    if (!audio) return;
    const clearDuration = () => {
      if (!('mediaSession' in navigator)) return;
      try { (navigator.mediaSession as MediaSession & { setPositionState?: () => void }).setPositionState?.(); } catch {}
    };
    audio.addEventListener('durationchange', clearDuration);
    // Also clear immediately when station changes
    clearDuration();
    return () => audio.removeEventListener('durationchange', clearDuration);
  }, [engine.currentStation]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {fullscreenViz && (
        <div className={styles.fullscreenViz}>
          <GravityVisualiser
            onClose={exitFullscreen}
            genre={engine.currentStation?.genre}
            stationName={engine.currentStation?.name}
            modeOverride={vizRequest}
            isFullscreen
          />
          <button
            className={styles.fullscreenExit}
            onClick={exitFullscreen}
            aria-label="Exit fullscreen visualiser"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>
      )}
      <div className={styles.mpcBody}>
        <div className={styles.mpcCenter}>

          {/* Row 1: Logo + Signature */}
          <div className={styles.logoBar}>
            <div className={styles.logo}>
              <a
                href="https://www.instagram.com/luckybreaks.xyz"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.logoWordmark}
              >
                LUCKY BREAKS
              </a>
              <span className={styles.logoSub}>radio for beatmakers</span>
            </div>
            <span className={styles.tagline}>Tune in. Chop up.</span>
          </div>

          {/* Row 2: Screen + sidebar buttons */}
          <div className={styles.screenRow}>
            <div className={styles.screenBezel}>
              <DisplayScreen
                station={engine.currentStation}
                status={engine.status}
                screenMessage={screenMessage}
                vizRequest={vizRequest}
                closeVizRequest={closeVizRequest}
              />
            </div>
            <div className={styles.screenButtons}>
              {/* Info — top */}
              <motion.button
                className={styles.screenBtn}
                onClick={() => setIsInfoOpen(true)}
                aria-label="About / Instructions"
                whileTap={{ scale: 0.91, y: 2 }}
                transition={{ type: 'spring', stiffness: 600, damping: 20 }}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M12 16v-4M12 8h.01"/>
                </svg>
              </motion.button>
              {/* Heart — middle */}
              <motion.button
                className={styles.screenBtn}
                onClick={() => { if (engine.currentStation) toggleFavourite(engine.currentStation.id); }}
                aria-label={favourites.has(engine.currentStation?.id ?? '') ? 'Remove from favourites' : 'Add to favourites'}
                disabled={!engine.currentStation}
                whileTap={{ scale: 0.91, y: 2 }}
                transition={{ type: 'spring', stiffness: 600, damping: 20 }}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
                  <path
                    className={favourites.has(engine.currentStation?.id ?? '') ? styles.screenBtnHeartActive : styles.screenBtnHeartInactive}
                    d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
                    strokeWidth="2"
                  />
                </svg>
              </motion.button>
              {/* Fullscreen visualiser */}
              <motion.button
                className={styles.screenBtn}
                onClick={() => {
                  if (fullscreenViz) { exitFullscreen(); return; }
                  setFullscreenViz(true);
                  setScreenStage('fullscreen');
                }}
                aria-label={fullscreenViz ? 'Exit fullscreen visualiser' : 'Fullscreen visualiser'}
                aria-pressed={fullscreenViz}
                whileTap={{ scale: 0.91, y: 2 }}
                transition={{ type: 'spring', stiffness: 600, damping: 20 }}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/>
                </svg>
              </motion.button>
              {/* Dark/light toggle — bottom */}
              <motion.button
                className={styles.screenBtn}
                onClick={toggleDark}
                aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
                whileTap={{ scale: 0.91, y: 2 }}
                transition={{ type: 'spring', stiffness: 600, damping: 20 }}
                style={{ overflow: 'hidden' }}
              >
                <AnimatePresence mode="wait" initial={false}>
                  {dark ? (
                    <motion.span
                      key="sun"
                      initial={{ opacity: 0, rotate: -30, scale: 0.7 }}
                      animate={{ opacity: 1, rotate: 0, scale: 1 }}
                      exit={{ opacity: 0, rotate: 30, scale: 0.7 }}
                      transition={{ duration: 0.25, ease: 'easeInOut' }}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                      </svg>
                    </motion.span>
                  ) : (
                    <motion.span
                      key="moon"
                      initial={{ opacity: 0, rotate: 30, scale: 0.7 }}
                      animate={{ opacity: 1, rotate: 0, scale: 1 }}
                      exit={{ opacity: 0, rotate: -30, scale: 0.7 }}
                      transition={{ duration: 0.25, ease: 'easeInOut' }}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 12.79A9 9 0 1 1 11.21 3 6 6 0 0 0 21 12.79z"/>
                      </svg>
                    </motion.span>
                  )}
                </AnimatePresence>
              </motion.button>
            </div>
          </div>

          {/* Row 3: Transport controls */}
          <div className={styles.transportRow}>
            <TransportControls
              onFavs={handleFavsShuffle}
              canFavs={favourites.size > 0}
              favsActive={favsMode}
              onIndex={() => setIsIndexOpen(true)}
              onShuffle={handleShuffle}
              shuffleActive={shuffleMode}
              showAllButton={!!engine.activeGenre}
              onPlayPause={engine.togglePlayPause}
              onFwd={handleFwd}
              onRwd={handleRwd}
              isPlaying={engine.status === 'playing'}
              canRwd={engine.activeGenre || shuffleMode ? engine.historyIndex > 0 : !!engine.currentStation}
            />
          </div>

          {/* Row 4: Pad panel */}
          <div className={styles.padPanel}>
            <VibePads
              activeGenre={engine.activeGenre}
              onPadClick={handlePadClick}
              midiConnected={midi.status === 'connected'}
              playbackStatus={engine.status}
            />
          </div>

        </div>
      </div>

      {/* Station Index Modal */}
      <AnimatePresence>
        {isIndexOpen && (
          <StationIndexModal
            isOpen={isIndexOpen}
            onClose={() => setIsIndexOpen(false)}
            stations={stations}
            currentStation={engine.currentStation}
            isPlaying={engine.status === 'playing'}
            onTogglePlayback={engine.togglePlayPause}
            activeGenre={engine.activeGenre}
            favsMode={favsMode}
            favourites={favourites}
            onToggleFavourite={toggleFavourite}
            onSelectStation={(s) => {
              engine.playStation(s);
            }}
            onFilterChange={(f) => {
              if (f === 'FAVOURITES') {
                setFavsMode(true);
                engine.setActiveGenre(null);
              } else {
                setFavsMode(false);
                engine.setActiveGenre(f as import('./data/stations').Genre | null);
              }
            }}
          />
        )}
      </AnimatePresence>

      {/* Info Modal */}
      <AnimatePresence>
        {isInfoOpen && (
          <InfoModal
            onClose={() => setIsInfoOpen(false)}
            favourites={favourites}
            onLoadFavs={replaceFavourites}
            midi={midi}
            stationNotifications={stationNotifications}
          />
        )}
      </AnimatePresence>

      {/* Loop Bank (export) */}
      <AnimatePresence>
        {isLoopBankOpen && (
          <LoopBankPanel
            onClose={() => setIsLoopBankOpen(false)}
            loopBank={engine.loopBank}
            getLoopBuffer={engine.getLoopBuffer}
          />
        )}
      </AnimatePresence>

    </>
  );
}

export default App;
