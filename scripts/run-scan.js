// scripts/run-scan.js — SIGNAL v5
// Reads watchlist from watchlist.json
// Twitter sentiment + SEC EDGAR Form 4 insider trading (free)
// Runs every weekday at 7am CT via GitHub Actions

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";

// ─── HELPER FUNCTIONS ────────────────────────────────────────────────────────

function getQuarterLabel() {
  const now = new Date();
  return `Q${Math.floor(now.getMonth() / 3) + 1} ${now.getFullYear()}`;
}

function get90DaysAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return d.toISOString().slice(0, 10);
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
  const startTime    = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const encodedQuery = encodeURIComponent(`(${query}) -is:retweet lang:en`);
  const url = [
    `https://api.twitter.com/2/tweets/search/recent`,
    `?query=${encodedQuery}`,
    `&max_results=50`,
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

// ─── SEC EDGAR — FORM 4 INSIDER TRADING (FREE) ───────────────────────────────

async function fetchInsiderData(ticker, type) {
  // ETFs don't have insider filings
  if (type === "etf") {
    return {
      available:        false,
      insiderSignal:    "neutral",
      insiderNote:      "ETFs do not have insider filing data",
      recentForm4Count: 0,
      buyCount:         0,
      sellCount:        0,
      instSentiment:    "n/a",
      instNote:         "13F data requires Quiver Quant ($25/mo)",
      quarterCovered:   getQuarterLabel(),
    };
  }

  const headers = { "User-Agent": "SIGNAL ryan7283@github.io" };

  try {
    // Step 1: Look up CIK — use cache if available, otherwise look up from SEC map
    // The SEC ticker map is downloaded ONCE per scan run and cached in memory
    let cikPadded, cikRaw;

    // Known CIKs hardcoded as fallback — these never change
    const KNOWN_CIKS = {
      PLTR: "0001321655", AFRM: "0001820953", AMZN: "0001018724",
      KEEL: null,         APLD: "0001144879", IREN: "0001878848",
      TSLA: "0001318605", VST:  "0001692819", QXO:  "0001236275",
      CRWD: "0001517396", NVDA: "0001045810", META: "0001326801",
      MSFT: "0000789019", GOOG: "0001652044", AAPL: "0000320193",
    };

    const knownCik = KNOWN_CIKS[ticker.toUpperCase()];

    if (knownCik) {
      // Use hardcoded CIK — instant, no API call
      cikPadded = knownCik;
      cikRaw    = parseInt(knownCik);
      console.log(`    [${ticker}] CIK: ${cikPadded} (known)`);
    } else if (global._secTickerMap) {
      // Use cached ticker map from earlier in this scan run
      const entry = Object.values(global._secTickerMap).find(
        e => (e.ticker || "").toUpperCase() === ticker.toUpperCase()
      );
      if (entry) {
        cikPadded = String(entry.cik_str).padStart(10, "0");
        cikRaw    = parseInt(entry.cik_str);
        console.log(`    [${ticker}] CIK: ${cikPadded} (from cache)`);
      } else {
        return buildEmptyInsider(`${ticker} not found in SEC registry`);
      }
    } else {
      // Download the SEC ticker map once and cache it globally
      console.log(`    [${ticker}] Downloading SEC ticker map...`);
      await sleep(1000); // be polite to SEC servers
      const mapRes = await fetch(
        "https://www.sec.gov/files/company_tickers.json",
        { headers }
      );
      if (!mapRes.ok) {
        return buildEmptyInsider(`SEC ticker map unavailable (${mapRes.status})`);
      }
      global._secTickerMap = await mapRes.json();

      const entry = Object.values(global._secTickerMap).find(
        e => (e.ticker || "").toUpperCase() === ticker.toUpperCase()
      );
      if (!entry) {
        return buildEmptyInsider(`${ticker} not found in SEC registry`);
      }
      cikPadded = String(entry.cik_str).padStart(10, "0");
      cikRaw    = parseInt(entry.cik_str);
      console.log(`    [${ticker}] CIK: ${cikPadded} (from SEC map)`);
    }

    if (!cikPadded) {
      return buildEmptyInsider(`${ticker} — no CIK available (may be private or ETF)`);
    }

    // Step 2: Fetch recent filings from SEC submissions API
    await sleep(500); // be polite to SEC servers
    const subRes = await fetch(
      `https://data.sec.gov/submissions/CIK${cikPadded}.json`,
      { headers }
    );

    if (!subRes.ok) {
      console.log(`    [${ticker}] submissions API failed: ${subRes.status} ${subRes.statusText}`);
      return buildEmptyInsider(`SEC submissions API error (${subRes.status})`);
    }

    const submissions = await subRes.json();
    const recent      = submissions.filings?.recent || {};
    const forms       = recent.form        || [];
    const dates       = recent.filingDate  || [];
    const accessions  = recent.accessionNumber || [];
    const primaryDocs = recent.primaryDocument  || [];

    console.log(`    [${ticker}] Total filings in submissions: ${forms.length}`);

    // Step 3: Find Form 4 filings from last 90 days
    const cutoffDate  = get90DaysAgo();
    const form4Entries = [];

    for (let i = 0; i < forms.length; i++) {
      if (forms[i] !== "4") continue;
      if (dates[i] < cutoffDate) continue;
      form4Entries.push({ idx: i, date: dates[i], acc: accessions[i], doc: primaryDocs[i] });
    }

    const recentForm4Count = form4Entries.length;
    console.log(`    [${ticker}] Form 4 filings in last 90 days: ${recentForm4Count}`);

    // Step 4: Read actual XML of up to 5 recent Form 4s for buy/sell codes
    let buyCount = 0, sellCount = 0;

    for (const { acc, doc } of form4Entries.slice(0, 5)) {
      try {
        if (!acc || !doc) continue;
        const cleanAcc = acc.replace(/-/g, "");
        const xmlUrl   = `https://www.sec.gov/Archives/edgar/data/${cikRaw}/${cleanAcc}/${doc}`;
        const xmlRes   = await fetch(xmlUrl, { headers });
        if (!xmlRes.ok) {
          console.log(`    [${ticker}] Form 4 XML fetch failed: ${xmlRes.status} for ${doc}`);
          continue;
        }
        const xml = await xmlRes.text();

        // Transaction code P = open market purchase, S = open market sale
        const purchases = (xml.match(/<transactionCode>P<\/transactionCode>/g) || []).length;
        const sales     = (xml.match(/<transactionCode>S<\/transactionCode>/g) || []).length;
        console.log(`    [${ticker}] Form 4 ${doc}: P=${purchases} S=${sales}`);
        buyCount  += purchases;
        sellCount += sales;
      } catch (e) {
        console.log(`    [${ticker}] Form 4 parse error: ${e.message}`);
      }
    }

    // Step 5: Derive insider signal
    let insiderSignal = "neutral";
    let insiderNote;

    if (recentForm4Count === 0) {
      insiderNote = "No Form 4 insider filings in last 90 days";
    } else if (buyCount > 0 && buyCount > sellCount) {
      insiderSignal = "bullish";
      insiderNote   = `${recentForm4Count} filing(s) — ${buyCount} open-market purchase(s) vs ${sellCount} sale(s)`;
    } else if (sellCount > 0 && sellCount > buyCount) {
      insiderSignal = "bearish";
      insiderNote   = `${recentForm4Count} filing(s) — ${sellCount} open-market sale(s) vs ${buyCount} purchase(s)`;
    } else if (buyCount === 0 && sellCount === 0 && recentForm4Count > 0) {
      insiderNote   = `${recentForm4Count} filing(s) — awards/options grants only, no open-market trades`;
    } else {
      insiderNote   = `${recentForm4Count} filing(s) — mixed signals (${buyCount} buys, ${sellCount} sells)`;
    }

    return {
      available:        true,
      cik:              cikPadded,
      companyName:      entry.title,
      insiderSignal,
      insiderNote,
      recentForm4Count,
      buyCount,
      sellCount,
      instSentiment:    "n/a",
      instNote:         "13F institutional holdings data requires Quiver Quant ($25/mo) — add QUIVER_QUANT_API_KEY to GitHub Secrets to activate",
      quarterCovered:   getQuarterLabel(),
      lastUpdated:      new Date().toISOString(),
    };

  } catch (e) {
    console.error(`  [${ticker}] EDGAR error: ${e.message}`);
    return buildEmptyInsider(e.message);
  }
}

function buildEmptyInsider(reason) {
  return {
    available:        false,
    insiderSignal:    "neutral",
    insiderNote:      reason || "Could not retrieve insider data",
    recentForm4Count: 0,
    buyCount:         0,
    sellCount:        0,
    instSentiment:    "n/a",
    instNote:         "13F data requires Quiver Quant ($25/mo)",
    quarterCovered:   getQuarterLabel(),
    lastUpdated:      new Date().toISOString(),
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
    : `This is a stock in the ${sector} sector. Focus on company-specific sentiment, earnings expectations, and competitive positioning.`;

  const message = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{
      role:    "user",
      content: `You are a financial sentiment analysis engine. ${context}

Analyze these ${tweets.length} recent social media posts about $${ticker} (${name}) and return ONLY valid JSON — no markdown, no preamble.

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
    ...parsed,
    type,
    sector,
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

  console.log(`\n🔍 SIGNAL v5 — Daily Scan: ${new Date().toISOString()}`);
  console.log(`📋 Watchlist: ${WATCHLIST.length} tickers\n`);

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
    process.stdout.write(` ${sentiment.arrow} ${sentiment.signal}`);

    process.stdout.write(`. Insider data...`);
    const insider = await fetchInsiderData(ticker, type || "stock");
    process.stdout.write(` ${insider.insiderSignal}\n`);

    // Final composite score: sentiment + trend + insider signal
    const insiderBonus = insider.insiderSignal === "bullish" ?  0.1
                       : insider.insiderSignal === "bearish" ? -0.1 : 0;
    const finalScore   = parseFloat(
      Math.max(-1, Math.min(1, sentiment.compositeScore + insiderBonus)).toFixed(3)
    );
    const finalSignal  = finalScore >=  0.5  ? "STRONG_BUY"
                       : finalScore >=  0.15 ? "BUY"
                       : finalScore <= -0.5  ? "STRONG_SELL"
                       : finalScore <= -0.15 ? "SELL"
                       : "NEUTRAL";

    results.push({
      ...sentiment,
      institutional:  insider,
      compositeScore: finalScore,
      signal:         finalSignal,
    });

    await sleep(1500);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    tickerCount: results.length,
    version:     "5.0",
    results,
  };

  fs.writeFileSync("data/results.json", JSON.stringify(output, null, 2));
  const dateStr = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(`data/history/${dateStr}.json`, JSON.stringify(output, null, 2));

  console.log("\n📊 Summary:");
  results.forEach(r => {
    const tag = r.type === "etf" ? "[ETF]" : "[STK]";
    console.log(`  ${tag} ${r.ticker.padEnd(6)} ${r.arrow} ${r.signal.padEnd(12)} score:${r.compositeScore.toFixed(2)}  insider:${r.institutional?.insiderSignal || "n/a"}`);
  });
  console.log(`\n✅ Done — ${results.length} tickers processed\n`);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
