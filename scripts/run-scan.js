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

// ─── TWEET QUALITY FILTER ─────────────────────────────────────────────────────
// Runs BEFORE AI analysis to remove spam, bots, and irrelevant posts
// This ensures Claude only scores genuine financial sentiment

function cleanTweets(tweets, ticker) {
  const original = tweets.length;

  // Patterns that indicate spam or non-financial content
  const spamPatterns = [
    /whatsapp\.com/i,
    /wa\.me\//i,
    /chat\.whatsapp/i,
    /join.*group/i,
    /dm.*signal/i,
    /signal.*group/i,
    /guaranteed.*profit/i,
    /100x/i,
    /get rich/i,
    /investment group/i,
    /forex.*profit/i,
    /crypto.*recovery/i,
    /recover.*lost.*fund/i,
    /binary.*option/i,
    /pump.*dump/i,
    /t\.me\//i,            // Telegram links
    /bit\.ly\//i,          // Generic shortlinks in spam context
  ];

  // Words that suggest the post has no financial relevance
  // Only applied when the cashtag isn't present
  const hasCashTag = (text) => {
    const t = ticker.toUpperCase();
    return text.includes(`$${t}`) || text.includes(`#${t}`);
  };

  const filtered = tweets.filter(text => {
    // Remove very short posts (no substance)
    if (text.trim().length < 20) return false;

    // Remove posts matching spam patterns
    if (spamPatterns.some(p => p.test(text))) return false;

    // Remove posts that are purely @mentions with no content
    if (/^(@\w+\s*){3,}$/.test(text.trim())) return false;

    return true;
  });

  const removed = original - filtered.length;
  if (removed > 0) {
    console.log(`  [${ticker}] Quality filter: removed ${removed}/${original} spam/low-quality posts. ${filtered.length} genuine posts remaining.`);
  }

  return filtered;
}

// ─── QUIVER QUANT INSTITUTIONAL DATA ─────────────────────────────────────────
// Requires QUIVER_QUANT_API_KEY in GitHub Secrets
// Sign up at quiverquant.com — Researcher plan ($25/mo)
// Provides: 13F institutional holdings, congressional trades, insider transactions

async function fetchInstitutionalData(ticker, type) {
  const apiKey = process.env.QUIVER_QUANT_API_KEY;

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

  // CONFIRMED AUTH: Quiver uses "Token <key>" not "Bearer <key>"
  const headers = {
    Accept: "application/json",
    Authorization: `Token ${apiKey}`,
  };

  // ── 1. Congressional Trading ──────────────────────────────────────────────
  // Endpoint: /beta/historical/congresstrading/{ticker}
  let congressSignal = "neutral";
  let congressNote   = "No congressional trades found";
  let congressBuys = 0, congressSells = 0;

  try {
    const res = await fetch(
      `https://api.quiverquant.com/beta/historical/congresstrading/${ticker}`,
      { headers }
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
  await sleep(400);

  // ── 2. Insider Trading ────────────────────────────────────────────────────
  // Endpoint: /beta/live/insiders?ticker={ticker}  (NOT /historical/insiders/{ticker})
  let insiderSignal = "neutral";
  let insiderNote   = "No recent insider trades found";

  try {
    const res = await fetch(
      `https://api.quiverquant.com/beta/live/insiders?ticker=${ticker}`,
      { headers }
    );
    if (res.ok) {
      const data   = await res.json();
      console.log(`  [${ticker}] Insiders: ${data?.length || 0} records`);
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 180);
      const recent = (data || []).filter(t => new Date(t.Date) > cutoff);
      // A = acquired (open-market buy), D = disposed (open-market sell)
      const buys   = recent.filter(t => t.AcquiredDisposed === "A");
      const sells  = recent.filter(t => t.AcquiredDisposed === "D");
      if (buys.length > sells.length && buys.length > 0) {
        insiderSignal = "bullish";
        insiderNote   = `${buys.length} open-market purchase(s) vs ${sells.length} sale(s) — last 90 days`;
      } else if (sells.length > buys.length && sells.length > 0) {
        insiderSignal = "bearish";
        insiderNote   = `${sells.length} open-market sale(s) vs ${buys.length} purchase(s) — last 90 days`;
      } else if (recent.length > 0) {
        insiderNote = `${recent.length} insider filing(s) — awards/options, no open-market trades`;
      }
    } else {
      console.log(`  [${ticker}] Insiders: ${res.status}`);
    }
  } catch (e) { console.log(`  [${ticker}] Insiders error: ${e.message}`); }
  await sleep(400);

  // ── 3. Hedge Fund 13F Activity ────────────────────────────────────────────
  // Endpoint: /beta/live/sec13fchanges?ticker={ticker}
  // Returns quarterly changes in institutional positions from 13F filings
  let hedgeFundSignal  = "neutral";
  let hedgeFundNote    = "No hedge fund activity found";
  let hedgeFundBuys    = 0;
  let hedgeFundSells   = 0;
  let topHedgeFund     = null;

  try {
    const res = await fetch(
      `https://api.quiverquant.com/beta/live/sec13fchanges?ticker=${ticker}`,
      { headers }
    );
    if (res.ok) {
      const data = await res.json();
      console.log(`  [${ticker}] HedgeFunds 13F: ${data?.length || 0} records`);
      if (data && data.length > 0) {
        // Each record has: Owner, Shares, Change, ReportPeriod, Date
        // Positive Change = buying, Negative Change = selling
        // Get most recent quarter only (not all history)
        const allDates = [...new Set(data.map(d => d.Date || d.ReportPeriod))].sort().reverse();
        const latestDate = allDates[0];
        const recent = data.filter(d => (d.Date || d.ReportPeriod) === latestDate);
        const buyers = recent.filter(d => (parseFloat(d.Change) || 0) > 0);
        const sellers = recent.filter(d => (parseFloat(d.Change) || 0) < 0);
        hedgeFundBuys  = buyers.length;
        hedgeFundSells = sellers.length;
        topHedgeFund   = buyers.length > 0 ? (buyers.sort((a,b) => (parseFloat(b.Change)||0)-(parseFloat(a.Change)||0))[0]?.Owner || null) : (recent[0]?.Owner || null);
        console.log(`  [${ticker}] HedgeFunds most recent quarter: ${latestDate} — ${buyers.length} buying, ${sellers.length} selling`);

        if (buyers.length > sellers.length && buyers.length > 0) {
          hedgeFundSignal = "bullish";
          hedgeFundNote   = `${buyers.length} fund(s) increasing positions vs ${sellers.length} decreasing — last 2 qtrs. Top: ${topHedgeFund || "N/A"}`;
        } else if (sellers.length > buyers.length && sellers.length > 0) {
          hedgeFundSignal = "bearish";
          hedgeFundNote   = `${sellers.length} fund(s) decreasing positions vs ${buyers.length} increasing — last 2 qtrs. Top: ${topHedgeFund || "N/A"}`;
        } else if (recent.length > 0) {
          hedgeFundNote = `${recent.length} 13F record(s) — neutral positioning. Top holder: ${topHedgeFund || "N/A"}`;
        }
      }
    } else {
      console.log(`  [${ticker}] HedgeFunds 13F: ${res.status}`);
    }
  } catch (e) { console.log(`  [${ticker}] HedgeFunds error: ${e.message}`); }
  await sleep(400);

  // ── 4. Government Contracts ───────────────────────────────────────────────
  // Endpoint: /beta/historical/govcontractsall/{ticker}
  let govContractNote  = "No government contracts found";
  let govContractTotal = 0;
  let hasGovContracts  = false;

  try {
    const res = await fetch(
      `https://api.quiverquant.com/beta/historical/govcontractsall/${ticker}`,
      { headers }
    );
    if (res.ok) {
      const data   = await res.json();
      const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 1);
      const recent = (data || []).filter(d => new Date(d.Date) > cutoff);
      console.log(`  [${ticker}] GovContracts: ${data?.length || 0} total, ${recent.length} recent`);
      if (recent.length > 0) {
        hasGovContracts  = true;
        govContractTotal = recent.reduce((s, d) => s + (parseFloat(d.Amount) || 0), 0);
        govContractNote  = govContractTotal > 0
          ? `${recent.length} contract(s) worth $${(govContractTotal / 1000000).toFixed(1)}M — last 12mo`
          : `${recent.length} government contract(s) — last 12mo`;
      }
    } else {
      console.log(`  [${ticker}] GovContracts: ${res.status}`);
    }
  } catch (e) { console.log(`  [${ticker}] GovContracts error: ${e.message}`); }
  await sleep(400);

  // ── 5. Lobbying ───────────────────────────────────────────────────────────
  // Endpoint: /beta/historical/lobbying/{ticker}
  let lobbyingNote  = "No lobbying data found";
  let lobbyingTotal = 0;

  try {
    const res = await fetch(
      `https://api.quiverquant.com/beta/historical/lobbying/${ticker}`,
      { headers }
    );
    if (res.ok) {
      const data   = await res.json();
      const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 1);
      const recent = (data || []).filter(d => new Date(d.Date) > cutoff);
      console.log(`  [${ticker}] Lobbying: ${data?.length || 0} total, ${recent.length} recent`);
      if (recent.length > 0) {
        lobbyingTotal = recent.reduce((s, d) => s + (parseFloat(d.Amount) || 0), 0);
        lobbyingNote  = lobbyingTotal > 0
          ? `$${(lobbyingTotal / 1000000).toFixed(1)}M lobbying spend — last 12mo`
          : `${recent.length} lobbying record(s) — last 12mo`;
      }
    } else {
      console.log(`  [${ticker}] Lobbying: ${res.status}`);
    }
  } catch (e) { console.log(`  [${ticker}] Lobbying error: ${e.message}`); }
  await sleep(400);

  // ── 6. Off-Exchange / Dark Pool Trading ───────────────────────────────────
  // Endpoint: /beta/historical/offexchange/{ticker}
  let offExchangeNote   = "No off-exchange data found";
  let offExchangeSignal = "neutral";

  try {
    const res = await fetch(
      `https://api.quiverquant.com/beta/historical/offexchange/${ticker}`,
      { headers }
    );
    if (res.ok) {
      const data   = await res.json();
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
      const recent = (data || []).filter(d => new Date(d.Date) > cutoff);
      console.log(`  [${ticker}] OffExchange: ${data?.length || 0} total, ${recent.length} recent`);
      if (recent.length > 0) {
        // ShortVolume as % of total volume — high short volume = bearish pressure
        const avgShortPct = recent.reduce((s, d) => {
          const total = parseFloat(d.TotalVolume) || 0;
          const short = parseFloat(d.ShortVolume) || 0;
          return s + (total > 0 ? short / total : 0);
        }, 0) / recent.length;

        if (avgShortPct > 0.55) {
          offExchangeSignal = "bearish";
          offExchangeNote   = `High off-exchange short activity: ${(avgShortPct * 100).toFixed(1)}% avg short ratio — last 30 days`;
        } else if (avgShortPct < 0.40) {
          offExchangeSignal = "bullish";
          offExchangeNote   = `Low off-exchange short activity: ${(avgShortPct * 100).toFixed(1)}% avg short ratio — last 30 days`;
        } else {
          offExchangeNote = `Normal off-exchange activity: ${(avgShortPct * 100).toFixed(1)}% avg short ratio — last 30 days`;
        }
      }
    } else {
      console.log(`  [${ticker}] OffExchange: ${res.status}`);
    }
  } catch (e) { console.log(`  [${ticker}] OffExchange error: ${e.message}`); }

  // ── Composite institutional signal ────────────────────────────────────────
  const signals    = [congressSignal, insiderSignal, hedgeFundSignal, offExchangeSignal]
                      .filter(s => s !== "neutral");
  const bulls      = signals.filter(s => s === "bullish").length;
  const bears      = signals.filter(s => s === "bearish").length;
  const instSentiment = bulls > bears ? "bullish" : bears > bulls ? "bearish" : "neutral";

  return {
    source:           "Quiver Quant",
    available:        true,
    instSentiment,
    congressSignal,   congressNote,  congressBuys, congressSells,
    insiderSignal,    insiderNote,
    hedgeFundSignal,  hedgeFundNote, hedgeFundBuys, hedgeFundSells, topHedgeFund,
    govContractNote,  govContractTotal, hasGovContracts,
    lobbyingNote,     lobbyingTotal,
    offExchangeSignal, offExchangeNote,
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
      spamCount:       0,
      tweetCount:      0,
      sentimentTrend:  trend.trend,
      sentimentDelta:  0,
      volumeDelta:     0,
      arrow:           "→",
      compositeScore:  0,
      analyzedAt:      new Date().toISOString(),
    };
  }

  // Filter spam and low-quality posts before AI analysis
  const cleanedTweets = cleanTweets(tweets, ticker);
  const tweetBlock = cleanedTweets.slice(0, 30).map((t, i) => `${i + 1}. "${t}"`).join("\n");
  const filteredCount = tweets.length - cleanedTweets.length;
  const context    = type === "etf"
    ? `This is an ETF (${sector}). Focus on fund flow sentiment, sector momentum, and macro themes.`
    : `This is a stock in the ${sector} sector. Focus on company-specific sentiment, earnings, and competitive positioning.`;

  const message = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{
      role:    "user",
      content: `You are a financial sentiment analysis engine. ${context}

Analyze these ${cleanedTweets.length} pre-filtered social media posts about $${ticker} (${name}). Posts have been pre-cleaned to remove spam and off-topic content. Return ONLY valid JSON — no markdown, no preamble.

Posts:
${tweetBlock}

Return exactly this JSON:
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
  "confidence": <"high" if 10+ posts, "medium" if 5-9, "low" if fewer than 5>
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
    tweetCount:     cleanedTweets.length,
    filteredCount:  filteredCount,
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
    // Weighted composite score across all 6 institutional signals
    const b = s => s === "bullish" ? 1 : s === "bearish" ? -1 : 0;
    const inst      = institutional;
    const hfBonus   = b(inst.hedgeFundSignal)   * 0.08; // hedge fund 13F
    const insBonus  = b(inst.insiderSignal)      * 0.07; // insider transactions
    const congBonus = b(inst.congressSignal)     * 0.06; // congressional trades
    const offBonus  = b(inst.offExchangeSignal)  * 0.04; // dark pool
    // Reduce score weight when confidence is low (few genuine posts after filtering)
    const confMultiplier = sentiment.confidence === 'low' ? 0.5 : sentiment.confidence === 'medium' ? 0.8 : 1.0;
    const spamPenalty = 0; // Pre-filtering handles quality — no post-hoc penalty needed

    const finalScore = parseFloat(
      Math.max(-1, Math.min(1,
        (sentiment.compositeScore * confMultiplier) + hfBonus + insBonus + congBonus + offBonus
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
    version:     "8.0",
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
