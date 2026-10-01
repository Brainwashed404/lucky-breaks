import { type Genre, PAD_GENRE_MAP, PAD_LABELS, type PadLabel } from '../../data/stations';
import type { PlaybackStatus } from '../../hooks/useAudioEngine';
import { GENRE_GLOW_COLOURS, NTS_GLOW_COLOUR } from '../../lib/genreGlowColours';
import { VibePad, type PadGlowState } from './VibePad';
import styles from './VibePads.module.css';

// DRAMA + TALK's grid slot was repurposed as the NTS cycle button by request.
// It stays in PAD_LABELS (and on the MIDI deck/StationIndexModal genre list
// untouched) since it's still a real Genre stations are tagged with — this
// only hides its dedicated pad on the main on-screen grid.
const HIDDEN_FROM_GRID: PadLabel = 'DRAMA + TALK';

type GridItem =
  | { kind: 'genre'; label: PadLabel; glowIndex: number }
  | { kind: 'nts' };

const itemLabel = (item: GridItem): string => (item.kind === 'nts' ? 'NTS' : item.label);

interface VibePadsProps {
  activeGenre: Genre | null;
  onPadClick: (label: PadLabel) => void;
  /** True when the currently playing station is an NTS station, so the NTS
   *  pad can show active the same way a genre pad does. */
  ntsActive: boolean;
  onNtsClick: () => void;
  /** When set, each pad glows the colour its LED is showing on the connected APC
   *  mini right now. Omit (or pass false) when MIDI isn't connected. */
  midiConnected?: boolean;
  playbackStatus?: PlaybackStatus;
}

export function VibePads({ activeGenre, onPadClick, ntsActive, onNtsClick, midiConnected, playbackStatus }: VibePadsProps) {
  // Same alphabetical order PAD_LABELS already ships in, minus the hidden
  // genre, with 'NTS' merged in at its correct alphabetical spot.
  const genreItems = PAD_LABELS
    .map((label, glowIndex) => ({ kind: 'genre' as const, label, glowIndex }))
    .filter((item) => item.label !== HIDDEN_FROM_GRID);
  const items: GridItem[] = [...genreItems, { kind: 'nts' as const }]
    .sort((a, b) => itemLabel(a).localeCompare(itemLabel(b)));

  return (
    <div className={styles.grid}>
      {items.map((item) => {
        const isActive = item.kind === 'nts' ? ntsActive : activeGenre === PAD_GENRE_MAP[item.label];
        const glowState: PadGlowState = !isActive
          ? 'idle'
          : playbackStatus === 'error' ? 'error'
          : playbackStatus === 'loading' ? 'loading'
          : 'active';
        // Idle/active glow on a genre pad is a genuine hardware mirror, so it
        // stays MIDI-only (its whole point is showing the same colour the LED
        // is actually showing). NTS has no APC mini pad of its own, so its
        // idle glow is decorative consistency rather than a literal mirror,
        // but it's gated behind midiConnected the same way so it only shows
        // up alongside every other pad's colour-coded glow, not on its own.
        // Loading and error aren't decorative, they're the only pulse/colour
        // feedback a station is loading or failed - gating those behind
        // midiConnected too meant nobody using the app without the
        // controller ever saw any loading pulse at all, just a static border.
        const showGlow = midiConnected || glowState === 'loading' || glowState === 'error';
        const glowColour = item.kind === 'nts' ? NTS_GLOW_COLOUR : GENRE_GLOW_COLOURS[item.glowIndex];
        return (
          <VibePad
            key={itemLabel(item)}
            label={itemLabel(item)}
            isActive={isActive}
            onClick={item.kind === 'nts' ? onNtsClick : () => onPadClick(item.label)}
            glow={showGlow ? { colour: glowColour, state: glowState } : null}
          />
        );
      })}
    </div>
  );
}
