// scripts/run-scan.js
// Fetches recent tweets for each ticker, analyzes sentiment via Claude, writes results.json

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const WATCHLIST = [
  { ticker: "IREN",  name: "Iris Energy",        query: "$IREN OR #IREN OR \"Iris Energy\"" },
  { ticker: "PLTR",  name: "Palantir",            query: "$PLTR OR #PLTR OR \"Palantir\"" },
  { ticker: "KEEL",  name: "Keelvar",             query: "$KEEL OR #KEEL OR \"Keelvar\"" },
  { ticker: "AFRM",  name: "Affirm",              query: "$AFRM OR #AFRM OR \"Affirm stock\"" },
  { ticker: "CRWD",  name: "CrowdStrike",         query: "$CRWD OR #CRWD OR \"CrowdStrike\"" },
  { ticker: "TSLA",  name: "Tesla",               query: "$TSLA OR #TSLA" },
  { ticker: "IBIT",  name: "iShares Bitcoin ETF", query: "$IBIT OR #IBIT OR \"iShares bitcoin\"" },
  { ticker: "APLD",  name: "Applied Digital",     query: "$APLD OR #APLD OR \"Applied Digital\"" },
];

const TWEETS_PER_TICKER = 50;     // Max tweets to pull per ticker (Twitter Basic: 10k/mo)
const LOOKBACK_HOURS    = 24;     // Only pull tweets from last 24 hours

// ─── TWITTER FETCH ───────────────────────────────────────────────────────────

async function fetchTweets(ticker, query) {
  const startTime = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  // Remove "recent" search terms that break the query syntax
  const encodedQuery = encodeURIComponent(
    `(${query}) -is:retweet lang:en`
  );

  const url = [
    `https://api.twitter.com/2/tweets/search/recent`,
    `?query=${encodedQuery}`,
    `&max_results=${TWEETS_PER_TICKER}`,
    `&start_time=${startTime}`,
    `&tweet.fields=created_at,public_metrics,author_id`,
  ].join("");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.TWITTER_BEARER_TOKEN}` },
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[${ticker}] Twitter API error: ${res.status} ${err}`);
    return [];
  }

  const data = await res.json();
  return (data.data || []).map((t) => t.text);
}

// ─── SENTIMENT ANALYSIS ──────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function analyzeSentiment(ticker, name, tweets) {
  if (!tweets.length) {
    return {
      ticker, name,
      sentimentScore: 0, signal: "NEUTRAL",
      bullCount: 0, bearCount: 0, neutralCount: 0,
      keyThemes: [], topBullish: null, topBearish: null,
      summary: "No tweets found for this ticker in the last 24 hours.",
      confidence: "low", tweetCount: 0, analyzedAt: new Date().toISOString(),
    };
  }

  const tweetBlock = tweets.slice(0, 30).map((t, i) => `${i + 1}. "${t}"`).join("\n");

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{
      role: "user",
      content: `You are a financial sentiment analysis engine. Analyze these ${tweets.length} recent social media posts about $${ticker} (${name}) and return ONLY valid JSON with no markdown, no explanation, no preamble.

Posts (showing up to 30):
${tweetBlock}

Return exactly this JSON structure:
{
  "ticker": "${ticker}",
  "name": "${name}",
  "sentimentScore": <float from -1.0 (very bearish) to 1.0 (very bullish)>,
  "signal": <"STRONG_BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG_SELL">,
  "bullCount": <integer — number of clearly bullish posts>,
  "bearCount": <integer — number of clearly bearish posts>,
  "neutralCount": <integer — number of neutral or ambiguous posts>,
  "keyThemes": [<3-5 short strings describing dominant themes e.g. "AI pivot thesis", "valuation concerns">],
  "topBullish": <the single most bullish post text or null>,
  "topBearish": <the single most bearish post text or null>,
  "summary": <2-sentence analyst-quality summary of overall sentiment and key drivers>,
  "confidence": <"high" if 20+ posts, "medium" if 5-19, "low" if <5>,
  "tweetCount": ${tweets.length},
  "analyzedAt": "${new Date().toISOString()}"
}`,
    }],
  });

  const raw = message.content.find((b) => b.type === "text")?.text || "{}";
  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── INSTITUTIONAL DATA STUB ─────────────────────────────────────────────────
// Phase 2: Replace this with real calls to:
//   - Quiver Quant API (https://api.quiverquant.com) — congressional + institutional trades
//   - SEC EDGAR full-text search for 13F filings
//   - Unusual Whales API for options flow + dark pool

async function fetchInstitutionalData(ticker) {
  // TODO: Integrate Quiver Quant or SEC EDGAR
  // Example Quiver Quant endpoint:
  //   GET https://api.quiverquant.com/beta/historical/institutionalownership/${ticker}
  //   Headers: { Authorization: `Token ${process.env.QUIVER_QUANT_API_KEY}` }

  return {
    source: "stub — integrate Quiver Quant or SEC EDGAR for live data",
    available: false,
  };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 SIGNAL — Daily Scan starting at ${new Date().toISOString()}\n`);

  const results = [];

  for (const { ticker, name, query } of WATCHLIST) {
    process.stdout.write(`  ${ticker.padEnd(6)} — fetching tweets...`);
    const tweets = await fetchTweets(ticker, query);
    process.stdout.write(` ${tweets.length} found. Analyzing...`);

    const sentiment = await analyzeSentiment(ticker, name, tweets);
    const institutional = await fetchInstitutionalData(ticker);

    results.push({ ...sentiment, institutional });

    const icon = sentiment.signal.includes("BUY") ? "🟢" : sentiment.signal.includes("SELL") ? "🔴" : "🟡";
    console.log(` ${icon} ${sentiment.signal} (${sentiment.sentimentScore.toFixed(2)})`);

    // Throttle to avoid hitting rate limits
    await new Promise((r) => setTimeout(r, 1200));
  }

  // ── Write today's results ─────────────────────────────────────────────────
  fs.mkdirSync("data", { recursive: true });
  fs.mkdirSync("data/history", { recursive: true });

  const output = {
    generatedAt: new Date().toISOString(),
    tickerCount: results.length,
    results,
  };

  // Current results (dashboard reads this)
  fs.writeFileSync("data/results.json", JSON.stringify(output, null, 2));

  // Daily archive (for historical trend tracking)
  const dateStr = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(`data/history/${dateStr}.json`, JSON.stringify(output, null, 2));

  console.log(`\n✅ Scan complete. Results written to data/results.json\n`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
