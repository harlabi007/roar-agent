const { ethers } = require("ethers");
require("dotenv").config();

const CONTRACT_ADDRESS = "0x0495542b784eE53E574C539908B09C534b837A76";
const ABI = [
  "function createMarket(string question, string matchId, uint256 duration) returns (uint256)",
  "function settleMarket(uint256 marketId, bool result)",
  "function getAllMarkets() view returns (tuple(uint256 id, string question, string matchId, uint256 closesAt, uint256 totalYes, uint256 totalNo, uint8 outcome, bool settled)[])",
];

const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY || "";

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
    return { gasPrice, gasLimit: 500000n };
  } catch(e) {
    return { gasPrice: ethers.parseUnits("2", "gwei"), gasLimit: 500000n };
  }
}

// ─── CHECK WALLET BALANCE ─────────────────────────────────────────────────────
async function checkWalletBalance(){
  try {
    const { signer, provider } = await getSigner();
    const balance = await provider.getBalance(signer.address);
    const balanceEth = parseFloat(ethers.formatEther(balance));
    console.log(`💰 Agent wallet: ${signer.address}`);
    console.log(`💰 Balance: ${balanceEth.toFixed(4)} OKB`);
    if(balanceEth < 0.01){
      console.error(`❌ CRITICAL: Wallet balance too low! Get testnet OKB from faucet: https://www.okx.com/xlayer/faucet`);
      return false;
    }
    return true;
  } catch(e) {
    console.error("❌ Could not check balance:", e.message);
    return false;
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

// ─── CREATE MARKET ────────────────────────────────────────────────────────────
async function createMarketForMatch(match, durationSeconds){
  try {
    const { signer, provider } = await getSigner();
    const contract  = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
    const matchId   = makeMatchId(match.home, match.away);
    const duration  = durationSeconds || 900;
    const gas       = await getGasOverrides(provider);
    const typeLabel = match.type === "live" ? "🔴 LIVE" : "🕐 UPCOMING";

    // Skip if already open
    const openMarkets  = await getOpenMarketsFromChain();
    const alreadyOpen  = openMarkets.find(m => m.matchId === matchId);
    if(alreadyOpen){
      console.log(`⏭  Skipping ${match.home} vs ${match.away} — already on chain`);
      return true;
    }

    // Pick question
    const questionFn = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
    const question   = questionFn(match.home, match.away);

    console.log(`\n${match.flag} [${typeLabel}] ${match.comp}: ${match.home} vs ${match.away}`);
    console.log(`❓ "${question}"`);

    const tx      = await contract.createMarket(question, matchId, duration, gas);
    const receipt = await tx.wait();
    if(receipt.status === 0){ console.error(`❌ TX reverted`); return false; }
    console.log(`✅ Market created! TX: ${receipt.hash.slice(0,20)}...`);
    return true;
  } catch(e){
    console.error(`❌ Failed to create market:`, e.message);
    if(e.message.includes('insufficient funds')){
      console.error(`💸 Out of OKB! Get testnet tokens: https://www.okx.com/xlayer/faucet`);
    }
    return false;
  }
}

// ─── FREE API: football-data.org ──────────────────────────────────────────────
async function fetchLiveMatchesFootballData(){
  if(!FOOTBALL_API_KEY){ console.log("   No FOOTBALL_API_KEY set"); return []; }
  try {
    const res = await fetch("https://api.football-data.org/v4/matches?status=IN_PLAY,PAUSED", {
      headers:{"X-Auth-Token": FOOTBALL_API_KEY}
    });
    if(!res.ok){ console.log("   football-data.org error:", res.status); return []; }
    const data    = await res.json();
    const matches = data.matches || [];
    console.log(`   football-data.org LIVE: ${matches.length} matches`);
    return matches.map(m => ({
      home: m.homeTeam.shortName || m.homeTeam.name,
      away: m.awayTeam.shortName || m.awayTeam.name,
      comp: m.competition.name,
      flag: getLeagueFlag(m.competition.code),
      type: "live"
    }));
  } catch(e){ console.log("   football-data.org error:", e.message); return []; }
}

async function fetchUpcomingMatchesFootballData(){
  if(!FOOTBALL_API_KEY) return [];
  try {
    const today    = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const dateFrom = today.toISOString().split("T")[0];
    const dateTo   = tomorrow.toISOString().split("T")[0];

    const res = await fetch(`https://api.football-data.org/v4/matches?status=SCHEDULED&dateFrom=${dateFrom}&dateTo=${dateTo}`, {
      headers:{"X-Auth-Token": FOOTBALL_API_KEY}
    });
    if(!res.ok) return [];
    const data    = await res.json();
    const matches = data.matches || [];
    console.log(`   football-data.org UPCOMING (today+tomorrow): ${matches.length} matches`);
    return matches.slice(0, 10).map(m => ({
      home: m.homeTeam.shortName || m.homeTeam.name,
      away: m.awayTeam.shortName || m.awayTeam.name,
      comp: m.competition.name,
      flag: getLeagueFlag(m.competition.code),
      type: "upcoming",
      kickoff: m.utcDate
    }));
  } catch(e){ console.log("   upcoming error:", e.message); return []; }
}

// ─── FREE API: TheSportsDB ────────────────────────────────────────────────────
async function fetchLiveMatchesSportsDB(){
  try {
    // Try multiple free endpoints
    const urls = [
      "https://www.thesportsdb.com/api/v1/json/3/eventslive.php",
      "https://www.thesportsdb.com/api/v1/json/3/latestsoccer.php",
    ];
    for(const url of urls){
      try {
        const res  = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if(!res.ok) continue;
        const data = await res.json();
        const events = (data.events || data.sports || []).filter(e =>
          (e.strSport||'').toLowerCase().includes('soccer') ||
          (e.strSport||'').toLowerCase().includes('football')
        );
        if(events.length > 0){
          console.log(`   TheSportsDB live: ${events.length} matches`);
          return events.map(e => ({
            home: e.strHomeTeam,
            away: e.strAwayTeam,
            comp: e.strLeague || "Football",
            flag: "⚽",
            type: "live"
          }));
        }
      } catch(e){}
    }
    return [];
  } catch(e){ return []; }
}

function getLeagueFlag(code){
  const flags = {PL:"🏴󠁧󠁢󠁥󠁮󠁧󠁿",PD:"🇪🇸",BL1:"🇩🇪",SA:"🇮🇹",FL1:"🇫🇷",CL:"⭐",EL:"🟠",WC:"🏆",EC:"🇪🇺",CLI:"🌎"};
  return flags[code] || "⚽";
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────
async function createMarkets(){
  console.log("\n🤖 Fetching live match data...");

  // Check balance first
  const hasBalance = await checkWalletBalance();
  if(!hasBalance) return;

  // Fetch live matches from all sources in parallel
  const [fdLive, sportsDbLive] = await Promise.all([
    fetchLiveMatchesFootballData(),
    fetchLiveMatchesSportsDB(),
  ]);

  // Merge and deduplicate
  let liveMatches = [...fdLive];
  for(const m of sportsDbLive){
    if(!liveMatches.find(x => makeMatchId(x.home,x.away) === makeMatchId(m.home,m.away))){
      liveMatches.push(m);
    }
  }

  if(liveMatches.length > 0){
    console.log(`⚽ ${liveMatches.length} LIVE matches — creating markets...`);
    for(const match of liveMatches){
      await createMarketForMatch(match, 900);
      await sleep(3000);
    }
  } else {
    console.log("   No live matches right now.");
  }

  // Always also fetch upcoming matches for next 24h
  console.log("\n📅 Fetching upcoming fixtures...");
  const upcoming = await fetchUpcomingMatchesFootballData();
  if(upcoming.length > 0){
    console.log(`📅 ${upcoming.length} upcoming matches — creating preview markets...`);
    for(const match of upcoming){
      await createMarketForMatch(match, 24 * 60 * 60); // 24h duration for upcoming
      await sleep(3000);
    }
  } else {
    console.log("   No upcoming matches found.");
  }
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────
async function run(){
  console.log("🦁 ROAR AI Agent v10.0 starting...");
  console.log(`📍 Contract: ${CONTRACT_ADDRESS}`);
  console.log(`⏱  Polling every 2 minutes`);
  console.log(`📡 APIs: football-data.org + TheSportsDB (free)`);
  console.log(`📅 Shows live matches + upcoming fixtures\n`);

  await settleExpiredMarkets();
  await createMarkets();

  setInterval(async () => {
    console.log("\n⏰ Update — " + new Date().toLocaleTimeString());
    await settleExpiredMarkets();
    await createMarkets();
  }, POLL_MS);
}

run();