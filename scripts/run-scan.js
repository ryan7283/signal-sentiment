// scripts/run-scan.js — SIGNAL v3
// Reads watchlist from watchlist.json — add tickers there, not here
// Runs every weekday at 7am CT via GitHub Actions

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";

// ─── LOAD WATCHLIST FROM watchlist.json ──────────────────────────────────────

function loadWatchlist() {
  try {
    const raw = fs.readFileSync("watchlist.json", "utf8");
    const data = JSON.parse(raw);
    return data.tickers || [];
  } catch (e) {
    console.error("Failed to load watchlist.json:", e.message);
    process.exit(1);
  }
}

const WATCHLIST        = loadWatchlist();
const TWEETS_PER_TICKER = 50;
const LOOKBACK_HOURS    = 24;

// ─── LOAD YESTERDAY'S DATA ───────────────────────────────────────────────────

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

function calcTrend(todayScore, yesterday) {
  if (!yesterday) return { sentimentDelta: 0, volumeDelta: 0, trend: "new", arrow: "→" };
  const sentimentDelta = parseFloat((todayScore - (yesterday.sentimentScore || 0)).toFixed(3));
  const volumeDelta    = 0;
  const trend = sentimentDelta > 0.1 ? "improving" : sentimentDelta < -0.1 ? "declining" : "stable";
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
    console.error(`  [${ticker}] Twitter error: ${res.status}`);
    return [];
  }
  const data = await res.json();
  return (data.data || []).map(t => t.text);
}

// ─── SEC EDGAR INSTITUTIONAL DATA (FREE) ─────────────────────────────────────

async function fetchInstitutionalData(ticker, type) {
  // ETFs don't have 13F or insider filing data — skip
  if (type === "etf") {
    return {
      source: "N/A — ETF", available: false,
      filingCount: 0, uniqueFilers: 0, topFilers: "—",
      instSentiment: "neutral", insiderSignal: "neutral",
      insiderNote: "ETFs do not have 13F or insider filing data",
      quarterCovered: getQuarterLabel(), lastUpdated: new Date().toISOString(),
    };
  }

  try {
    const searchUrl = `https://efts.sec.gov/LATEST/search-index?q=%22${ticker}%22&dateRange=custom&startdt=${getQuarterStart()}&enddt=${new Date().toISOString().slice(0,10)}&forms=13F-HR`;
    const searchRes = await fetch(searchUrl, {
      headers: { "User-Agent": "SIGNAL-Bot signal@ryan7283.github.io" }
    });

    if (!searchRes.ok) return buildEmptyInstitutional();
    const searchData = await searchRes.json();
    const hits = searchData.hits?.hits || [];

    const filers = new Set();
    hits.slice(0, 20).forEach(h => {
      const entity = h._source?.entity_name || h._source?.display_names?.[0];
      if (entity) filers.add(entity);
    });

    const companySearch = await fetch(
      `https://www.sec.gov/cgi-bin/browse-edgar?company=${encodeURIComponent(ticker)}&CIK=&type=4&dateb=&owner=include&count=10&search_text=&action=getcompany&output=atom`,
      { headers: { "User-Agent": "SIGNAL-Bot signal@ryan7283.github.io" } }
    );

    let insiderSignal = "neutral";
    let insiderNote   = "No recent insider filings found";

    if (companySearch.ok) {
      const xml = await companySearch.text();
      const buyMatches  = (xml.match(/P - Purchase/gi) || []).length;
      const sellMatches = (xml.match(/S - Sale/gi) || []).length;
      if (buyMatches > sellMatches && buyMatches > 0) {
        insiderSignal = "bullish";
        insiderNote   = `${buyMatches} insider purchase(s) vs ${sellMatches} sale(s)`;
      } else if (sellMatches > buyMatches && sellMatches > 0) {
        insiderSignal = "bearish";
        insiderNote   = `${sellMatches} insider sale(s) vs ${buyMatches} purchase(s)`;
      } else if (buyMatches > 0 || sellMatches > 0) {
        insiderNote = `${buyMatches} purchase(s), ${sellMatches} sale(s) — mixed`;
      }
    }

    const filingCount = hits.length;
    const instSentiment = filingCount >= 10 ? "bullish" : filingCount <= 2 ? "bearish" : "neutral";

    return {
      source: "SEC EDGAR (free)", available: true,
      filingCount, uniqueFilers: filers.size,
      topFilers: Array.from(filers).slice(0, 3).join(", ") || "—",
      instSentiment, insiderSignal, insiderNote,
      quarterCovered: getQuarterLabel(),
      lastUpdated: new Date().toISOString(),
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
  return [`${year}-01-01`,`${year}-04-01`,`${year}-07-01`,`${year}-10-01`][q];
}

function getQuarterLabel() {
  const now = new Date();
  return `Q${Math.floor(now.getMonth()/3)+1} ${now.getFullYear()}`;
}

// ─── SENTIMENT ANALYSIS ──────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function analyzeSentiment(ticker, name, type, sector, tweets, yesterday) {
  if (!tweets.length) {
    const trend = calcTrend(0, yesterday);
    return {
      ticker, name, type, sector,
      sentimentScore: 0, signal: "NEUTRAL",
      bullCount: 0, bearCount: 0, neutralCount: 0,
      keyThemes: [], topBullish: null, topBearish: null,
      summary: "No posts found for this ticker in the last 24 hours.",
      confidence: "low", tweetCount: 0,
      volumeTrend: "silent", sentimentTrend: trend.trend,
      sentimentDelta: 0, volumeDelta: 0, arrow: "→",
      compositeScore: 0, analyzedAt: new Date().toISOString(),
    };
  }

  const tweetBlock = tweets.slice(0, 30).map((t, i) => `${i + 1}. "${t}"`).join("\n");
  const context    = type === "etf"
    ? `This is an ETF (${sector}). Focus on fund flow sentiment, sector momentum, and macro themes.`
    : `This is a stock in the ${sector} sector. Focus on company-specific sentiment, earnings expectations, and competitive positioning.`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{
      role: "user",
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
}`
    }],
  });

  const raw    = message.content.find(b => b.type === "text")?.text || "{}";
  const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  const trend  = calcTrend(parsed.sentimentScore, yesterday);

  const trendBonus  = trend.sentimentDelta > 0 ? 0.1 : trend.sentimentDelta < 0 ? -0.1 : 0;
  const volumeBonus = trend.volumeDelta > 5 ? 0.1 : trend.volumeDelta < -5 ? -0.1 : 0;
  const composite   = parseFloat(((parsed.sentimentScore * 0.6) + trendBonus + volumeBonus).toFixed(3));

  return {
    ...parsed, type, sector,
    tweetCount:     tweets.length,
    sentimentTrend: trend.trend,
    sentimentDelta: trend.sentimentDelta,
    volumeDelta:    trend.volumeDelta,
    arrow:          trend.arrow,
    compositeScore: Math.max(-1, Math.min(1, composite)),
    analyzedAt:     new Date().toISOString(),
  };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 SIGNAL v3 — Daily Scan: ${new Date().toISOString()}`);
  console.log(`📋 Watchlist: ${WATCHLIST.length} tickers loaded from watchlist.json\n`);

  fs.mkdirSync("data", { recursive: true });
  fs.mkdirSync("data/history", { recursive: true });

  const yesterday = loadYesterdayResults();
  const results   = [];

  for (const { ticker, name, type, sector, query } of WATCHLIST) {
    process.stdout.write(`  ${ticker.padEnd(6)} [${(type||'stock').toUpperCase()}] — fetching...`);
    const tweets = await fetchTweets(ticker, query);
    process.stdout.write(` ${tweets.length} posts. Analyzing...`);

    const sentiment     = await analyzeSentiment(ticker, name, type, sector, tweets, yesterday[ticker]);
    process.stdout.write(` ${sentiment.arrow} ${sentiment.signal}`);

    const institutional = await fetchInstitutionalData(ticker, type);
    process.stdout.write(` · inst:${institutional.instSentiment}\n`);

    const instBonus  = institutional.instSentiment === "bullish" ? 0.1
                     : institutional.instSentiment === "bearish" ? -0.1 : 0;
    const finalScore = parseFloat(Math.max(-1, Math.min(1,
      sentiment.compositeScore + instBonus
    )).toFixed(3));

    const finalSignal = finalScore >= 0.5  ? "STRONG_BUY"
                      : finalScore >= 0.15 ? "BUY"
                      : finalScore <= -0.5 ? "STRONG_SELL"
                      : finalScore <= -0.15 ? "SELL"
                      : "NEUTRAL";

    results.push({ ...sentiment, institutional, compositeScore: finalScore, signal: finalSignal });
    await new Promise(r => setTimeout(r, 1200));
  }

  const output = {
    generatedAt:  new Date().toISOString(),
    tickerCount:  results.length,
    version:      "3.0",
    results,
  };

  fs.writeFileSync("data/results.json", JSON.stringify(output, null, 2));
  const dateStr = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(`data/history/${dateStr}.json`, JSON.stringify(output, null, 2));

  console.log("\n📊 Summary:");
  results.forEach(r => {
    const tag = r.type === "etf" ? "[ETF]" : "[STK]";
    console.log(`  ${tag} ${r.ticker.padEnd(6)} ${r.arrow} ${r.finalSignal||r.signal} — composite: ${r.compositeScore.toFixed(2)}`);
  });
  console.log(`\n✅ Scan complete — ${results.length} tickers processed\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
