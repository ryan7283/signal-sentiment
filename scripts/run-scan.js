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
  // ETFs don't have Form 4 insider filings
  if (type === "etf") {
    return {
      source: "N/A — ETF", available: false,
      cik: null, companyName: "—",
      insiderSignal: "neutral",
      insiderNote: "ETFs do not have insider filing data",
      recentForm4Count: 0, buyCount: 0, sellCount: 0,
      instSentiment: "neutral",
      instNote: "Add Quiver Quant API key for institutional 13F data",
      quarterCovered: getQuarterLabel(),
      lastUpdated: new Date().toISOString(),
    };
  }

  try {
    const headers = { "User-Agent": "SIGNAL ryan7283@github.io" };

    // ── STEP 1: Look up the company CIK from SEC ticker map ──────────────────
    // SEC provides a free JSON map of all tickers to CIK numbers
    const tickerMapRes = await fetch(
      "https://www.sec.gov/files/company_tickers.json",
      { headers }
    );

    let cik = null;
    let companyName = ticker;

    if (tickerMapRes.ok) {
      const tickerMap = await tickerMapRes.json();
      // The map is an object keyed by index number, each entry has cik_str, ticker, title
      const entry = Object.values(tickerMap).find(
        e => e.ticker?.toUpperCase() === ticker.toUpperCase()
      );
      if (entry) {
        cik = String(entry.cik_str).padStart(10, "0");
        companyName = entry.title || ticker;
        console.log(`    CIK found for ${ticker}: ${cik} (${companyName})`);
      }
    }

    if (!cik) {
      console.log(`    No CIK found for ${ticker}`);
      return buildEmptyInstitutional(ticker);
    }

    // ── STEP 2: Fetch recent Form 4 filings (insider buy/sell) ───────────────
    // SEC submissions endpoint gives all recent filings for a company
    const submissionsRes = await fetch(
      `https://data.sec.gov/submissions/CIK${cik}.json`,
      { headers }
    );

    let insiderSignal = "neutral";
    let insiderNote   = "No recent insider filings";
    let recentForm4Count = 0;
    let buyCount = 0, sellCount = 0;

    if (submissionsRes.ok) {
      const submissions = await submissionsRes.json();
      const recent = submissions.filings?.recent || {};
      const forms  = recent.form || [];
      const dates  = recent.filingDate || [];

      // Get Form 4 filings from last 90 days
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 90);

      for (let i = 0; i < forms.length; i++) {
        if (forms[i] !== "4") continue;
        const filingDate = new Date(dates[i]);
        if (filingDate < cutoff) continue;
        recentForm4Count++;
      }

      // Get primary documents to check transaction codes
      // We look at the most recent 5 Form 4s for buy/sell codes
      const form4Indices = forms
        .map((f, i) => ({ form: f, date: dates[i], idx: i }))
        .filter(x => x.form === "4")
        .slice(0, 10);

      const accessions  = recent.accessionNumber || [];
      const primaryDocs = recent.primaryDocument  || [];

      for (const { idx } of form4Indices.slice(0, 5)) {
        try {
          const acc = accessions[idx]?.replace(/-/g, "");
          const doc = primaryDocs[idx];
          if (!acc || !doc) continue;

          const xmlRes = await fetch(
            `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${acc}/${doc}`,
            { headers }
          );
          if (!xmlRes.ok) continue;
          const xml = await xmlRes.text();

          // Transaction codes: P = open market purchase, S = open market sale
          const purchases = (xml.match(/<transactionCode>P<\/transactionCode>/g) || []).length;
          const sales     = (xml.match(/<transactionCode>S<\/transactionCode>/g) || []).length;
          buyCount  += purchases;
          sellCount += sales;
        } catch (e) {
          // skip individual filing errors
        }
      }

      if (recentForm4Count > 0) {
        if (buyCount > sellCount && buyCount > 0) {
          insiderSignal = "bullish";
          insiderNote   = `${recentForm4Count} insider filing(s) — ${buyCount} open-market purchase(s) vs ${sellCount} sale(s) in last 90 days`;
        } else if (sellCount > buyCount && sellCount > 0) {
          insiderSignal = "bearish";
          insiderNote   = `${recentForm4Count} insider filing(s) — ${sellCount} open-market sale(s) vs ${buyCount} purchase(s) in last 90 days`;
        } else if (buyCount === 0 && sellCount === 0) {
          insiderNote = `${recentForm4Count} insider filing(s) in last 90 days — awards/options only, no open-market trades`;
        } else {
          insiderNote = `${recentForm4Count} insider filing(s) — mixed: ${buyCount} purchase(s), ${sellCount} sale(s)`;
        }
      }
    }

    return {
      source:          "SEC EDGAR Form 4 (free)",
      available:       true,
      cik,
      companyName,
      insiderSignal,
      insiderNote,
      recentForm4Count,
      buyCount,
      sellCount,
      // 13F institutional data requires paid source
      instSentiment:   "n/a",
      instNote:        "13F data requires Quiver Quant ($25/mo) — add QUIVER_QUANT_API_KEY to GitHub Secrets",
      quarterCovered:  getQuarterLabel(),
      lastUpdated:     new Date().toISOString(),
    };

  } catch (e) {
    console.error(`  [${ticker}] EDGAR error: ${e.message}`);
    return buildEmptyInstitutional(ticker);
  }
}


function buildEmptyInstitutional(ticker) {
  return {
    source: "SEC EDGAR Form 4 (free)", available: false,
    cik: null, companyName: ticker || "—",
    insiderSignal: "neutral",
    insiderNote: "Could not retrieve insider data",
    recentForm4Count: 0, buyCount: 0, sellCount: 0,
    instSentiment: "n/a",
    instNote: "13F data requires Quiver Quant ($25/mo)",
    quarterCovered: getQuarterLabel(),
    lastUpdated: new Date().toISOString(),
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
