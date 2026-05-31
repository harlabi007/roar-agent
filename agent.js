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

const TARGET_LEAGUE_IDS = new Set([39,140,78,135,61,2,3,1,4,9,15,848]);
const TARGET_COMPETITION_CODES = new Set(["PL","PD","BL1","SA","FL1","CL","EL","WC","EC","CLI"]);

const DEMO_MATCHES = [
  { home:"Brazil",      away:"Argentina",   comp:"World Cup 2026", flag:"🏆" },
  { home:"England",     away:"France",      comp:"World Cup 2026", flag:"🏆" },
  { home:"Germany",     away:"Spain",       comp:"World Cup 2026", flag:"🏆" },
  { home:"Nigeria",     away:"Morocco",     comp:"World Cup 2026", flag:"🏆" },
  { home:"USA",         away:"Mexico",      comp:"World Cup 2026", flag:"🏆" },
  { home:"Portugal",    away:"Croatia",     comp:"World Cup 2026", flag:"🏆" },
  { home:"Netherlands", away:"Senegal",     comp:"World Cup 2026", flag:"🏆" },
  { home:"Japan",       away:"South Korea", comp:"World Cup 2026", flag:"🏆" },
  { home:"France",      away:"Belgium",     comp:"World Cup 2026", flag:"🏆" },
  { home:"Spain",       away:"Italy",       comp:"World Cup 2026", flag:"🏆" },
];

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
let liveMatchMode = false;
let tickTimeout = null;

// ─── DYNAMIC POLLING ──────────────────────────────────────────────────────────
// 2 minutes during live matches, 5 minutes otherwise
const LIVE_POLL_MS = 2 * 60 * 1000;
const IDLE_POLL_MS = 5 * 60 * 1000;

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
    const feeData = await provider.getFeeData();
    const minGas  = ethers.parseUnits("2", "gwei");
    const netGas  = feeData.gasPrice || minGas;
    const gasPrice = netGas > minGas ? netGas * 120n / 100n : minGas;
    return { gasPrice };
  } catch(e) {
    return { gasPrice: ethers.parseUnits("2", "gwei") };
  }
}

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
          console.log(`⚖️  Market #${market.id} settled: ${result?"YES":"NO"} — "${market.question.slice(0,50)}"`);
          settled++;
          await sleep(2000);
        } catch(e) { console.error(`❌ Settle failed #${market.id}:`, e.message); }
      }
    }
    if(settled === 0) console.log("   No markets to settle.");
    else console.log(`✅ Settled ${settled} markets.`);
  } catch(e) { console.error("❌ Error settling:", e.message); }
}

async function createMarketForMatch(match, durationSeconds){
  try {
    const { signer, provider } = await getSigner();
    const contract   = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
    const matchId    = makeMatchId(match.home, match.away);
    const questionFn = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
    const question   = questionFn(match.home, match.away);
    const duration   = durationSeconds || (match.type === "live" ? 900 : 600);
    const gas        = await getGasOverrides(provider);
    const typeLabel  = match.type === "demo" ? "🎮 DEMO" : match.type === "live" ? "🔴 LIVE" : "🕐 RECENT";

    console.log(`\n${match.flag} [${typeLabel}] ${match.comp}: ${match.home} vs ${match.away}`);
    console.log(`❓ "${question}"`);

    const tx      = await contract.createMarket(question, matchId, duration, gas);
    const receipt = await tx.wait();
    if(receipt.status === 0){ console.error(`❌ TX reverted: ${receipt.hash}`); return false; }
    console.log(`✅ Market created! TX: ${receipt.hash.slice(0,20)}...`);
    return true;
  } catch(e) { console.error(`❌ Failed:`, e.message); return false; }
}

async function fetchLiveMatchesRapidAPI(){
  if(!RAPID_API_KEY) return null;
  try {
    const res = await fetch("https://api-football-v1.p.rapidapi.com/v3/fixtures?live=all",{
      headers:{"x-rapidapi-host":"api-football-v1.p.rapidapi.com","x-rapidapi-key":RAPID_API_KEY}
    });
    if(!res.ok) return null;
    const data    = await res.json();
    const matches = (data.response||[]).filter(f=>TARGET_LEAGUE_IDS.has(f.league.id));
    if(matches.length > 0){ console.log(`📡 RapidAPI LIVE: ${matches.length} matches`); return {matches,type:"live"}; }
    return null;
  } catch(e) { console.log("   RapidAPI error:", e.message); return null; }
}

async function fetchRecentMatchesRapidAPI(){
  if(!RAPID_API_KEY) return null;
  try {
    const today = new Date().toISOString().split("T")[0];
    const res   = await fetch(`https://api-football-v1.p.rapidapi.com/v3/fixtures?date=${today}&status=FT-AET-PEN`,{
      headers:{"x-rapidapi-host":"api-football-v1.p.rapidapi.com","x-rapidapi-key":RAPID_API_KEY}
    });
    if(!res.ok) return null;
    const data    = await res.json();
    const now     = Date.now();
    const matches = (data.response||[]).filter(f=>{
      if(!TARGET_LEAGUE_IDS.has(f.league.id)) return false;
      return now - (new Date(f.fixture.date).getTime() + 105*60*1000) < 3*60*60*1000;
    });
    if(matches.length > 0){ console.log(`📡 RapidAPI RECENT: ${matches.length} matches`); return {matches,type:"recent"}; }
    return null;
  } catch(e) { return null; }
}

async function fetchLiveMatchesFootballData(){
  if(!FOOTBALL_API_KEY) return null;
  try {
    const res = await fetch("https://api.football-data.org/v4/matches?status=IN_PLAY,PAUSED",{headers:{"X-Auth-Token":FOOTBALL_API_KEY}});
    if(!res.ok) return null;
    const data    = await res.json();
    const matches = (data.matches||[]).filter(m=>TARGET_COMPETITION_CODES.has(m.competition.code));
    if(matches.length > 0){ console.log(`📡 football-data.org LIVE: ${matches.length} matches`); return {matches,type:"live"}; }
    return null;
  } catch(e) { return null; }
}

async function fetchRecentMatchesFootballData(){
  if(!FOOTBALL_API_KEY) return null;
  try {
    const today = new Date().toISOString().split("T")[0];
    const res   = await fetch(`https://api.football-data.org/v4/matches?status=FINISHED&dateFrom=${today}&dateTo=${today}`,{headers:{"X-Auth-Token":FOOTBALL_API_KEY}});
    if(!res.ok) return null;
    const data    = await res.json();
    const now     = Date.now();
    const matches = (data.matches||[]).filter(m=>{
      if(!TARGET_COMPETITION_CODES.has(m.competition.code)) return false;
      return now - new Date(m.utcDate).getTime() < 3*60*60*1000 + 105*60*1000;
    });
    if(matches.length > 0){ console.log(`📡 football-data.org RECENT: ${matches.length} matches`); return {matches,type:"recent"}; }
    return null;
  } catch(e) { return null; }
}

function normalizeRapidAPIMatch(f, type){
  const flags = {39:"🏴󠁧󠁢󠁥󠁮󠁧󠁿",140:"🇪🇸",78:"🇩🇪",135:"🇮🇹",61:"🇫🇷",2:"⭐",1:"🏆",4:"🇪🇺"};
  return { home:f.teams.home.name, away:f.teams.away.name, comp:f.league.name, flag:flags[f.league.id]||"⚽", type };
}

function normalizeFootballDataMatch(m, type){
  const flags = {PL:"🏴󠁧󠁢󠁥󠁮󠁧󠁿",PD:"🇪🇸",BL1:"🇩🇪",SA:"🇮🇹",FL1:"🇫🇷",CL:"⭐",WC:"🏆",EC:"🇪🇺"};
  return { home:m.homeTeam.shortName||m.homeTeam.name, away:m.awayTeam.shortName||m.awayTeam.name, comp:m.competition.name, flag:flags[m.competition.code]||"⚽", type };
}

const MIN_OPEN_MARKETS  = 3;
const DEMO_DURATION     = 4 * 60 * 60;

async function ensureDemoMarkets(){
  console.log("🎮 Checking demo market coverage...");
  const openMarkets  = await getOpenMarketsFromChain();
  const openMatchIds = new Set(openMarkets.map(m => m.matchId));
  console.log(`   ${openMarkets.length} open markets on chain (minimum: ${MIN_OPEN_MARKETS})`);
  if(openMarkets.length >= MIN_OPEN_MARKETS){ console.log("   ✅ Enough open markets"); return; }
  const needed    = MIN_OPEN_MARKETS - openMarkets.length;
  const available = DEMO_MATCHES.filter(m => !openMatchIds.has(makeMatchId(m.home, m.away)));
  const picks     = (available.length > 0 ? available : DEMO_MATCHES).sort(()=>Math.random()-0.5).slice(0, needed);
  console.log(`   Creating ${picks.length} demo markets...`);
  for(const match of picks){ await createMarketForMatch({...match,type:"demo"}, DEMO_DURATION); await sleep(3000); }
}

// ─── MAIN CREATE LOOP — returns true if live matches were found ───────────────
async function createMarkets(){
  console.log("\n🤖 Fetching live match data...");

  const [rapidLive, fdLive] = await Promise.all([fetchLiveMatchesRapidAPI(), fetchLiveMatchesFootballData()]);
  let liveMatches = [];
  if(rapidLive) liveMatches = [...liveMatches, ...rapidLive.matches.map(f=>normalizeRapidAPIMatch(f,"live"))];
  if(fdLive){ fdLive.matches.forEach(m=>{ const n=normalizeFootballDataMatch(m,"live"); if(!liveMatches.find(x=>makeMatchId(x.home,x.away)===makeMatchId(n.home,n.away))) liveMatches.push(n); }); }

  if(liveMatches.length > 0){
    console.log(`⚽ ${liveMatches.length} LIVE matches — creating markets every 2 minutes!`);
    for(const match of liveMatches.slice(0,3)){ await createMarketForMatch(match); await sleep(3000); }
    return true; // 🔴 LIVE — signal to use fast polling
  }

  console.log("   No live matches. Checking recently completed...");
  const [rapidRecent, fdRecent] = await Promise.all([fetchRecentMatchesRapidAPI(), fetchRecentMatchesFootballData()]);
  let recentMatches = [];
  if(rapidRecent) recentMatches = [...recentMatches, ...rapidRecent.matches.map(f=>normalizeRapidAPIMatch(f,"recent"))];
  if(fdRecent){ fdRecent.matches.forEach(m=>{ const n=normalizeFootballDataMatch(m,"recent"); if(!recentMatches.find(x=>makeMatchId(x.home,x.away)===makeMatchId(n.home,n.away))) recentMatches.push(n); }); }

  if(recentMatches.length > 0){
    console.log(`🕐 ${recentMatches.length} recent matches — creating markets...`);
    for(const match of recentMatches.slice(0,2)){ await createMarketForMatch(match); await sleep(3000); }
    return false;
  }

  await ensureDemoMarkets();
  return false;
}

// ─── DYNAMIC TICK — adjusts poll rate based on live match status ──────────────
async function tick(){
  console.log("\n⏰ Update — " + new Date().toLocaleTimeString());
  await settleExpiredMarkets();
  const hasLive = await createMarkets();

  // Switch mode and log if changed
  if(hasLive !== liveMatchMode){
    liveMatchMode = hasLive;
    if(hasLive){
      console.log("\n🔴 LIVE MATCH MODE — polling every 2 minutes for fast market creation!");
    } else {
      console.log("\n💤 IDLE MODE — polling every 5 minutes");
    }
  }

  const nextMs = hasLive ? LIVE_POLL_MS : IDLE_POLL_MS;
  console.log(`⏳ Next update in ${nextMs/60000} minute(s)...`);
  tickTimeout = setTimeout(tick, nextMs);
}

async function run(){
  console.log("🦁 ROAR AI Agent v8.1 starting...");
  console.log(`📍 Contract: ${CONTRACT_ADDRESS}`);
  console.log(`⚡ DYNAMIC POLLING: 2 min during live matches, 5 min idle`);
  console.log(`🎮 Keeps minimum ${MIN_OPEN_MARKETS} demo markets open at all times`);
  console.log(`⏳ Demo market duration: 4 hours\n`);

  await settleExpiredMarkets();
  await createMarkets();

  const nextMs = liveMatchMode ? LIVE_POLL_MS : IDLE_POLL_MS;
  tickTimeout = setTimeout(tick, nextMs);
}

run();