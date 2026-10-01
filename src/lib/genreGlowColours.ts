// On-screen equivalent of GENRE_PALETTE (src/lib/midi/apcMiniMk2.ts): that array is
// APC mini palette indices for the hardware LEDs, this is real CSS colour for the
// matching glow on the genre pads in the app itself. Same 12 hues, same order as
// PAD_LABELS, so a pad glows on screen the colour it's lit on the controller.
//
// Deliberately NOT a smooth rainbow in PAD_LABELS order: that put every pad next
// to another pad one hue-step away, so a whole grid of adjacent pads looked like
// shades of the same colour. A first attempt fixed that by maximising hue
// distance between neighbours (a step-5 permutation, minimum ~53 degrees apart)
// but that swung too far the other way and read as clashing - these are Radix
// UI's colours, tuned to sit well next to each other in their original order,
// and the aggressive scramble broke pairings the palette was actually designed
// around. This is gentler: each hue paired with roughly its opposite on the
// wheel, alternating warm/cool through the sequence (position i gets the hue
// that used to be 6 apart from the previous one, wrapping between two halves of
// the wheel) - checked against the desktop grid (6 across, 2 tall), the mobile
// grid (3 across, 4 tall), and the hardware's two blocks (genre 4 across x 3
// tall, visualiser 3 across x 4 tall), every neighbour is still at least ~33
// degrees apart (roughly double the original's worst case), without the harsher
// jumps of the maximally-scattered version.
export const GENRE_GLOW_COLOURS = [
  '#e5484d', // AMBIENT + CHILL: red
  '#12a594', // CLASSICAL: teal
  '#f0883e', // DNB + RAVE: orange
  '#00b8d9', // DRAMA + TALK: cyan
  '#f5d90a', // DUB + REGGAE: yellow
  '#0091ff', // ECLECTIC: sky blue
  '#b4d332', // HIP HOP + RNB: yellow-green
  '#3e63dd', // HOUSE + UKG: blue
  '#46a758', // JAZZ + EXOTICA: green
  '#8e4ec6', // LEGENDS + ERAS: purple
  '#2fbd77', // ROCK + INDIE: spring green
  '#d6409f', // SOUL + FUNK: magenta
] as const;

// DRAMA + TALK's on-screen pad was replaced by the NTS cycle button (not a
// genre, so it has no GENRE_GLOW_COLOURS slot of its own). Reuses DRAMA +
// TALK's now-unused cyan rather than introducing an unverified new hue.
export const NTS_GLOW_COLOUR = '#00b8d9';
