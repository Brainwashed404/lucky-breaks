/**
 * Sync from Google Sheet → stations.ts
 *
 * Reads Genres and Stations tabs as source of truth.
 * Also checks Form Responses for new submissions and appends them to Stations tab.
 *
 * Run: npm run sync-stations
 */
import { google } from 'googleapis';
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATIONS_FILE = path.join(ROOT, 'src/data/stations.ts');
const SHEET_ID = '1gfB4LfRESfMS25y8mXO80KIBnjAfued3OUuEDjRHvFA';
const CREDENTIALS = process.env.GOOGLE_CREDENTIALS
  ? JSON.parse(process.env.GOOGLE_CREDENTIALS)
  : path.join(process.env.HOME, 'Documents/lucky-breaks-service-account.json');

// Station IDs permanently removed from the app (dead streams, broken URLs, etc.)
// Add an ID here to prevent it from being restored by the next sheet sync.
const DELETED_STATION_IDS = new Set([
  'all-star-hip-hop',
  'the-block-105-radio',
  'boom-bap-boombox',
  'compton-2-new-york-radio',
  'diggindaily-radio',
  'gauguin-gardens',
  'hawaiian-hifi',
  'hip-hop-museum-network',
  'interstellar-espionage-radio',
  'jazz-from-gallery-41',
  'jet-set-radio',
  'kpiss-fm',
  'the-lake',
  'oldies-by-the-year',
  'public-enemy-radio',
  'rap-inst',
  'reggae-memories',
  'reggae-town-music',
  'rods-classic-rock',
  'the-slacker-bys',
  'slackline-radio',
  'soul-monster',
  'soul-source-radio',
  'surf-city-radio',
  'ven-jahs-radio',
  'rovr',
  'planet-pootwaddle',
  'radio-punctum',
  'hall-oates-radio',
  '20ft-radio',
  'mmr-midnite-memories-radio',
  'vintage-broadcast',
  'lucky-breaks',
  'dinamo-sleep',
  'dinamo-discotheque',
]);

// Field fixes for stations whose Google Sheet data is stale or wrong
// (e.g. a provider changed its stream URL format). These are applied
// after every sheet sync so they survive until the Sheet itself is corrected.
// Add an id here with only the fields that need overriding.
const STATION_OVERRIDES = {
  'musicmaster-oldies': {
    streamUrl: 'https://icecast.a-ware.com:8001/mmoldies.mp3',
    websiteUrl: 'https://musicmasteroldies.com',
  },
  'remember-then-radio': {
    streamUrl: 'https://s1.nexuscast.com:8083/;',
    websiteUrl: 'https://rememberthenradio.com',
  },
  'psychedelicized': {
    streamUrl: 'https://stream.psychedelicized.com/listen/psychedelicized/radio.mp3',
  },
  'somafm-deep-space-one': { streamUrl: 'https://ice.somafm.com/deepspaceone-128-mp3' },
  'somafm-drone-zone': { streamUrl: 'https://ice.somafm.com/dronezone-128-mp3' },
  'somafm-groove-salad': { streamUrl: 'https://ice.somafm.com/groovesalad-128-mp3' },
  'somafm-mission-control': { streamUrl: 'https://ice.somafm.com/missioncontrol-128-mp3' },
  'somafm-heavyweight-reggae': { streamUrl: 'https://ice.somafm.com/reggae-128-mp3' },
  'somafm-cliqhop-idm': { streamUrl: 'https://ice.somafm.com/cliqhop-128-mp3' },
  'somafm-fluid': { streamUrl: 'https://ice.somafm.com/fluid-128-mp3' },
  'somafm-lush': { streamUrl: 'https://ice.somafm.com/lush-128-mp3' },
  'somafm-underground-80s': { streamUrl: 'https://ice.somafm.com/u80s-128-mp3' },
  'somafm-vaporwaves': { streamUrl: 'https://ice.somafm.com/vaporwaves-128-mp3' },
  'somafm-bossa-beyond': { streamUrl: 'https://ice.somafm.com/bossa-128-mp3' },
  'somafm-secret-agent': { streamUrl: 'https://ice.somafm.com/secretagent-128-mp3' },
  'somafm-tiki-time': { streamUrl: 'https://ice.somafm.com/tikitime-128-mp3' },
  'somafm-digitalis': { streamUrl: 'https://ice.somafm.com/digitalis-128-mp3' },
  'somafm-folk-forward': { streamUrl: 'https://ice.somafm.com/folkfwd-128-mp3' },
  'somafm-seven-inch-soul': { streamUrl: 'https://ice.somafm.com/7soul-128-mp3' },
  'somafm-the-in-sound': { streamUrl: 'https://ice.somafm.com/insound-128-mp3' },
  'underground-bass': { streamUrl: 'https://listen.undergroundbass.com:8804/stream' },
  'nts-slow-focus': { streamUrl: 'https://stream-mixtape-geo.ntslive.net/mixtape' },
};

function toId(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function generateStationsTs(genres, stations) {
  const genreType = genres
    .map(g => `  | '${g.internalName}'`)
    .join('\n');

  const padLabelsArr = genres
    .map(g => `  '${g.padLabel}'`)
    .join(',\n');

  const padGenreMapEntries = genres
    .map(g => `  '${g.padLabel}': '${g.internalName}'`)
    .join(',\n');

  // Group stations by primary genre for section comments
  const byGenre = {};
  for (const g of genres) byGenre[g.internalName] = [];
  const multiGenre = [];

  for (const s of stations) {
    const genres = s.genre.split(',').map(g => g.trim()).filter(Boolean);
    if (genres.length > 1) {
      multiGenre.push({ ...s, genreArr: genres });
    } else {
      const g = genres[0];
      if (byGenre[g]) byGenre[g].push(s);
      else byGenre[g] = [s];
    }
  }

  // Sort stations within each genre alphabetically
  const sortKey = name => {
    const stripped = name.replace(/^(the|a|an)\s+/i, '').toLowerCase();
    return /^\d/.test(stripped) ? 'zzz_' + stripped : stripped;
  };

  for (const g of Object.keys(byGenre)) {
    byGenre[g].sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));
  }
  multiGenre.sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));

  const stationToTs = (s) => {
    const genreArr = Array.isArray(s.genreArr) ? s.genreArr : s.genre.split(',').map(g => g.trim());
    const genreVal = genreArr.length > 1
      ? `[${genreArr.map(g => `'${g}'`).join(', ')}]`
      : `'${genreArr[0]}'`;
    return `  {
    id: '${s.id}',
    name: '${s.name.replace(/'/g, "\\'")}',
    description: '${(s.description || '').replace(/'/g, "\\'")}',
    streamUrl: '${s.streamUrl}',
    websiteUrl: '${s.websiteUrl}',
    genre: ${genreVal},
  },`;
  };

  let stationsSections = '';
  for (const g of Object.keys(byGenre)) {
    if (byGenre[g].length === 0) continue;
    const bar = '─'.repeat(70 - g.length);
    stationsSections += `\n  // ─── ${g} ${bar}\n`;
    stationsSections += byGenre[g].map(stationToTs).join('\n') + '\n';
  }
  if (multiGenre.length > 0) {
    stationsSections += `\n  // ─── MULTI-GENRE ──────────────────────────────────────────────────────\n`;
    stationsSections += multiGenre.map(stationToTs).join('\n') + '\n';
  }

  return `// AUTO-GENERATED — edit via Google Sheet, not directly in this file
// Sheet: https://docs.google.com/spreadsheets/d/${SHEET_ID}
// Last synced: ${new Date().toISOString()}

export type Genre =
${genreType};

export interface Station {
  id: string;
  name: string;
  description: string;
  streamUrl: string;
  websiteUrl: string;
  genre: Genre | Genre[];
}

export function stationInGenre(station: Station, genre: Genre): boolean {
  return Array.isArray(station.genre)
    ? station.genre.includes(genre)
    : station.genre === genre;
}

export const PAD_LABELS = [
${padLabelsArr},
] as const;

export type PadLabel = typeof PAD_LABELS[number];

export const PAD_GENRE_MAP: Record<PadLabel, Genre> = {
${padGenreMapEntries},
};

export function getStationsByGenre(genre: Genre): Station[] {
  return stations.filter((s) => stationInGenre(s, genre));
}

export const stations: Station[] = [${stationsSections}];
`;
}

async function main() {
  const auth = new google.auth.GoogleAuth({
    ...(typeof CREDENTIALS === 'string' ? { keyFile: CREDENTIALS } : { credentials: CREDENTIALS }),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Read Genres tab
  const genresRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Genres!A2:B1000',
  });
  const genres = (genresRes.data.values || [])
    .filter(r => r[0] && r[1])
    .map(r => ({ internalName: r[0].trim(), padLabel: r[1].trim() }))
    .sort((a, b) => a.padLabel.localeCompare(b.padLabel));

  if (genres.length === 0) {
    console.error('No genres found in Genres tab. Run export-to-sheet.mjs first.');
    process.exit(1);
  }

  const validGenres = new Set(genres.map(g => g.internalName));

  // Read Stations tab
  const stationsRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Stations!A2:F10000',
  });
  const stationRows = stationsRes.data.values || [];
  const stations = stationRows
    .filter(r => r[1] && r[3]) // must have name and stream URL
    .map(r => ({
      id: r[0]?.trim() || toId(r[1]),
      name: r[1].trim(),
      description: (r[2] || '').trim(),
      streamUrl: r[3].trim(),
      websiteUrl: (r[4] || '').trim(),
      genre: (r[5] || '').trim(),
    }))
    .filter(s => {
      if (DELETED_STATION_IDS.has(s.id)) return false;
      const gs = s.genre.split(',').map(g => g.trim());
      return gs.length > 0 && gs[0] !== '' && gs.every(g => validGenres.has(g));
    })
    .map(s => STATION_OVERRIDES[s.id] ? { ...s, ...STATION_OVERRIDES[s.id] } : s);

  // Check Form Responses for new submissions
  let newStations = [];
  try {
    const formRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Form responses 1!B2:F1000',
    });
    const existingIds = new Set(stations.map(s => s.id));
    const formRows = formRes.data.values || [];
    newStations = formRows
      .filter(r => r[0] && r[2])
      .map(r => ({
        id: toId(r[0]),
        name: r[0].trim(),
        description: (r[1] || '').trim(),
        streamUrl: r[2].trim(),
        websiteUrl: (r[3] || '').trim(),
        genre: (r[4] || '').trim(),
      }))
      .filter(s => {
        if (existingIds.has(s.id)) return false;
        if (DELETED_STATION_IDS.has(s.id)) return false;
        const gs = s.genre.split(',').map(g => g.trim());
        return gs.length > 0 && gs[0] !== '' && gs.every(g => validGenres.has(g));
      });

    if (newStations.length > 0) {
      console.log(`Found ${newStations.length} new form submission(s) — adding to Stations tab:`);
      newStations.forEach(s => console.log(`  + ${s.name} (${s.genre})`));

      // Append to Stations tab
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'Stations!A1',
        valueInputOption: 'RAW',
        requestBody: {
          values: newStations.map(s => [s.id, s.name, s.description, s.streamUrl, s.websiteUrl, s.genre]),
        },
      });
      stations.push(...newStations);
    }
  } catch {
    // Form responses tab may not exist — that's fine
  }

  console.log(`Generating stations.ts from ${genres.length} genres, ${stations.length} stations...`);

  const content = generateStationsTs(genres, stations);

  // Skip the write entirely when only the "Last synced" timestamp would
  // differ. This runs daily, and the sheet usually hasn't changed: without
  // this, every run rewrote that one comment line, which defeated the
  // workflow's own "commit only if changed" guard and pushed a commit every
  // single day. Each of those triggered a full production deploy that
  // retains its own function bundle, and ~1,200 of them filled Vercel's
  // 10GB Function Storage with deploys of nothing but a changed timestamp.
  const stripTimestamp = (s) => s.replace(/^\/\/ Last synced:.*$/m, '');
  let unchanged = false;
  try {
    unchanged = stripTimestamp(readFileSync(STATIONS_FILE, 'utf8')) === stripTimestamp(content);
  } catch {
    // No existing file - fall through and write it.
  }

  if (unchanged) {
    console.log('No station changes, leaving stations.ts untouched.');
  } else {
    writeFileSync(STATIONS_FILE, content);
    console.log('stations.ts written.');
  }

  if (!process.env.CI) {
    console.log('Building...');
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
    execSync('git config user.email "bot@luckybreaks.xyz"', { cwd: ROOT });
    execSync('git config user.name "lucky-breaks-bot"', { cwd: ROOT });
    execSync('git add src/data/stations.ts', { cwd: ROOT });
    const hasChanges = (() => {
      try { execSync('git diff --staged --quiet', { cwd: ROOT }); return false; }
      catch { return true; }
    })();
    if (hasChanges) {
      execSync(`git commit -m "Sync stations from sheet"`, { cwd: ROOT, stdio: 'inherit' });
      execSync('git push', { cwd: ROOT, stdio: 'inherit' });
      console.log('Done — pushed.');
    } else {
      console.log('No changes.');
    }
  } else {
    if (newStations.length > 0) {
      console.log(`ADDED_STATIONS=${newStations.map(s => s.name).join(', ')}`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
