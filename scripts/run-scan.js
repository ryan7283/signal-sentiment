// scripts/run-scan.js — SIGNAL v2
// Upgraded: day-over-day trend tracking + SEC EDGAR institutional data (free)
// Runs every weekday at 7am CT via GitHub Actions

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const WATCHLIST = [
  { ticker: "IREN",  name: "Iris Energy",          query: "$IREN OR #IREN OR \"Iris Energy\"" },
  { ticker: "PLTR",  name: "Palantir",              query: "$PLTR OR #PLTR OR \"Palantir\"" },
  { ticker: "KEEL",  name: "Keelvar",               query: "$KEEL OR #KEEL OR \"Keelvar\"" },
  { ticker: "AFRM",  name: "Affirm",                query: "$AFRM OR #AFRM OR \"Affirm stock\"" },
  { ticker: "CRWD",  name: "CrowdStrike",           query: "$CRWD OR #CRWD OR \"CrowdStrike\"" },
  { ticker: "TSLA",  name: "Tesla",                 query: "$TSLA OR #TSLA" },
  { ticker: "IBIT",  name: "iShares Bitcoin ETF",   query: "$IBIT OR #IBIT OR \"iShares bitcoin\"" },
  { ticker: "APLD",  name: "Applied Digital",       query: "$APLD OR #APLD OR \"Applied Digital\"" },
];

const TWEETS_PER_TICKER = 50;
const LOOKBACK_HOURS    = 24;

// ─── LOAD YESTERDAY'S DATA (for trend comparison) ────────────────────────────

function loadYesterdayResults() {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().slice(0, 10);
    const path = `data/history/${dateStr}.json`;
    if (!fs.existsSync(path)) return {};
    const data = JSON.parse(fs.readFileSync(path, "utf8"));
    const map = {};
    (data.results || []).forEach(r => { map[r.ticker] = r; });
    return map;
  } catch (e) {
    return {};
  }
}

function calcTrend(today, yesterday) {
  if (!yesterday) return { sentimentDelta: 0, volumeDelta: 0, trend: "new", arrow: "→" };
  const sentimentDelta = parseFloat((today - (yesterday.sentimentScore || 0)).toFixed(3));
  const volumeDelta    = (today.tweetCount || 0) - (yesterday.tweetCount || 0);
  let trend = "stable";
  if (sentimentDelta > 0.1)       trend = "improving";
  else if (sentimentDelta < -0.1) trend = "declining";
  const arrow = sentimentDelta > 0.05 ? "↑" : sentimentDelta < -0.05 ? "↓" : "→";
  return { sentimentDelta, volumeDelta, trend, arrow };
}

// ─── TWITTER FETCH ───────────────────────────────────────────────────────────

async function fetchTweets(ticker, query) {
  const startTime = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const encodedQuery = encodeURIComponent(`(${query}) -is:retweet lang:en`);
  const url = [
    `https://api.twitter.com/2/tweets/search/recent`,
    `?query=${encodedQuery}`,
    `&max_results=${TWEETS_PER_TICKER}`,
    `&start_time=${startTime}`,
    `&tweet.fields=created_at,public_metrics`,
  ].join("");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.TWITTER_BEARER_TOKEN}` },
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`  [${ticker}] Twitter error: ${res.status}`);
    return [];
  }
  const data = await res.json();
  return (data.data || []).map(t => t.text);
}

// ─── SEC EDGAR INSTITUTIONAL DATA (FREE) ─────────────────────────────────────
// Uses SEC EDGAR full-text search to find recent 13F filings mentioning each ticker
// 100% free, no API key required

async function fetchInstitutionalData(ticker) {
  try {
    // Step 1: Search EDGAR for recent 13F filings mentioning this ticker
    const searchUrl = `https://efts.sec.gov/LATEST/search-index?q=%22${ticker}%22&dateRange=custom&startdt=${getQuarterStart()}&enddt=${new Date().toISOString().slice(0,10)}&forms=13F-HR`;
    const searchRes = await fetch(searchUrl, {
      headers: { "User-Agent": "SIGNAL-Bot contact@signal.app" }
    });

    if (!searchRes.ok) return buildEmptyInstitutional();
    const searchData = await searchRes.json();
    const hits = searchData.hits?.hits || [];

    if (hits.length === 0) return buildEmptyInstitutional();

    // Step 2: Count unique institutional filers
    const filers = new Set();
    hits.slice(0, 20).forEach(h => {
      const entity = h._source?.entity_name || h._source?.display_names?.[0];
      if (entity) filers.add(entity);
    });

    // Step 3: Get CIK for the company to look up insider transactions
    const companySearch = await fetch(
      `https://www.sec.gov/cgi-bin/browse-edgar?company=${encodeURIComponent(ticker)}&CIK=&type=4&dateb=&owner=include&count=10&search_text=&action=getcompany&output=atom`,
      { headers: { "User-Agent": "SIGNAL-Bot contact@signal.app" } }
    );

    let insiderSignal = "neutral";
    let insiderNote   = "No recent insider filings found";

    if (companySearch.ok) {
      const xml = await companySearch.text();
      // Count Form 4 filings (insider buy/sell transactions)
      const buyMatches  = (xml.match(/P - Purchase/gi) || []).length;
      const sellMatches = (xml.match(/S - Sale/gi) || []).length;
      if (buyMatches > sellMatches && buyMatches > 0) {
        insiderSignal = "bullish";
        insiderNote   = `${buyMatches} insider purchase(s) vs ${sellMatches} sale(s) in recent filings`;
      } else if (sellMatches > buyMatches && sellMatches > 0) {
        insiderSignal = "bearish";
        insiderNote   = `${sellMatches} insider sale(s) vs ${buyMatches} purchase(s) in recent filings`;
      } else if (buyMatches > 0 || sellMatches > 0) {
        insiderNote = `${buyMatches} purchase(s), ${sellMatches} sale(s) — mixed signal`;
      }
    }

    // Step 4: Calculate institutional sentiment from 13F filing count
    const filingCount = hits.length;
    let instSentiment = "neutral";
    if (filingCount >= 10) instSentiment = "bullish";
    else if (filingCount <= 2) instSentiment = "bearish";

    return {
      source:           "SEC EDGAR (free)",
      available:        true,
      filingCount,
      uniqueFilers:     filers.size,
      topFilers:        Array.from(filers).slice(0, 3).join(", ") || "—",
      instSentiment,
      insiderSignal,
      insiderNote,
      quarterCovered:   getQuarterLabel(),
      lastUpdated:      new Date().toISOString(),
    };

  } catch (e) {
    console.error(`  [${ticker}] EDGAR error: ${e.message}`);
    return buildEmptyInstitutional();
  }
}

function buildEmptyInstitutional() {
  return {
    source: "SEC EDGAR (free)", available: false,
    filingCount: 0, uniqueFilers: 0, topFilers: "—",
    instSentiment: "neutral", insiderSignal: "neutral",
    insiderNote: "No data found", quarterCovered: getQuarterLabel(),
    lastUpdated: new Date().toISOString(),
  };
}

function getQuarterStart() {
  const now = new Date();
  const q   = Math.floor(now.getMonth() / 3);
  const year = now.getFullYear();
  const starts = [`${year}-01-01`, `${year}-04-01`, `${year}-07-01`, `${year}-10-01`];
  return starts[q];
}

function getQuarterLabel() {
  const now  = new Date();
  const q    = Math.floor(now.getMonth() / 3) + 1;
  return `Q${q} ${now.getFullYear()}`;
}

// ─── SENTIMENT ANALYSIS ──────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function analyzeSentiment(ticker, name, tweets, yesterday) {
  if (!tweets.length) {
    const trend = calcTrend(0, yesterday);
    return {
      ticker, name, sentimentScore: 0, signal: "NEUTRAL",
      bullCount: 0, bearCount: 0, neutralCount: 0,
      keyThemes: [], topBullish: null, topBearish: null,
      summary: "No tweets found for this ticker in the last 24 hours.",
      confidence: "low", tweetCount: 0,
      volumeTrend: trend.volumeDelta >= 0 ? "stable" : "declining",
      sentimentTrend: trend.trend, sentimentDelta: 0,
      volumeDelta: trend.volumeDelta, arrow: trend.arrow,
      compositeScore: 0,
      analyzedAt: new Date().toISOString(),
    };
  }

  const tweetBlock = tweets.slice(0, 30).map((t, i) => `${i + 1}. "${t}"`).join("\n");

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{
      role: "user",
      content: `You are a financial sentiment analysis engine. Analyze these ${tweets.length} recent social media posts about $${ticker} (${name}) and return ONLY valid JSON — no markdown, no preamble.

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
}`
    }],
  });

  const raw    = message.content.find(b => b.type === "text")?.text || "{}";
  const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());

  // Calculate trend vs yesterday
  const trend = calcTrend(parsed.sentimentScore, yesterday);

  // Composite score: 60% sentiment + 20% trend direction + 20% volume trend
  const trendBonus   = trend.sentimentDelta > 0 ? 0.1 : trend.sentimentDelta < 0 ? -0.1 : 0;
  const volumeBonus  = trend.volumeDelta > 5 ? 0.1 : trend.volumeDelta < -5 ? -0.1 : 0;
  const composite    = parseFloat(((parsed.sentimentScore * 0.6) + trendBonus + volumeBonus).toFixed(3));

  return {
    ...parsed,
    tweetCount:      tweets.length,
    sentimentTrend:  trend.trend,
    sentimentDelta:  trend.sentimentDelta,
    volumeDelta:     trend.volumeDelta,
    arrow:           trend.arrow,
    compositeScore:  Math.max(-1, Math.min(1, composite)),
    analyzedAt:      new Date().toISOString(),
  };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 SIGNAL v2 — Daily Scan: ${new Date().toISOString()}\n`);

  fs.mkdirSync("data", { recursive: true });
  fs.mkdirSync("data/history", { recursive: true });

  const yesterday = loadYesterdayResults();
  const results   = [];

  for (const { ticker, name, query } of WATCHLIST) {
    process.stdout.write(`  ${ticker.padEnd(6)} — fetching tweets...`);
    const tweets = await fetchTweets(ticker, query);
    process.stdout.write(` ${tweets.length} found. Analyzing...`);

    const sentiment    = await analyzeSentiment(ticker, name, tweets, yesterday[ticker]);
    process.stdout.write(` ${sentiment.arrow} ${sentiment.signal} (${sentiment.sentimentScore.toFixed(2)}). EDGAR...`);

    const institutional = await fetchInstitutionalData(ticker);
    process.stdout.write(` ${institutional.instSentiment}\n`);

    // Final composite incorporating institutional signal
    const instBonus = institutional.instSentiment === "bullish" ? 0.1
                    : institutional.instSentiment === "bearish" ? -0.1 : 0;
    const finalScore = parseFloat(Math.max(-1, Math.min(1,
      sentiment.compositeScore + instBonus
    )).toFixed(3));

    // Derive final signal from composite score
    const finalSignal = finalScore >= 0.5  ? "STRONG_BUY"
                      : finalScore >= 0.15 ? "BUY"
                      : finalScore <= -0.5 ? "STRONG_SELL"
                      : finalScore <= -0.15 ? "SELL"
                      : "NEUTRAL";

    results.push({
      ...sentiment,
      institutional,
      compositeScore: finalScore,
      signal:         finalSignal,
    });

    await new Promise(r => setTimeout(r, 1200));
  }

  const output = {
    generatedAt:  new Date().toISOString(),
    tickerCount:  results.length,
    version:      "2.0",
    results,
  };

  fs.writeFileSync("data/results.json", JSON.stringify(output, null, 2));
  const dateStr = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(`data/history/${dateStr}.json`, JSON.stringify(output, null, 2));

  // Print summary
  console.log("\n📊 Summary:");
  results.forEach(r => {
    const inst = r.institutional?.instSentiment || "n/a";
    console.log(`  ${r.ticker.padEnd(6)} ${r.arrow} ${r.signal.padEnd(12)} composite: ${r.compositeScore.toFixed(2)}  inst: ${inst}`);
  });

  console.log(`\n✅ Done. Results written to data/results.json\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
