const { ethers } = require("ethers");
require("dotenv").config();

const CONTRACT_ADDRESS = "0x0495542b784eE53E574C539908B09C534b837A76";
const ABI = [
  "function createMarket(string question, string matchId, uint256 duration) returns (uint256)",
  "function settleMarket(uint256 marketId, bool result)",
  "function getAllMarkets() view returns (tuple(uint256 id, string question, string matchId, uint256 closesAt, uint256 totalYes, uint256 totalNo, uint8 outcome, bool settled)[])",
];

// Demo markets removed — real matches only

const QUESTIONS = [
  (h,a)=>`Will ${h} score in the next 15 minutes?`,
  (h,a)=>`Will ${a} score in the next 15 minutes?`,
  (h,a)=>`Will there be a yellow card in the next 15 minutes?`,
  (h,a)=>`Will there be a VAR review in the next 15 minutes?`,
  (h,a)=>`Will ${h} win the next corner kick?`,
  (h,a)=>`Will there be a goal in the next 15 minutes?`,
  (h,a)=>`Will ${a} have a shot on target next?`,
  (h,a)=>`Will the next goal be a header?`,
  (h,a)=>`Will there be a substitution in the next 15 minutes?`,
  (h,a)=>`Will ${h} maintain possession above 55% next 15 min?`,
];

const sleep = ms => new Promise(r => setTimeout(r, ms));


const POLL_MS = 2 * 60 * 1000;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function getSigner(){
  const provider = new ethers.JsonRpcProvider("https://testrpc.xlayer.tech");
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  return { signer: wallet, provider };
}

function makeMatchId(home, away){
  return `${home.replace(/\s+/g,"")}_vs_${away.replace(/\s+/g,"")}`;
}

function resolveMarketOutcome(market){
  let hash = 0;
  const str = String(market.id) + market.question;
  for(let i = 0; i < str.length; i++) hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  return Math.abs(hash) % 10 < 6;
}

async function getGasOverrides(provider){
  try {
    const feeData  = await provider.getFeeData();
    const minGas   = ethers.parseUnits("2", "gwei");
    const netGas   = feeData.gasPrice || minGas;
    const gasPrice = netGas > minGas ? netGas * 120n / 100n : minGas;
    return { gasPrice };
  } catch(e) {
    return { gasPrice: ethers.parseUnits("2", "gwei") };
  }
}

// ─── GET OPEN MARKETS ─────────────────────────────────────────────────────────
async function getOpenMarketsFromChain(){
  try {
    const { signer } = await getSigner();
    const contract   = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
    const markets    = await contract.getAllMarkets();
    const now        = Math.floor(Date.now() / 1000);
    return markets.filter(m => !m.settled && Number(m.closesAt) > now);
  } catch(e) {
    console.error("⚠️  Could not fetch open markets:", e.message);
    return [];
  }
}

// ─── SETTLE EXPIRED MARKETS ───────────────────────────────────────────────────
async function settleExpiredMarkets(){
  try {
    const { signer, provider } = await getSigner();
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
    const markets  = await contract.getAllMarkets();
    const now      = Math.floor(Date.now() / 1000);
    const gas      = await getGasOverrides(provider);
    let settled    = 0;
    for(const market of markets){
      if(!market.settled && Number(market.closesAt) < now){
        const result = resolveMarketOutcome(market);
        try {
          const tx = await contract.settleMarket(market.id, result, gas);
          await tx.wait();
          console.log(`⚖️  Settled #${market.id}: ${result?"YES":"NO"} — "${market.question.slice(0,50)}"`);
          settled++;
          await sleep(2000);
        } catch(e){ console.error(`❌ Settle failed #${market.id}:`, e.message); }
      }
    }
    if(settled === 0) console.log("   No markets to settle.");
    else console.log(`✅ Settled ${settled} markets.`);
  } catch(e){ console.error("❌ Error settling:", e.message); }
}

// ─── CREATE A MARKET ──────────────────────────────────────────────────────────
// ─── POLYMARKET API — free, no key needed ────────────────────────────────────
async function fetchPolymarketSportsQuestions(){
  try {
    const res = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100', {
      headers: { 'User-Agent': 'ROAR-Agent/1.0' }
    });
    if(!res.ok){ console.log('   Polymarket API error:', res.status); return []; }
    const markets = await res.json();
    const all = Array.isArray(markets) ? markets : (markets.markets || []);
    const football = all.filter(m => {
      const q = (m.question || m.title || '').toLowerCase();
      return q.includes('goal') || q.includes('score') || q.includes('win') ||
             q.includes('match') || q.includes('soccer') || q.includes('football') ||
             q.includes('premier league') || q.includes('world cup') ||
             q.includes('champions league') || q.includes('la liga') ||
             q.includes('bundesliga') || q.includes('serie a');
    });
    console.log(`   Polymarket football questions found: ${football.length}`);
    return football.map(m => ({
      question: m.question || m.title,
      yesPrice: (() => { try{ return parseFloat(JSON.parse(m.outcomePrices||'[0.5]')[0]); }catch(e){ return 0.5; } })(),
    })).filter(m => m.question);
  } catch(e) { console.log('   Polymarket error:', e.message); return []; }
}

// Cache Polymarket questions so we don't fetch every time
let polymarketQuestionsCache = [];
let lastPolymarketFetch = 0;

async function getPolymarketQuestions(){
  // Refresh cache every 30 minutes
  if(Date.now() - lastPolymarketFetch > 30*60*1000 || polymarketQuestionsCache.length === 0){
    polymarketQuestionsCache = await fetchPolymarketSportsQuestions();
    lastPolymarketFetch = Date.now();
  }
  return polymarketQuestionsCache;
}

async function createMarketForMatch(match, durationSeconds){
  try {
    const { signer, provider } = await getSigner();
    const contract  = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
    const matchId   = makeMatchId(match.home, match.away);
    const duration  = durationSeconds || 900;
    const gas       = await getGasOverrides(provider);
    const typeLabel = match.type === "demo" ? "🎮 DEMO" : match.type === "live" ? "🔴 LIVE" : "🕐 RECENT";

    // Try to get a relevant question from Polymarket first
    let question = null;
    const polyQuestions = await getPolymarketQuestions();
    const relevant = polyQuestions.filter(q => {
      const ql = q.question.toLowerCase();
      return ql.includes(match.home.toLowerCase()) ||
             ql.includes(match.away.toLowerCase()) ||
             ql.includes(match.comp.toLowerCase().split(' ')[0]);
    });

    if(relevant.length > 0){
      // Use a real Polymarket question
      const pick = relevant[Math.floor(Math.random() * relevant.length)];
      question = pick.question;
      console.log(`🎯 Using Polymarket question (YES: ${Math.round(pick.yesPrice*100)}%)`);
    } else {
      // Fall back to our template questions
      const questionFn = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
      question = questionFn(match.home, match.away);
    }

    // Check if market for this matchId already exists and is open
    const openMarkets = await getOpenMarketsFromChain();
    const alreadyExists = openMarkets.find(m => m.matchId === matchId);
    if(alreadyExists){
      console.log(`⏭  Skipping ${matchId} — market already open on chain`);
      return true;
    }

    console.log(`\n${match.flag} [${typeLabel}] ${match.comp}: ${match.home} vs ${match.away}`);
    console.log(`❓ "${question}"`);

    const tx      = await contract.createMarket(question, matchId, duration, gas);
    const receipt = await tx.wait();
    if(receipt.status === 0){ console.error(`❌ TX reverted`); return false; }
    console.log(`✅ Market created! TX: ${receipt.hash.slice(0,20)}...`);
    return true;
  } catch(e){ console.error(`❌ Failed:`, e.message); return false; }
}

// ─── FREE API 1: TheSportsDB (no key needed) ──────────────────────────────────
async function fetchLiveMatchesSportsDB(){
  try {
    const res  = await fetch("https://www.thesportsdb.com/api/v1/json/3/eventslive.php");
    const data = await res.json();
    const events = data?.events || [];
    console.log(`   TheSportsDB live events: ${events.length}`);

    // Filter football/soccer only
    const football = events.filter(e =>
      e.strSport === "Soccer" || e.strSport === "Football"
    );
    console.log(`   Football events: ${football.length}`);

    if(football.length > 0){
      return football.map(e => ({
        home: e.strHomeTeam,
        away: e.strAwayTeam,
        comp: e.strLeague || "Football",
        flag: "⚽",
        type: "live"
      }));
    }
    return [];
  } catch(e){ console.log("   TheSportsDB error:", e.message); return []; }
}

// ─── FREE API 2: TheSportsDB today's events ───────────────────────────────────
async function fetchTodayMatchesSportsDB(){
  try {
    const today = new Date().toISOString().split("T")[0];
    // Search for soccer events today across major leagues
    const leagueIds = ["4328","4335","4331","4332","4334","4399","4480"]; // EPL, La Liga, Bundesliga, Serie A, Ligue1, CL, WC
    let allMatches = [];

    for(const lid of leagueIds){
      try {
        const res  = await fetch(`https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=${today}&l=${lid}`);
        const data = await res.json();
        const events = data?.events || [];
        const live = events.filter(e =>
          e.strStatus === "Match Finished" ||
          e.strStatus === "In Progress" ||
          e.strStatus === "HT" ||
          e.intHomeScore !== null
        );
        if(live.length > 0){
          allMatches = [...allMatches, ...live.map(e => ({
            home: e.strHomeTeam,
            away: e.strAwayTeam,
            comp: e.strLeague || "Football",
            flag: lid === "4399" ? "⭐" : lid === "4480" ? "🏆" : "⚽",
            type: "live"
          }))];
        }
        await sleep(500); // be polite to free API
      } catch(e){}
    }

    console.log(`   TheSportsDB today matches: ${allMatches.length}`);
    return allMatches;
  } catch(e){ console.log("   TheSportsDB today error:", e.message); return []; }
}

// ─── FREE API 3: football-data.org (free key from env) ───────────────────────
async function fetchLiveMatchesFootballData(){
  const key = process.env.FOOTBALL_API_KEY;
  if(!key) return [];
  try {
    const res = await fetch("https://api.football-data.org/v4/matches?status=IN_PLAY,PAUSED", {
      headers:{"X-Auth-Token": key}
    });
    if(!res.ok){ console.log("   football-data.org error:", res.status); return []; }
    const data    = await res.json();
    const matches = data.matches || [];
    console.log(`   football-data.org live: ${matches.length}`);
    return matches.map(m => ({
      home: m.homeTeam.shortName || m.homeTeam.name,
      away: m.awayTeam.shortName || m.awayTeam.name,
      comp: m.competition.name,
      flag: m.competition.code === "WC" ? "🏆" : m.competition.code === "CL" ? "⭐" : "⚽",
      type: "live"
    }));
  } catch(e){ console.log("   football-data.org error:", e.message); return []; }
}

// ─── NO DEMO MARKETS — real matches only ─────────────────────────────────────
async function ensureDemoMarkets(){
  console.log("   ⏸  No live matches right now — waiting for real matches...");
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────
async function createMarkets(){
  console.log("\n🤖 Fetching live match data...");

  // Try all free APIs in parallel
  const [sportsDbLive, footballDataLive] = await Promise.all([
    fetchLiveMatchesSportsDB(),
    fetchLiveMatchesFootballData(),
  ]);

  // Merge and deduplicate
  let liveMatches = [...sportsDbLive];
  for(const m of footballDataLive){
    if(!liveMatches.find(x => makeMatchId(x.home,x.away) === makeMatchId(m.home,m.away))){
      liveMatches.push(m);
    }
  }

  if(liveMatches.length > 0){
    console.log(`⚽ ${liveMatches.length} live matches found! Creating markets...`);
    for(const match of liveMatches){
      await createMarketForMatch(match, 900); // 15 min markets for live matches
      await sleep(3000);
    }
    return;
  }

  // No live matches — try today's matches
  console.log("   No live matches. Checking today's matches...");
  const todayMatches = await fetchTodayMatchesSportsDB();
  if(todayMatches.length > 0){
    console.log(`🕐 ${todayMatches.length} today's matches — creating markets...`);
    for(const match of todayMatches){
      await createMarketForMatch(match, 3600);
      await sleep(3000);
    }
    return;
  }

  // Fallback to demo markets
  await ensureDemoMarkets();
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────
async function run(){
  console.log("🦁 ROAR AI Agent v9.0 starting...");
  console.log(`📍 Contract: ${CONTRACT_ADDRESS}`);
  console.log(`⛽  Gas: auto-estimated`);
  console.log(`⏱  Polling every 2 minutes`);
  console.log(`📡 APIs: TheSportsDB (free) + football-data.org`);
  console.log(`🎮 No demo markets — real live matches only\n`);

  await settleExpiredMarkets();
  await createMarkets();

  setInterval(async () => {
    console.log("\n⏰ Update — " + new Date().toLocaleTimeString());
    await settleExpiredMarkets();
    await createMarkets();
  }, POLL_MS);
}

run();