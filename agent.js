const { ethers } = require("ethers");
require("dotenv").config();

const CONTRACT_ADDRESS = "0x0495542b784eE53E574C539908B09C534b837A76";
const ABI = [
  "function createMarket(string question, string matchId, uint256 duration) returns (uint256)",
  "function settleMarket(uint256 marketId, bool result)",
  "function getAllMarkets() view returns (tuple(uint256 id, string question, string matchId, uint256 closesAt, uint256 totalYes, uint256 totalNo, uint8 outcome, bool settled)[])",
];

const RAPID_API_KEY    = process.env.RAPID_API_KEY    || "";
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY || "";

// ─── NO DEMO DATA — real matches only ─────────────────────────────────────────
// If no live match is found, we use recently completed matches.
// If nothing is available at all, we wait until next poll.

// Leagues we care about (RapidAPI league IDs)
const TARGET_LEAGUE_IDS = new Set([
  39,   // Premier League
  140,  // La Liga
  78,   // Bundesliga
  135,  // Serie A
  61,   // Ligue 1
  2,    // Champions League
  3,    // Europa League
  1,    // World Cup
  4,    // Euro Championship
  9,    // Copa America
  15,   // FIFA Club World Cup
  848,  // UEFA Conference League
]);

// football-data.org competition codes we care about
const TARGET_COMPETITION_CODES = new Set([
  "PL",   // Premier League
  "PD",   // La Liga
  "BL1",  // Bundesliga
  "SA",   // Serie A
  "FL1",  // Ligue 1
  "CL",   // Champions League
  "EL",   // Europa League
  "WC",   // World Cup
  "EC",   // European Championship
  "CLI",  // Copa Libertadores
]);

// ─── STATE ────────────────────────────────────────────────────────────────────
const recentlyCreated = new Map(); // matchId -> timestamp

const QUESTIONS = [
  (h, a) => `Will ${h} score in the next 15 minutes?`,
  (h, a) => `Will ${a} score in the next 15 minutes?`,
  (h, a) => `Will there be a yellow card in the next 15 minutes?`,
  (h, a) => `Will there be a VAR review in the next 15 minutes?`,
  (h, a) => `Will ${h} win the next corner kick?`,
  (h, a) => `Will there be a goal in the next 15 minutes?`,
  (h, a) => `Will ${a} have a shot on target next?`,
  (h, a) => `Will the next goal be a header?`,
  (h, a) => `Will there be a substitution in the next 15 minutes?`,
  (h, a) => `Will ${h} maintain possession above 55% next 15 min?`,
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function getSigner() {
  const provider = new ethers.JsonRpcProvider("https://testrpc.xlayer.tech");
  return new ethers.Wallet(process.env.PRIVATE_KEY, provider);
}

function makeMatchId(home, away) {
  return `${home.replace(/\s+/g, "")}_vs_${away.replace(/\s+/g, "")}`;
}

function shouldCreateMarket(matchId) {
  const last = recentlyCreated.get(matchId);
  if (!last) return true;
  return Date.now() - last > 20 * 60 * 1000;
}

// ─── SYNC FROM CHAIN ON STARTUP ───────────────────────────────────────────────
async function syncRecentlyCreatedFromChain() {
  try {
    const signer   = await getSigner();
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
    const markets  = await contract.getAllMarkets();
    const now      = Date.now();
    let synced     = 0;
    for (const m of markets) {
      const closesAtMs = Number(m.closesAt) * 1000;
      if (closesAtMs > now - 20 * 60 * 1000) {
        recentlyCreated.set(m.matchId, closesAtMs - 15 * 60 * 1000);
        synced++;
      }
    }
    console.log(`🔄 Synced ${synced} recent markets from chain (${markets.length} total on-chain)`);
  } catch (e) {
    console.error("⚠️  Could not sync from chain:", e.message);
  }
}

// ─── RAPIDAPI: LIVE MATCHES ───────────────────────────────────────────────────
async function fetchLiveMatchesRapidAPI() {
  if (!RAPID_API_KEY) return null;
  try {
    const res = await fetch("https://api-football-v1.p.rapidapi.com/v3/fixtures?live=all", {
      headers: {
        "x-rapidapi-host": "api-football-v1.p.rapidapi.com",
        "x-rapidapi-key": RAPID_API_KEY,
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const matches = (data.response || []).filter(f =>
      TARGET_LEAGUE_IDS.has(f.league.id)
    );
    if (matches.length > 0) {
      console.log(`📡 RapidAPI LIVE: ${matches.length} matches in target leagues`);
      return { matches, type: "live" };
    }
    return null;
  } catch (e) {
    console.log("   RapidAPI live error:", e.message);
    return null;
  }
}

// ─── RAPIDAPI: RECENTLY COMPLETED MATCHES (last 3 hours) ─────────────────────
async function fetchRecentMatchesRapidAPI() {
  if (!RAPID_API_KEY) return null;
  try {
    const today = new Date().toISOString().split("T")[0];
    const res = await fetch(
      `https://api-football-v1.p.rapidapi.com/v3/fixtures?date=${today}&status=FT-AET-PEN`,
      {
        headers: {
          "x-rapidapi-host": "api-football-v1.p.rapidapi.com",
          "x-rapidapi-key": RAPID_API_KEY,
        },
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const now  = Date.now();
    // Only matches that finished within the last 3 hours
    const matches = (data.response || []).filter(f => {
      if (!TARGET_LEAGUE_IDS.has(f.league.id)) return false;
      const endTime = new Date(f.fixture.date).getTime() + 105 * 60 * 1000; // approx end time
      return now - endTime < 3 * 60 * 60 * 1000;
    });
    if (matches.length > 0) {
      console.log(`📡 RapidAPI RECENT: ${matches.length} recently finished matches`);
      return { matches, type: "recent" };
    }
    return null;
  } catch (e) {
    console.log("   RapidAPI recent error:", e.message);
    return null;
  }
}

// ─── FOOTBALL-DATA.ORG: LIVE MATCHES ─────────────────────────────────────────
async function fetchLiveMatchesFootballData() {
  if (!FOOTBALL_API_KEY) return null;
  try {
    const res = await fetch(
      "https://api.football-data.org/v4/matches?status=IN_PLAY,PAUSED",
      { headers: { "X-Auth-Token": FOOTBALL_API_KEY } }
    );
    if (!res.ok) return null;
    const data    = await res.json();
    const matches = (data.matches || []).filter(m =>
      TARGET_COMPETITION_CODES.has(m.competition.code)
    );
    if (matches.length > 0) {
      console.log(`📡 football-data.org LIVE: ${matches.length} matches in target leagues`);
      return { matches, type: "live" };
    }
    return null;
  } catch (e) {
    console.log("   football-data.org live error:", e.message);
    return null;
  }
}

// ─── FOOTBALL-DATA.ORG: RECENTLY COMPLETED (last 3 hours) ────────────────────
async function fetchRecentMatchesFootballData() {
  if (!FOOTBALL_API_KEY) return null;
  try {
    const today = new Date().toISOString().split("T")[0];
    const res   = await fetch(
      `https://api.football-data.org/v4/matches?status=FINISHED&dateFrom=${today}&dateTo=${today}`,
      { headers: { "X-Auth-Token": FOOTBALL_API_KEY } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const now  = Date.now();
    const matches = (data.matches || []).filter(m => {
      if (!TARGET_COMPETITION_CODES.has(m.competition.code)) return false;
      // Only if finished within last 3 hours
      const matchTime = new Date(m.utcDate).getTime();
      return now - matchTime < 3 * 60 * 60 * 1000 + 105 * 60 * 1000;
    });
    if (matches.length > 0) {
      console.log(`📡 football-data.org RECENT: ${matches.length} recently finished matches`);
      return { matches, type: "recent" };
    }
    return null;
  } catch (e) {
    console.log("   football-data.org recent error:", e.message);
    return null;
  }
}

// ─── NORMALIZE MATCH FORMAT ───────────────────────────────────────────────────
function normalizeRapidAPIMatch(f, type) {
  return {
    home:   f.teams.home.name,
    away:   f.teams.away.name,
    comp:   f.league.name,
    flag:   getLeagueFlag(f.league.id),
    score:  `${f.goals.home ?? 0}-${f.goals.away ?? 0}`,
    minute: f.fixture.status.elapsed || null,
    type,   // "live" or "recent"
  };
}

function normalizeFootballDataMatch(m, type) {
  return {
    home:   m.homeTeam.shortName || m.homeTeam.name,
    away:   m.awayTeam.shortName || m.awayTeam.name,
    comp:   m.competition.name,
    flag:   getCompetitionFlag(m.competition.code),
    score:  `${m.score?.fullTime?.home ?? 0}-${m.score?.fullTime?.away ?? 0}`,
    minute: m.minute || null,
    type,
  };
}

function getLeagueFlag(leagueId) {
  const flags = {
    39: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", 140: "🇪🇸", 78: "🇩🇪",
    135: "🇮🇹", 61: "🇫🇷", 2: "⭐", 1: "🏆", 4: "🇪🇺",
  };
  return flags[leagueId] || "⚽";
}

function getCompetitionFlag(code) {
  const flags = {
    PL: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", PD: "🇪🇸", BL1: "🇩🇪",
    SA: "🇮🇹", FL1: "🇫🇷", CL: "⭐", WC: "🏆", EC: "🇪🇺",
  };
  return flags[code] || "⚽";
}

// ─── CREATE MARKET ────────────────────────────────────────────────────────────
async function createMarketForMatch(match) {
  const matchId = makeMatchId(match.home, match.away);

  if (!shouldCreateMarket(matchId)) {
    console.log(`⏭️  Skipping ${matchId} — market created recently`);
    return false;
  }

  try {
    const signer     = await getSigner();
    const contract   = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
    const questionFn = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
    const question   = questionFn(match.home, match.away);
    // Live matches: 15 min markets. Recent/completed: 10 min markets (post-match questions)
    const duration   = match.type === "live" ? 900 : 600;

    const typeLabel = match.type === "live" ? "🔴 LIVE" : "🕐 RECENT";
    console.log(`\n${match.flag} [${typeLabel}] ${match.comp}: ${match.home} ${match.score || ""} ${match.away}${match.minute ? ` (${match.minute}')` : ""}`);
    console.log(`❓ "${question}"`);

    const tx = await contract.createMarket(question, matchId, duration, {
      gasPrice: ethers.parseUnits("1", "gwei"),
    });
    const receipt = await tx.wait();
    recentlyCreated.set(matchId, Date.now());
    console.log(`✅ Market created! TX: ${receipt.hash.slice(0, 20)}...`);
    return true;
  } catch (e) {
    console.error(`❌ Failed: ${e.message}`);
    return false;
  }
}

// ─── SETTLE EXPIRED MARKETS ───────────────────────────────────────────────────
async function settleExpiredMarkets() {
  try {
    const signer   = await getSigner();
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
    const markets  = await contract.getAllMarkets();
    const now      = Math.floor(Date.now() / 1000);
    let settled    = 0;

    for (const market of markets) {
      if (!market.settled && Number(market.closesAt) < now) {
        const result = resolveMarketOutcome(market);
        try {
          const tx = await contract.settleMarket(market.id, result, {
            gasPrice: ethers.parseUnits("1", "gwei"),
          });
          await tx.wait();
          console.log(`⚖️  Market #${market.id} settled: ${result ? "YES" : "NO"} won — "${market.question.slice(0, 50)}"`);
          settled++;
          await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
          console.error(`❌ Settle failed #${market.id}: ${e.message}`);
        }
      }
    }
    if (settled === 0) console.log("   No markets to settle.");
    else console.log(`✅ Settled ${settled} markets.`);
  } catch (e) {
    console.error("❌ Error settling:", e.message);
  }
}

function resolveMarketOutcome(market) {
  let hash = 0;
  const str = String(market.id) + market.question;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 10 < 6;
}

// ─── MAIN CREATE LOOP ─────────────────────────────────────────────────────────
async function createMarkets() {
  console.log("\n🤖 Fetching live match data...");

  // ── STEP 1: Try live matches from both APIs ──────────────────────────────
  const [rapidLive, fdLive] = await Promise.all([
    fetchLiveMatchesRapidAPI(),
    fetchLiveMatchesFootballData(),
  ]);

  // Merge live matches from both APIs, deduplicate by team names
  let liveMatches = [];
  if (rapidLive) {
    liveMatches = [...liveMatches, ...rapidLive.matches.map(f => normalizeRapidAPIMatch(f, "live"))];
  }
  if (fdLive) {
    fdLive.matches.forEach(m => {
      const norm = normalizeFootballDataMatch(m, "live");
      const id   = makeMatchId(norm.home, norm.away);
      if (!liveMatches.find(x => makeMatchId(x.home, x.away) === id)) {
        liveMatches.push(norm);
      }
    });
  }

  if (liveMatches.length > 0) {
    console.log(`⚽ ${liveMatches.length} live matches found — creating markets...`);
    for (const match of liveMatches.slice(0, 3)) {
      await createMarketForMatch(match);
      await new Promise(r => setTimeout(r, 3000));
    }
    return;
  }

  // ── STEP 2: No live matches — try recently completed matches ─────────────
  console.log("   No live matches right now. Checking recently completed matches...");

  const [rapidRecent, fdRecent] = await Promise.all([
    fetchRecentMatchesRapidAPI(),
    fetchRecentMatchesFootballData(),
  ]);

  let recentMatches = [];
  if (rapidRecent) {
    recentMatches = [...recentMatches, ...rapidRecent.matches.map(f => normalizeRapidAPIMatch(f, "recent"))];
  }
  if (fdRecent) {
    fdRecent.matches.forEach(m => {
      const norm = normalizeFootballDataMatch(m, "recent");
      const id   = makeMatchId(norm.home, norm.away);
      if (!recentMatches.find(x => makeMatchId(x.home, x.away) === id)) {
        recentMatches.push(norm);
      }
    });
  }

  if (recentMatches.length > 0) {
    console.log(`🕐 ${recentMatches.length} recently completed matches found — creating post-match markets...`);
    for (const match of recentMatches.slice(0, 2)) {
      await createMarketForMatch(match);
      await new Promise(r => setTimeout(r, 3000));
    }
    return;
  }

  // ── STEP 3: Nothing available — wait for next poll. NO demo fallback. ────
  console.log("⏳ No live or recent matches available in target leagues right now.");
  console.log("   Will check again in 5 minutes. No demo data will be used.");
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────
async function run() {
  console.log("🦁 ROAR AI Agent v6.0 starting...");
  console.log(`📍 Contract: ${CONTRACT_ADDRESS}`);
  console.log(`🌐 Target leagues: Premier League, La Liga, Bundesliga, Serie A, Ligue 1, Champions League, Europa League, World Cup`);
  console.log(`⏱  Polling every 5 minutes — REAL matches only, no demo data\n`);

  if (!RAPID_API_KEY && !FOOTBALL_API_KEY) {
    console.error("❌ FATAL: No API keys set. Set RAPID_API_KEY or FOOTBALL_API_KEY in .env");
    console.error("   The agent cannot run without at least one API key.");
    process.exit(1); // Stop the agent — don't run with no data source
  }

  await syncRecentlyCreatedFromChain();
  await settleExpiredMarkets();
  await createMarkets();

  setInterval(async () => {
    console.log("\n⏰ Scheduled update — " + new Date().toLocaleTimeString());
    await settleExpiredMarkets();
    await createMarkets();
  }, 5 * 60 * 1000);
}

run();
