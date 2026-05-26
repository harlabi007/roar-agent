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

// ─── TARGET LEAGUES ───────────────────────────────────────────────────────────
const TARGET_LEAGUE_IDS = new Set([
  39, 140, 78, 135, 61, 2, 3, 1, 4, 9, 15, 848
]);
const TARGET_COMPETITION_CODES = new Set([
  "PL", "PD", "BL1", "SA", "FL1", "CL", "EL", "WC", "EC", "CLI"
]);

// ─── DEMO MARKETS (used when no live matches) ─────────────────────────────────
const DEMO_MATCHES = [
  { home: "Brazil",      away: "Argentina",  comp: "World Cup 2026", flag: "🏆" },
  { home: "England",     away: "France",     comp: "World Cup 2026", flag: "🏆" },
  { home: "Germany",     away: "Spain",      comp: "World Cup 2026", flag: "🏆" },
  { home: "Nigeria",     away: "Morocco",    comp: "World Cup 2026", flag: "🏆" },
  { home: "USA",         away: "Mexico",     comp: "World Cup 2026", flag: "🏆" },
  { home: "Portugal",    away: "Croatia",    comp: "World Cup 2026", flag: "🏆" },
  { home: "Netherlands", away: "Senegal",    comp: "World Cup 2026", flag: "🏆" },
  { home: "Japan",       away: "South Korea",comp: "World Cup 2026", flag: "🏆" },
];

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

// ─── STATE ────────────────────────────────────────────────────────────────────
const recentlyCreated = new Map();

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
  return Date.now() - last > 30 * 60 * 1000;
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
      if (closesAtMs > now - 30 * 60 * 1000) {
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
    const matches = (data.response || []).filter(f => TARGET_LEAGUE_IDS.has(f.league.id));
    if (matches.length > 0) {
      console.log(`📡 RapidAPI LIVE: ${matches.length} matches found`);
      return { matches, type: "live" };
    }
    return null;
  } catch (e) {
    console.log("   RapidAPI error:", e.message);
    return null;
  }
}

// ─── RAPIDAPI: RECENTLY COMPLETED ────────────────────────────────────────────
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
    const matches = (data.response || []).filter(f => {
      if (!TARGET_LEAGUE_IDS.has(f.league.id)) return false;
      const endTime = new Date(f.fixture.date).getTime() + 105 * 60 * 1000;
      return now - endTime < 3 * 60 * 60 * 1000;
    });
    if (matches.length > 0) {
      console.log(`📡 RapidAPI RECENT: ${matches.length} recently finished matches`);
      return { matches, type: "recent" };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ─── FOOTBALL-DATA.ORG: LIVE ──────────────────────────────────────────────────
async function fetchLiveMatchesFootballData() {
  if (!FOOTBALL_API_KEY) return null;
  try {
    const res = await fetch(
      "https://api.football-data.org/v4/matches?status=IN_PLAY,PAUSED",
      { headers: { "X-Auth-Token": FOOTBALL_API_KEY } }
    );
    if (!res.ok) return null;
    const data    = await res.json();
    const matches = (data.matches || []).filter(m => TARGET_COMPETITION_CODES.has(m.competition.code));
    if (matches.length > 0) {
      console.log(`📡 football-data.org LIVE: ${matches.length} matches found`);
      return { matches, type: "live" };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ─── FOOTBALL-DATA.ORG: RECENT ───────────────────────────────────────────────
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
      const matchTime = new Date(m.utcDate).getTime();
      return now - matchTime < 3 * 60 * 60 * 1000 + 105 * 60 * 1000;
    });
    if (matches.length > 0) {
      console.log(`📡 football-data.org RECENT: ${matches.length} recently finished matches`);
      return { matches, type: "recent" };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ─── NORMALIZE ────────────────────────────────────────────────────────────────
function normalizeRapidAPIMatch(f, type) {
  const flags = { 39:"🏴󠁧󠁢󠁥󠁮󠁧󠁿", 140:"🇪🇸", 78:"🇩🇪", 135:"🇮🇹", 61:"🇫🇷", 2:"⭐", 1:"🏆", 4:"🇪🇺" };
  return {
    home: f.teams.home.name, away: f.teams.away.name,
    comp: f.league.name, flag: flags[f.league.id] || "⚽",
    score: `${f.goals.home ?? 0}-${f.goals.away ?? 0}`,
    minute: f.fixture.status.elapsed || null, type,
  };
}

function normalizeFootballDataMatch(m, type) {
  const flags = { PL:"🏴󠁧󠁢󠁥󠁮󠁧󠁿", PD:"🇪🇸", BL1:"🇩🇪", SA:"🇮🇹", FL1:"🇫🇷", CL:"⭐", WC:"🏆", EC:"🇪🇺" };
  return {
    home: m.homeTeam.shortName || m.homeTeam.name,
    away: m.awayTeam.shortName || m.awayTeam.name,
    comp: m.competition.name, flag: flags[m.competition.code] || "⚽",
    score: `${m.score?.fullTime?.home ?? 0}-${m.score?.fullTime?.away ?? 0}`,
    minute: m.minute || null, type,
  };
}

// ─── CREATE MARKET ────────────────────────────────────────────────────────────
async function createMarketForMatch(match, durationSeconds) {
  const matchId  = makeMatchId(match.home, match.away);
  if (!shouldCreateMarket(matchId)) {
    console.log(`⏭️  Skipping ${matchId} — market created recently`);
    return false;
  }
  try {
    const signer     = await getSigner();
    const contract   = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
    const questionFn = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
    const question   = questionFn(match.home, match.away);
    const duration   = durationSeconds || (match.type === "live" ? 900 : 600);
    const typeLabel  = match.type === "demo" ? "🎮 DEMO" : match.type === "live" ? "🔴 LIVE" : "🕐 RECENT";
    console.log(`\n${match.flag} [${typeLabel}] ${match.comp}: ${match.home} vs ${match.away}`);
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

// ─── CREATE DEMO MARKETS (auto-rotating World Cup 2026 matches) ───────────────
async function createDemoMarkets() {
  console.log("🎮 No live matches — creating World Cup 2026 demo markets...");

  // Pick 2 random demo matches that haven't been created recently
  const available = DEMO_MATCHES.filter(m => shouldCreateMarket(makeMatchId(m.home, m.away)));

  if (available.length === 0) {
    console.log("   All demo matches have recent markets. Waiting for next cycle...");
    return;
  }

  // Shuffle and pick 2
  const shuffled = available.sort(() => Math.random() - 0.5).slice(0, 2);

  for (const match of shuffled) {
    await createMarketForMatch(
      { ...match, type: "demo" },
      2 * 60 * 60 // 2 hour duration for demo markets so judges have time
    );
    await new Promise(r => setTimeout(r, 3000));
  }
}

// ─── MAIN CREATE LOOP ─────────────────────────────────────────────────────────
async function createMarkets() {
  console.log("\n🤖 Fetching live match data...");

  // 1. Try live matches from both APIs
  const [rapidLive, fdLive] = await Promise.all([
    fetchLiveMatchesRapidAPI(),
    fetchLiveMatchesFootballData(),
  ]);

  let liveMatches = [];
  if (rapidLive) liveMatches = [...liveMatches, ...rapidLive.matches.map(f => normalizeRapidAPIMatch(f, "live"))];
  if (fdLive) {
    fdLive.matches.forEach(m => {
      const norm = normalizeFootballDataMatch(m, "live");
      const id   = makeMatchId(norm.home, norm.away);
      if (!liveMatches.find(x => makeMatchId(x.home, x.away) === id)) liveMatches.push(norm);
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

  // 2. Try recently completed matches
  console.log("   No live matches. Checking recently completed matches...");
  const [rapidRecent, fdRecent] = await Promise.all([
    fetchRecentMatchesRapidAPI(),
    fetchRecentMatchesFootballData(),
  ]);

  let recentMatches = [];
  if (rapidRecent) recentMatches = [...recentMatches, ...rapidRecent.matches.map(f => normalizeRapidAPIMatch(f, "recent"))];
  if (fdRecent) {
    fdRecent.matches.forEach(m => {
      const norm = normalizeFootballDataMatch(m, "recent");
      const id   = makeMatchId(norm.home, norm.away);
      if (!recentMatches.find(x => makeMatchId(x.home, x.away) === id)) recentMatches.push(norm);
    });
  }

  if (recentMatches.length > 0) {
    console.log(`🕐 ${recentMatches.length} recently completed matches — creating markets...`);
    for (const match of recentMatches.slice(0, 2)) {
      await createMarketForMatch(match);
      await new Promise(r => setTimeout(r, 3000));
    }
    return;
  }

  // 3. No real matches — use rotating demo markets
  await createDemoMarkets();
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────
let pollTimeout = null;

async function run() {
  console.log("🦁 ROAR AI Agent v7.0 starting...");
  console.log(`📍 Contract: ${CONTRACT_ADDRESS}`);
  console.log(`🌐 Target leagues: Premier League, La Liga, Bundesliga, Serie A, Ligue 1, Champions League, World Cup`);
  console.log(`⏱  Polling every 30 minutes`);
  console.log(`🎮 Auto demo markets when no live matches\n`);

  if (!RAPID_API_KEY && !FOOTBALL_API_KEY) {
    console.log("⚠️  No API keys — will use demo markets only");
  }

  await syncRecentlyCreatedFromChain();
  await settleExpiredMarkets();
  await createMarkets();

  setInterval(async () => {
    console.log("\n⏰ Scheduled update — " + new Date().toLocaleTimeString());
    await settleExpiredMarkets();
    await createMarkets();
  }, 30 * 60 * 1000);
}

run();