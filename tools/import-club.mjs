// scripts/importClub.ts
import { mkdir, writeFile } from "node:fs/promises";

// src/club/clubData.ts
var CLUB_UMA = [45, 5, -15, -35];
var CLUB_RETURN_POINTS = 25e3;
function rankedPoints(scores) {
  return scores.map((score) => {
    const tiedPlaces = scores.map((other, index) => ({ other, index })).filter(({ other }) => other === score).map(({ index }) => index);
    const placementPoints = tiedPlaces.reduce((sum, index) => sum + CLUB_UMA[index], 0) / tiedPlaces.length;
    return Math.round(((score - CLUB_RETURN_POINTS) / 1e3 + placementPoints) * 10) / 10;
  });
}
function placements(scores) {
  return scores.map((score) => scores.findIndex((other) => other === score) + 1);
}

// src/club/parseClubPages.ts
var ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
function htmlToText(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (match, entity) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith("#") && !(entity in ENTITIES)) return String.fromCodePoint(Number(entity.slice(1)));
    return ENTITIES[entity] ?? match;
  }).replace(/\s+/g, " ").trim();
}
function parseNumber(text) {
  const cleaned = text.replace(/[,%+\s]/g, "");
  const value = Number(cleaned);
  if (cleaned === "" || Number.isNaN(value)) {
    throw new Error(`Not a number: "${text}"`);
  }
  return value;
}
function textOfClass(html, className) {
  const match = html.match(new RegExp(`<(\\w+)[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1>`));
  return match ? htmlToText(match[2]) : null;
}
function statValue(card, label) {
  for (const [, term, value] of card.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) {
    if (htmlToText(term) === label) return parseNumber(htmlToText(value));
  }
  throw new Error(`Couldn't find "${label}" in a player card`);
}
function parsePlayerList(html) {
  const players = [];
  const cardPattern = /<a\b[^>]*\bhref="\/semester\/[^/"]+\/player\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const [, id, card] of html.matchAll(cardPattern)) {
    if (!card.includes("player-card-stats")) continue;
    const heading = card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? "";
    const name = htmlToText(heading.replace(/<span[^>]*campus-position[^>]*>[\s\S]*?<\/span>/, ""));
    const percents = [...card.matchAll(/class="placement-share"[\s\S]*?<strong>([\s\S]*?)<\/strong>/g)].map(
      ([, value]) => parseNumber(htmlToText(value))
    );
    if (!name || percents.length !== 4) {
      throw new Error(`Couldn't read the player card for ${id}: ${htmlToText(card)}`);
    }
    players.push({
      id,
      name,
      points: statValue(card, "Total PT"),
      gamesPlayed: statValue(card, "Games played"),
      averagePlacement: statValue(card, "Avg. placement"),
      placementPercents: percents,
      rank: textOfClass(card, "card-rank") ?? ""
    });
  }
  return players;
}
function parsePlayerGames(html, playerId, firstRow = 0) {
  const table = html.match(/<table[^>]*\bmatch-table\b[^>]*>([\s\S]*?)<\/table>/)?.[1] ?? "";
  const body = table.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  const games = [];
  for (const [rowIndex, [, row]] of [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].entries()) {
    const date = htmlToText(row.match(/<td>([\s\S]*?)<\/td>/)?.[1] ?? "");
    const pointChange = parseNumber(textOfClass(row, "pt-value") ?? "");
    const players = row.split(/<div class="match-player\b/).slice(1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || players.length !== 4) {
      throw new Error(`Couldn't read a game row on player ${playerId}'s page: ${htmlToText(row)}`);
    }
    const seats = players.map((player) => {
      const isThisPlayer = /^[^"]*\bis-you\b/.test(player);
      return {
        name: htmlToText(player.match(/<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? ""),
        score: parseNumber(htmlToText(player.match(/<small[^>]*>([\s\S]*?)<\/small>/)?.[1] ?? "")),
        playerId: isThisPlayer ? playerId : null,
        pointChange: isThisPlayer ? pointChange : null,
        pageRow: isThisPlayer ? firstRow + rowIndex : null
      };
    });
    games.push({ date, seats });
  }
  return games;
}
function historyPageCount(html) {
  const pages = html.match(/<nav[^>]*\bhistory-pagination\b[^>]*\bdata-pages="(\d+)"/)?.[1];
  return pages ? Number(pages) : 1;
}
function gameKey(game) {
  return `${game.date}|${game.seats.map((seat) => `${seat.name}:${seat.score}`).join("|")}`;
}
function mergeGames(gameLists) {
  const merged = /* @__PURE__ */ new Map();
  for (const games of gameLists) {
    for (const game of games) {
      const key = gameKey(game);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, structuredClone(game));
        continue;
      }
      game.seats.forEach((seat, index) => {
        if (seat.playerId) {
          existing.seats[index].playerId = seat.playerId;
          existing.seats[index].pointChange = seat.pointChange;
          existing.seats[index].pageRow = seat.pageRow;
        }
      });
    }
  }
  return [...merged.values()].sort((first, second) => second.date.localeCompare(first.date));
}

// scripts/importClub.ts
var SITE = "https://uiucriichi.web.illinois.edu";
var OUTPUT_DIRECTORY = "club-data";
var PAUSE_MS = 500;
var ATTEMPTS = 4;
var pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function fetchPage(path) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${SITE}${path}`);
      if (!response.ok) {
        throw new Error(`${path}: HTTP ${response.status}`);
      }
      const text = await response.text();
      await pause(PAUSE_MS);
      return text;
    } catch (error) {
      if (attempt === ATTEMPTS) throw error;
      const wait = PAUSE_MS * 4 ** attempt;
      console.log(`
  ${path} failed (${error instanceof Error ? error.message : error}); retrying in ${wait / 1e3}s...`);
      await pause(wait);
    }
  }
}
function checkAgainstSite(data) {
  const problems = [];
  for (const player of data.players) {
    const games = data.games.filter((game) => game.seats.some((seat) => seat.playerId === player.id));
    const places = [];
    let points = 0;
    let siteRowPoints = 0;
    for (const game of games) {
      const scores = game.seats.map((seat) => seat.score);
      const index = game.seats.findIndex((seat) => seat.playerId === player.id);
      places.push(placements(scores)[index]);
      points += rankedPoints(scores)[index];
      siteRowPoints += game.seats[index].pointChange ?? 0;
    }
    const average = places.reduce((sum, place) => sum + place, 0) / Math.max(1, places.length);
    if (games.length !== player.gamesPlayed) {
      problems.push(`${player.name}: ${games.length} games found, site says ${player.gamesPlayed}`);
    }
    if (Math.abs(average - player.averagePlacement) > 6e-3) {
      problems.push(`${player.name}: average placement ${average.toFixed(2)}, site says ${player.averagePlacement}`);
    }
    if (Math.abs(points - player.points) > 0.15) {
      const reason = Math.abs(siteRowPoints - points) <= 0.15 ? ` (the site's own game list adds up to ${points.toFixed(1)} too, so the ranking page includes an adjustment outside the games)` : "";
      problems.push(`${player.name}: ${points.toFixed(1)} points, ranking page says ${player.points}${reason}`);
    }
  }
  return problems;
}
async function readPlayerGames(semester, playerId) {
  const path = `/semester/${semester}/player/${playerId}`;
  const firstPage = await fetchPage(path);
  const games = parsePlayerGames(firstPage, playerId);
  for (let page = 2; page <= historyPageCount(firstPage); page++) {
    games.push(...parsePlayerGames(await fetchPage(`${path}?page=${page}`), playerId, games.length));
  }
  return games;
}
async function importSemester(semester) {
  console.log(`
${semester}: reading the ranking page...`);
  const players = parsePlayerList(await fetchPage(`/semester/${semester}/players`));
  if (players.length === 0) {
    console.log(`${semester}: the club site has no games for this semester, so nothing was saved.`);
    return;
  }
  console.log(`${semester}: ${players.length} players. Reading each player's games...`);
  const gameLists = [];
  for (const [index, player] of players.entries()) {
    gameLists.push(await readPlayerGames(semester, player.id));
    process.stdout.write(`\r  ${index + 1}/${players.length}`);
  }
  console.log();
  const data = {
    semester,
    importedAt: (/* @__PURE__ */ new Date()).toISOString(),
    players,
    games: mergeGames(gameLists)
  };
  const problems = checkAgainstSite(data);
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await writeFile(`${OUTPUT_DIRECTORY}/${semester}.json`, JSON.stringify(data));
  console.log(`${semester}: saved ${data.games.length} games to ${OUTPUT_DIRECTORY}/${semester}.json`);
  if (problems.length === 0) {
    console.log(`${semester}: every player's games, average placement, and points match the club site.`);
  } else {
    console.log(`${semester}: ${problems.length} mismatch(es) with the club site:`);
    for (const problem of problems) console.log(`  - ${problem}`);
  }
}
var semesters = process.argv.slice(2);
for (const semester of semesters.length > 0 ? semesters : ["fa26"]) {
  if (!/^(fa|sp|su)\d\d$/.test(semester)) {
    console.error(`"${semester}" doesn't look like a semester (e.g. fa26, sp26, su26).`);
    process.exit(1);
  }
  await importSemester(semester);
}
