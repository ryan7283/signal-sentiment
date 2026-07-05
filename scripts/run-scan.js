// scripts/run-scan.js — SIGNAL v7
// X/Twitter sentiment + Quiver Quant institutional data (13F + congressional trades)
// Reads watchlist from watchlist.json
// Runs every weekday at 7am CT via GitHub Actions

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";

// ─── HELPER FUNCTIONS ────────────────────────────────────────────────────────

function getQuarterLabel() {
  const now = new Date();
  return `Q${Math.floor(now.getMonth() / 3) + 1} ${now.getFullYear()}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── LOAD WATCHLIST ───────────────────────────────────────────────────────────

function loadWatchlist() {
  try {
    const raw  = fs.readFileSync("watchlist.json", "utf8");
    const data = JSON.parse(raw);
    return data.tickers || [];
  } catch (e) {
    console.error("Failed to load watchlist.json:", e.message);
    process.exit(1);
  }
}

// ─── LOAD YESTERDAY'S RESULTS ────────────────────────────────────────────────

function loadYesterdayResults() {
  try {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const path = `data/history/${d.toISOString().slice(0, 10)}.json`;
    if (!fs.existsSync(path)) return {};
    const data = JSON.parse(fs.readFileSync(path, "utf8"));
    const map  = {};
    (data.results || []).forEach(r => { map[r.ticker] = r; });
    return map;
  } catch (e) {
    return {};
  }
}

function calcTrend(todayScore, yesterday) {
  if (!yesterday) return { sentimentDelta: 0, volumeDelta: 0, trend: "new", arrow: "→" };
  const sentimentDelta = parseFloat((todayScore - (yesterday.sentimentScore || 0)).toFixed(3));
  const trend = sentimentDelta > 0.1 ? "improving" : sentimentDelta < -0.1 ? "declining" : "stable";
  const arrow = sentimentDelta > 0.05 ? "↑" : sentimentDelta < -0.05 ? "↓" : "→";
  return { sentimentDelta, volumeDelta: 0, trend, arrow };
}

// ─── TWITTER FETCH ────────────────────────────────────────────────────────────

async function fetchTweets(ticker, query) {
  const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Quality filters:
  // - -is:retweet → original posts only
  // - lang:en     → English only
  // Note: min_faves removed — not supported on Twitter Basic tier
  const qualityFilters = `-is:retweet lang:en`;
  const fullQuery      = `(${query}) ${qualityFilters}`;
  const encodedQuery   = encodeURIComponent(fullQuery);

  const url = [
    `https://api.twitter.com/2/tweets/search/recent`,
    `?query=${encodedQuery}`,
    `&max_results=50`,
    `&start_time=${startTime}`,
    `&tweet.fields=created_at,public_metrics,author_id`,
  ].join("");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.TWITTER_BEARER_TOKEN}` },
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(`  [${ticker}] Twitter error: ${res.status} — ${errText.slice(0, 120)}`);

    // If min_faves filter causes issues (some API tiers don't support it),
    // fall back to basic quality filters only
    if (res.status === 400) {
      console.log(`  [${ticker}] Retrying without engagement filter...`);
      const fallbackQuery   = encodeURIComponent(`(${query}) -is:retweet lang:en`);
      const fallbackUrl     = [
        `https://api.twitter.com/2/tweets/search/recent`,
        `?query=${fallbackQuery}`,
        `&max_results=50`,
        `&start_time=${startTime}`,
        `&tweet.fields=created_at,public_metrics`,
      ].join("");
      const fallbackRes = await fetch(fallbackUrl, {
        headers: { Authorization: `Bearer ${process.env.TWITTER_BEARER_TOKEN}` },
      });
      if (!fallbackRes.ok) return [];
      const fallbackData = await fallbackRes.json();
      return (fallbackData.data || []).map(t => t.text);
    }
    return [];
  }

  const data = await res.json();
  return (data.data || []).map(t => t.text);
}

// ─── QUIVER QUANT INSTITUTIONAL DATA ─────────────────────────────────────────
// Requires QUIVER_QUANT_API_KEY in GitHub Secrets
// Sign up at quiverquant.com — Researcher plan ($25/mo)
// Provides: 13F institutional holdings, congressional trades, insider transactions

async function fetchInstitutionalData(ticker, type) {
  const apiKey = process.env.QUIVER_QUANT_API_KEY;
  const fmpKey = process.env.FMP_API_KEY || "demo"; // free tier — 250 calls/day

  if (type === "etf") {
    return {
      source: "N/A — ETF", available: false,
      instSentiment: "neutral", insiderSignal: "neutral",
      congressSignal: "neutral", congressNote: "N/A — ETF",
      hedgeFundSignal: "neutral", hedgeFundNote: "ETFs tracked differently",
      instNote: "ETFs do not have insider or congressional data",
      quarterCovered: getQuarterLabel(), lastUpdated: new Date().toISOString(),
    };
  }

  if (!apiKey) return buildNoKeyInstitutional();

  const quiverHeaders = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };

  // ── 1. Congressional Trading (Quiver) ─────────────────────────────────────
  let congressSignal = "neutral";
  let congressNote   = "No congressional trades found";
  let congressBuys   = 0, congressSells = 0;

  try {
    const res = await fetch(
      `https://api.quiverquant.com/beta/historical/congresstrading/${ticker}`,
      { headers: quiverHeaders }
    );
    if (res.ok) {
      const data   = await res.json();
      console.log(`  [${ticker}] Congress: ${data?.length || 0} records`);
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 365);
      const recent = (data || []).filter(t => new Date(t.TransactionDate || t.Date) > cutoff);
      const buys   = recent.filter(t => (t.Transaction || "").toLowerCase().includes("purchase"));
      const sells  = recent.filter(t => (t.Transaction || "").toLowerCase().includes("sale"));
      congressBuys = buys.length; congressSells = sells.length;
      if (buys.length > sells.length && buys.length > 0) {
        congressSignal = "bullish";
        congressNote   = `${buys.length} congressional purchase(s) vs ${sells.length} sale(s) — last 12mo`;
      } else if (sells.length > buys.length && sells.length > 0) {
        congressSignal = "bearish";
        congressNote   = `${sells.length} congressional sale(s) vs ${buys.length} purchase(s) — last 12mo`;
      } else if (recent.length > 0) {
        congressNote = `${recent.length} congressional trade(s) — mixed signal`;
      }
    } else {
      console.log(`  [${ticker}] Congress: ${res.status}`);
    }
  } catch (e) { console.log(`  [${ticker}] Congress error: ${e.message}`); }
  await sleep(350);

  // ── 2. Insider Trading (Quiver) ───────────────────────────────────────────
  let insiderSignal = "neutral";
  let insiderNote   = "No insider trades found";

  try {
    const res = await fetch(
      `https://api.quiverquant.com/beta/historical/insiders/${ticker}`,
      { headers: quiverHeaders }
    );
    if (res.ok) {
      const data   = await res.json();
      console.log(`  [${ticker}] Insiders: ${data?.length || 0} records`);
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
      const recent = (data || []).filter(t => new Date(t.Date) > cutoff);
      const buys   = recent.filter(t => t.AcquiredDisposed === "A");
      const sells  = recent.filter(t => t.AcquiredDisposed === "D");
      if (buys.length > sells.length && buys.length > 0) {
        insiderSignal = "bullish";
        insiderNote   = `${buys.length} open-market purchase(s) vs ${sells.length} sale(s) — last 90 days`;
      } else if (sells.length > buys.length && sells.length > 0) {
        insiderSignal = "bearish";
        insiderNote   = `${sells.length} open-market sale(s) vs ${buys.length} purchase(s) — last 90 days`;
      } else if (recent.length > 0) {
        insiderNote = `${recent.length} insider filing(s) — awards/options only`;
      }
    } else {
      console.log(`  [${ticker}] Insiders: ${res.status}`);
      insiderNote = `Insider data: API returned ${res.status}`;
    }
  } catch (e) { console.log(`  [${ticker}] Insiders error: ${e.message}`); }
  await sleep(350);

  // ── 3. Lobbying (Quiver) ──────────────────────────────────────────────────
  let lobbyingNote  = "No lobbying data found";
  let lobbyingTotal = 0;

  try {
    const res = await fetch(
      `https://api.quiverquant.com/beta/historical/lobbying/${ticker}`,
      { headers: quiverHeaders }
    );
    if (res.ok) {
      const data   = await res.json();
      const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 1);
      const recent = (data || []).filter(t => new Date(t.Date || t.year) > cutoff);
      if (recent.length > 0) {
        lobbyingTotal = recent.reduce((s, d) => s + (parseFloat(d.Amount) || 0), 0);
        lobbyingNote  = lobbyingTotal > 0
          ? `$${(lobbyingTotal / 1000000).toFixed(1)}M lobbying spend — last 12mo`
          : `${recent.length} lobbying record(s) — last 12mo`;
      }
      console.log(`  [${ticker}] Lobbying: ${data?.length || 0} records — ${lobbyingNote}`);
    } else {
      console.log(`  [${ticker}] Lobbying: ${res.status}`);
    }
  } catch (e) { console.log(`  [${ticker}] Lobbying error: ${e.message}`); }
  await sleep(350);

  // ── 4. Government Contracts (Quiver live feed) ────────────────────────────
  let govContractNote = "No recent government contracts";
  let hasGovContracts = false;

  try {
    const res = await fetch(
      `https://api.quiverquant.com/beta/live/governmentcontracts`,
      { headers: quiverHeaders }
    );
    if (res.ok) {
      const data    = await res.json();
      const matches = (data || []).filter(d =>
        (d.Ticker || "").toUpperCase() === ticker.toUpperCase()
      );
      console.log(`  [${ticker}] Gov contracts: ${matches.length} matches`);
      if (matches.length > 0) {
        hasGovContracts = true;
        const total = matches.reduce((s, d) => s + (parseFloat(d.Amount) || 0), 0);
        govContractNote = total > 0
          ? `${matches.length} recent gov contract(s) — $${(total / 1000000).toFixed(1)}M total`
          : `${matches.length} recent government contract(s)`;
      }
    } else {
      console.log(`  [${ticker}] Gov contracts: ${res.status}`);
    }
  } catch (e) { console.log(`  [${ticker}] Gov contracts error: ${e.message}`); }
  await sleep(350);

  // ── 5. Institutional / Hedge Fund Holdings (FMP free tier) ───────────────
  // Financial Modeling Prep — 250 free calls/day, no credit card needed
  // Sign up free at: financialmodelingprep.com/developer/docs
  // Add FMP_API_KEY to GitHub Secrets to activate (or leave blank for demo key)
  let hedgeFundSignal  = "neutral";
  let hedgeFundNote    = "No institutional data available";
  let instOwnershipPct = null;
  let instHolders      = null;
  let topHolder        = null;

  try {
    const fmpUrl = `https://financialmodelingprep.com/api/v3/institutional-holder/${ticker}?apikey=${fmpKey}`;
    const res    = await fetch(fmpUrl);
    if (res.ok) {
      const data = await res.json();
      console.log(`  [${ticker}] FMP institutional: ${data?.length || 0} holders`);
      if (data && data.length > 0 && !data.hasOwnProperty("Error Message")) {
        // Sort by shares held descending
        const sorted = data.sort((a, b) => (b.shares || 0) - (a.shares || 0));
        instHolders  = sorted.length;
        topHolder    = sorted[0]?.holder || null;

        // Calculate total institutional shares
        const totalShares = sorted.reduce((s, d) => s + (parseFloat(d.shares) || 0), 0);

        // Check if share counts changed vs prior period
        const increased = sorted.filter(d => (d.change || 0) > 0).length;
        const decreased = sorted.filter(d => (d.change || 0) < 0).length;

        if (increased > decreased && increased > 0) {
          hedgeFundSignal = "bullish";
          hedgeFundNote   = `${instHolders} institutional holders — ${increased} increasing positions vs ${decreased} decreasing. Top: ${topHolder}`;
        } else if (decreased > increased && decreased > 0) {
          hedgeFundSignal = "bearish";
          hedgeFundNote   = `${instHolders} institutional holders — ${decreased} decreasing positions vs ${increased} increasing. Top: ${topHolder}`;
        } else {
          hedgeFundNote = `${instHolders} institutional holders — stable. Top: ${topHolder || "N/A"}`;
        }
      } else if (data?.["Error Message"]) {
        console.log(`  [${ticker}] FMP: ${data["Error Message"]}`);
        hedgeFundNote = "FMP demo key limit reached — add FMP_API_KEY to GitHub Secrets";
      }
    } else {
      console.log(`  [${ticker}] FMP institutional: ${res.status}`);
    }
  } catch (e) { console.log(`  [${ticker}] FMP error: ${e.message}`); }

  // ── Composite institutional signal ─────────────────────────────────────────
  const allSignals = [congressSignal, insiderSignal, hedgeFundSignal].filter(s => s !== "neutral");
  const bulls      = allSignals.filter(s => s === "bullish").length;
  const bears      = allSignals.filter(s => s === "bearish").length;
  const instSentiment = bulls > bears ? "bullish" : bears > bulls ? "bearish" : "neutral";

  return {
    source:           "Quiver Quant + FMP",
    available:        true,
    instSentiment,
    congressSignal,   congressNote, congressBuys, congressSells,
    insiderSignal,    insiderNote,
    lobbyingNote,     lobbyingTotal,
    hasGovContracts,  govContractNote,
    hedgeFundSignal,  hedgeFundNote,
    instOwnershipPct, instHolders, topHolder,
    instNote:         "Institutional: FMP free tier (250 calls/day) — upgrade to Unusual Whales for full 13F",
    quarterCovered:   getQuarterLabel(),
    lastUpdated:      new Date().toISOString(),
  };
}


function buildETFInstitutional() {
  return {
    source:         "N/A — ETF",
    available:      false,
    instSentiment:  "neutral",
    insiderSignal:  "neutral",
    insiderNote:    "ETFs do not have insider or congressional filing data",
    congressSignal: "neutral",
    congressNote:   "N/A",
    quarterCovered: getQuarterLabel(),
    lastUpdated:    new Date().toISOString(),
  };
}

function buildNoKeyInstitutional() {
  return {
    source:         "Quiver Quant (no key)",
    available:      false,
    instSentiment:  "neutral",
    insiderSignal:  "neutral",
    insiderNote:    "Add QUIVER_QUANT_API_KEY to GitHub Secrets to activate",
    congressSignal: "neutral",
    congressNote:   "Add QUIVER_QUANT_API_KEY to GitHub Secrets to activate",
    quarterCovered: getQuarterLabel(),
    lastUpdated:    new Date().toISOString(),
  };
}

// ─── SENTIMENT ANALYSIS ───────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function analyzeSentiment(ticker, name, type, sector, tweets, yesterday) {
  if (!tweets.length) {
    const trend = calcTrend(0, yesterday);
    return {
      ticker, name, type, sector,
      sentimentScore:  0,
      signal:          "NEUTRAL",
      bullCount:       0,
      bearCount:       0,
      neutralCount:    0,
      keyThemes:       [],
      topBullish:      null,
      topBearish:      null,
      summary:         "No posts found for this ticker in the last 24 hours.",
      volumeTrend:     "silent",
      confidence:      "low",
      tweetCount:      0,
      sentimentTrend:  trend.trend,
      sentimentDelta:  0,
      volumeDelta:     0,
      arrow:           "→",
      compositeScore:  0,
      analyzedAt:      new Date().toISOString(),
    };
  }

  const tweetBlock = tweets.slice(0, 30).map((t, i) => `${i + 1}. "${t}"`).join("\n");
  const context    = type === "etf"
    ? `This is an ETF (${sector}). Focus on fund flow sentiment, sector momentum, and macro themes.`
    : `This is a stock in the ${sector} sector. Focus on company-specific sentiment, earnings, and competitive positioning.`;

  const message = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{
      role:    "user",
      content: `You are a financial sentiment analysis engine. ${context}

Analyze these ${tweets.length} recent social media posts about $${ticker} (${name}) and return ONLY valid JSON — no markdown, no preamble.

Posts:
${tweetBlock}

Return exactly:
{
  "ticker": "${ticker}",
  "name": "${name}",
  "sentimentScore": <float -1.0 to 1.0>,
  "signal": <"STRONG_BUY"|"BUY"|"NEUTRAL"|"SELL"|"STRONG_SELL">,
  "bullCount": <integer>,
  "bearCount": <integer>,
  "neutralCount": <integer>,
  "keyThemes": [<3-5 short theme strings>],
  "topBullish": <most bullish post verbatim or null>,
  "topBearish": <most bearish post verbatim or null>,
  "summary": <2-sentence analyst-quality summary>,
  "volumeTrend": <"surging"|"increasing"|"stable"|"declining"|"silent">,
  "confidence": <"high"|"medium"|"low">
}`,
    }],
  });

  const raw    = message.content.find(b => b.type === "text")?.text || "{}";
  const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  const trend  = calcTrend(parsed.sentimentScore, yesterday);
  const trendBonus = trend.sentimentDelta > 0 ? 0.1 : trend.sentimentDelta < 0 ? -0.1 : 0;
  const composite  = parseFloat(((parsed.sentimentScore * 0.6) + trendBonus).toFixed(3));

  return {
    ...parsed, type, sector,
    tweetCount:     tweets.length,
    sentimentTrend: trend.trend,
    sentimentDelta: trend.sentimentDelta,
    volumeDelta:    0,
    arrow:          trend.arrow,
    compositeScore: Math.max(-1, Math.min(1, composite)),
    analyzedAt:     new Date().toISOString(),
  };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const WATCHLIST = loadWatchlist();
  const hasQuiver = !!process.env.QUIVER_QUANT_API_KEY;

  console.log(`\n🔍 SIGNAL v7 — Daily Scan: ${new Date().toISOString()}`);
  console.log(`📋 Watchlist: ${WATCHLIST.length} tickers`);
  console.log(`🏦 Quiver Quant: ${hasQuiver ? "✓ active" : "✗ no key — add QUIVER_QUANT_API_KEY to Secrets"}\n`);

  fs.mkdirSync("data",         { recursive: true });
  fs.mkdirSync("data/history", { recursive: true });

  const yesterday = loadYesterdayResults();
  const results   = [];

  for (const { ticker, name, type, sector, query } of WATCHLIST) {
    process.stdout.write(`  ${ticker.padEnd(6)} [${(type || "stock").toUpperCase()}] — fetching...`);

    const tweets = await fetchTweets(ticker, query);
    process.stdout.write(` ${tweets.length} posts. Analyzing...`);

    const sentiment = await analyzeSentiment(
      ticker, name, type || "stock", sector || "",
      tweets, yesterday[ticker]
    );
    process.stdout.write(` ${sentiment.arrow} ${sentiment.signal}. Institutional...`);

    const institutional = await fetchInstitutionalData(ticker, type || "stock");
    const instLabel = institutional.available
      ? `inst:${institutional.instSentiment} insider:${institutional.insiderSignal} congress:${institutional.congressSignal}`
      : institutional.source;
    process.stdout.write(` ${instLabel}\n`);

    // Composite score: sentiment + trend + institutional signals
    const instBonus     = institutional.instSentiment  === "bullish" ?  0.08
                        : institutional.instSentiment  === "bearish" ? -0.08 : 0;
    const insiderBonus  = institutional.insiderSignal  === "bullish" ?  0.07
                        : institutional.insiderSignal  === "bearish" ? -0.07 : 0;
    const congressBonus = institutional.congressSignal === "bullish" ?  0.05
                        : institutional.congressSignal === "bearish" ? -0.05 : 0;

    const finalScore = parseFloat(
      Math.max(-1, Math.min(1,
        sentiment.compositeScore + instBonus + insiderBonus + congressBonus
      )).toFixed(3)
    );

    const finalSignal = finalScore >=  0.5  ? "STRONG_BUY"
                      : finalScore >=  0.15 ? "BUY"
                      : finalScore <= -0.5  ? "STRONG_SELL"
                      : finalScore <= -0.15 ? "SELL"
                      : "NEUTRAL";

    results.push({
      ...sentiment,
      institutional,
      compositeScore: finalScore,
      signal:         finalSignal,
    });

    await sleep(1200);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    tickerCount: results.length,
    version:     "7.0",
    results,
  };

  fs.writeFileSync("data/results.json", JSON.stringify(output, null, 2));
  const dateStr = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(`data/history/${dateStr}.json`, JSON.stringify(output, null, 2));

  console.log("\n📊 Summary:");
  results.forEach(r => {
    const tag  = r.type === "etf" ? "[ETF]" : "[STK]";
    const inst = r.institutional?.available
      ? `inst:${r.institutional.instSentiment} insider:${r.institutional.insiderSignal}`
      : "inst:inactive";
    console.log(`  ${tag} ${r.ticker.padEnd(6)} ${r.arrow} ${r.signal.padEnd(12)} score:${r.compositeScore.toFixed(2)}  ${inst}`);
  });
  console.log(`\n✅ Done — ${results.length} tickers processed\n`);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
