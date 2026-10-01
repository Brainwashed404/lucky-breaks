import { motion } from 'framer-motion';
import type { CSSProperties } from 'react';
import styles from './VibePads.module.css';

export type PadGlowState = 'idle' | 'active' | 'loading' | 'error';

interface VibePadProps {
  /** A PadLabel for genre pads, or any other display string for a special
   *  non-genre pad (e.g. 'NTS'). Purely text here, lookups happen upstream. */
  label: string;
  isActive: boolean;
  onClick: () => void;
  /** Colour + state of this pad's LED on the connected APC mini, or null when MIDI
   *  isn't connected. Mirrors the hardware exactly rather than just echoing isActive,
   *  so a station loading or erroring shows the same amber/red the pad shows. */
  glow?: { colour: string; state: PadGlowState } | null;
}

const GLOW_CLASS: Record<PadGlowState, string> = {
  idle: 'padGlowIdle',
  active: 'padGlowActive',
  loading: 'padGlowLoading',
  error: 'padGlowError',
};

export function VibePad({ label, isActive, onClick, glow }: VibePadProps) {
  const glowClass = glow ? styles[GLOW_CLASS[glow.state]] : '';
  return (
    <div className={styles.padWrapper}>
      <span className={styles.padLabel}>{label}</span>
      <motion.button
        className={`${styles.pad} ${isActive ? styles.padActive : ''} ${glowClass}`}
        style={glow ? ({ '--glow-colour': glow.colour } as CSSProperties) : undefined}
        onClick={onClick}
        whileTap={{ scale: 0.96, y: 1 }}
        transition={{ type: 'spring', stiffness: 600, damping: 20 }}
        aria-pressed={isActive}
        aria-label={label}
      >
        {isActive && (
          <span className={styles.shuffleHint}>⇄</span>
        )}
      </motion.button>
    </div>
  );
}
