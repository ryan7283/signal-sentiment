// scripts/run-scan.js — SIGNAL v9
// All API endpoints verified against official source documentation
// Twitter v2 API: https://developer.twitter.com/en/docs/twitter-api
// Quiver Quant: https://github.com/Quiver-Quantitative/python-api/blob/main/quiverquant.py
// FMP: https://site.financialmodelingprep.com/developer/docs/stable/price-target-consensus

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";

// ─── HELPER FUNCTIONS ────────────────────────────────────────────────────────

// Try multiple field name variants — never silently returns undefined
function getField(obj, ...keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
      return obj[key];
    }
  }
  return null;
}

// Validates first record from any API response — logs warning if fields are missing
function validateRecord(ticker, endpoint, record, requiredFields) {
  const missing = requiredFields.filter(f => {
    const variants = Array.isArray(f) ? f : [f];
    return !variants.some(v => record[v] !== undefined && record[v] !== null);
  });
  if (missing.length > 0) {
    console.log(`  ⚠ [${ticker}] ${endpoint}: unexpected fields. Missing: ${JSON.stringify(missing)}. Got: ${Object.keys(record).join(", ")}`);
    return false;
  }
  return true;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getQuarterLabel() {
  const now = new Date();
  return `Q${Math.floor(now.getMonth() / 3) + 1} ${now.getFullYear()}`;
}

// ─── LOAD WATCHLIST ───────────────────────────────────────────────────────────

function loadWatchlist() {
  try {
    const raw = fs.readFileSync("watchlist.json", "utf8");
    return JSON.parse(raw).tickers || [];
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
    const map = {};
    (data.results || []).forEach(r => { map[r.ticker] = r; });
    return map;
  } catch (e) {
    return {};
  }
}

function calcTrend(todayScore, yesterday) {
  if (!yesterday) return { sentimentDelta: 0, trend: "new", arrow: "→" };
  const sentimentDelta = parseFloat((todayScore - (yesterday.sentimentScore || 0)).toFixed(3));
  const trend = sentimentDelta > 0.1 ? "improving" : sentimentDelta < -0.1 ? "declining" : "stable";
  const arrow = sentimentDelta > 0.05 ? "↑" : sentimentDelta < -0.05 ? "↓" : "→";
  return { sentimentDelta, trend, arrow };
}

// ─── TWEET QUALITY FILTER ────────────────────────────────────────────────────

function cleanTweets(tweets, ticker) {
  const spamPatterns = [
    /whatsapp\.com/i, /wa\.me\//i, /chat\.whatsapp/i,
    /join.*group/i, /dm.*signal/i, /signal.*group/i,
    /guaranteed.*profit/i, /100x/i, /get rich/i,
    /investment group/i, /forex.*profit/i, /recover.*lost.*fund/i,
    /binary.*option/i, /pump.*dump/i, /t\.me\//i,
  ];
  const filtered = tweets.filter(text => {
    if (text.trim().length < 20) return false;
    if (spamPatterns.some(p => p.test(text))) return false;
    return true;
  });
  const removed = tweets.length - filtered.length;
  if (removed > 0) {
    console.log(`  [${ticker}] Quality filter: removed ${removed}/${tweets.length} spam/low-quality posts. ${filtered.length} genuine posts remaining.`);
  }
  return filtered;
}

// ─── TWITTER/X FETCH ─────────────────────────────────────────────────────────
// API: Twitter v2 Recent Search
// Auth: Bearer token in Authorization header
// Response structure: { data: [{ id, text, created_at, public_metrics }], meta: { result_count } }
// Ref: https://developer.twitter.com/en/docs/twitter-api/tweets/search/api-reference/get-tweets-search-recent

async function fetchTweets(ticker, query) {
  const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const qualityFilters = `-is:retweet lang:en`;
  const encodedQuery = encodeURIComponent(`(${query}) ${qualityFilters}`);

  async function doFetch(queryStr) {
    const url = [
      `https://api.twitter.com/2/tweets/search/recent`,
      `?query=${queryStr}`,
      `&max_results=50`,
      `&start_time=${startTime}`,
      `&tweet.fields=created_at,public_metrics,author_id`,
    ].join("");

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.TWITTER_BEARER_TOKEN}` },
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`  [${ticker}] Twitter HTTP ${res.status}: ${errText.slice(0, 150)}`);
      return null;
    }

    const json = await res.json();

    if (json.errors && json.errors.length > 0) {
      console.error(`  [${ticker}] Twitter API error: ${JSON.stringify(json.errors[0])}`);
      return null;
    }

    if (json.data !== undefined && !Array.isArray(json.data)) {
      console.error(`  [${ticker}] Twitter: unexpected response — data is not an array`);
      return null;
    }

    if (json.data && json.data.length > 0 && json.data[0].text === undefined) {
      console.error(`  [${ticker}] Twitter: 'text' field missing. Got: ${Object.keys(json.data[0]).join(", ")}`);
      return null;
    }

    return (json.data || []).map(t => t.text).filter(Boolean);
  }

  let tweets = await doFetch(encodedQuery);

  if (tweets === null) {
    console.log(`  [${ticker}] Retrying with simplified query...`);
    tweets = await doFetch(encodeURIComponent(`$${ticker} -is:retweet lang:en`));
  }

  if (tweets === null) {
    // Twitter quota depleted — try to reuse yesterday's cached tweets to avoid wasting a run
    const cachePath = `data/tweet-cache/${ticker}.json`;
    try {
      if (fs.existsSync(cachePath)) {
        const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        const cacheAge = (Date.now() - new Date(cached.savedAt).getTime()) / (1000 * 60 * 60);
        if (cacheAge < 48) { // use cache if under 48 hours old
          console.log(`  [${ticker}] Using cached tweets from ${cacheAge.toFixed(1)}h ago (Twitter quota depleted)`);
          return cached.tweets || [];
        }
      }
    } catch (e) { /* cache miss is fine */ }
    console.error(`  [${ticker}] Twitter fetch failed — no cache available, returning 0 posts`);
    return [];
  }

  // Save tweets to cache for reuse if quota is depleted later
  try {
    fs.mkdirSync("data/tweet-cache", { recursive: true });
    fs.writeFileSync(
      `data/tweet-cache/${ticker}.json`,
      JSON.stringify({ ticker, tweets, savedAt: new Date().toISOString() })
    );
  } catch (e) { /* cache write failure is non-fatal */ }

  return tweets;
}

// ─── QUIVER QUANT INSTITUTIONAL DATA ─────────────────────────────────────────
// Auth: "Token <key>" — verified from official Python source
// All endpoints verified from: https://github.com/Quiver-Quantitative/python-api/blob/main/quiverquant.py

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

  // Confirmed from Quiver Python source: uses "Token <key>"
  const headers = {
    Accept: "application/json",
    Authorization: `Token ${apiKey}`,
  };

  // ── 1. Congressional Trading ──────────────────────────────────────────────
  // Confirmed: https://api.quiverquant.com/beta/historical/congresstrading/{ticker}
  // Fields confirmed: Representative, TransactionDate, Filed, Transaction ("Purchase"/"Sale")
  let congressSignal = "neutral";
  let congressNote = "No congressional trades found";
  let congressBuys = 0, congressSells = 0;

  try {
    const res = await fetch(
      `https://api.quiverquant.com/beta/historical/congresstrading/${ticker}`,
      { headers }
    );
    if (res.ok) {
      const data = await res.json();
      if (data.length > 0) validateRecord(ticker, "Congress", data[0], [["TransactionDate", "Filed", "Date"], "Transaction"]);
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 365);
      const recent = (data || []).filter(t => new Date(getField(t, "TransactionDate", "Filed", "Date")) > cutoff);
      const buys = recent.filter(t => (getField(t, "Transaction", "transaction") || "").toLowerCase().includes("purchase"));
      const sells = recent.filter(t => (getField(t, "Transaction", "transaction") || "").toLowerCase().includes("sale"));
      congressBuys = buys.length; congressSells = sells.length;
      console.log(`  [${ticker}] Congress: ${data.length} total, ${recent.length} recent — ${buys.length} buys, ${sells.length} sells`);
      if (buys.length > sells.length && buys.length > 0) {
        congressSignal = "bullish";
        congressNote = `${buys.length} congressional purchase(s) vs ${sells.length} sale(s) — last 12mo`;
      } else if (sells.length > buys.length && sells.length > 0) {
        congressSignal = "bearish";
        congressNote = `${sells.length} congressional sale(s) vs ${buys.length} purchase(s) — last 12mo`;
      } else if (recent.length > 0) {
        congressNote = `${recent.length} congressional trade(s) — mixed signal`;
      }
    } else { console.log(`  [${ticker}] Congress: ${res.status}`); }
  } catch (e) { console.log(`  [${ticker}] Congress error: ${e.message}`); }
  await sleep(400);

  // ── 2. Insider Trading ────────────────────────────────────────────────────
  // Confirmed: https://api.quiverquant.com/beta/live/insiders?ticker={ticker}
  // Fields confirmed from live API response: Date, Name, TransactionCode (P=purchase, S=sale),
  //   AcquiredDisposedCode (A=acquired, D=disposed), Shares, PricePerShare
  let insiderSignal = "neutral";
  let insiderNote = "No insider trades found";

  try {
    const res = await fetch(
      `https://api.quiverquant.com/beta/live/insiders?ticker=${ticker}`,
      { headers }
    );
    if (res.ok) {
      const data = await res.json();
      if (data.length > 0) validateRecord(ticker, "Insiders", data[0], [["TransactionCode", "AcquiredDisposedCode"], "Date"]);
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 180);
      const recent = (data || []).filter(t => new Date(getField(t, "Date", "date")) > cutoff);
      // TransactionCode P = open-market purchase, S = open-market sale (confirmed from live API)
      const buys = recent.filter(t =>
        getField(t, "TransactionCode") === "P" ||
        getField(t, "AcquiredDisposedCode", "AcquiredDisposed") === "A"
      );
      const sells = recent.filter(t =>
        getField(t, "TransactionCode") === "S" ||
        getField(t, "AcquiredDisposedCode", "AcquiredDisposed") === "D"
      );
      console.log(`  [${ticker}] Insiders: ${data.length} total, ${recent.length} recent — ${buys.length} buys, ${sells.length} sells`);
      if (buys.length > sells.length && buys.length > 0) {
        insiderSignal = "bullish";
        const topBuyer = getField(recent.find(t => getField(t, "TransactionCode") === "P") || {}, "Name", "name") || "";
        insiderNote = `${buys.length} open-market purchase(s) vs ${sells.length} sale(s) — last 180 days${topBuyer ? ` · ${topBuyer}` : ""}`;
      } else if (sells.length > buys.length && sells.length > 0) {
        insiderSignal = "bearish";
        insiderNote = `${sells.length} open-market sale(s) vs ${buys.length} purchase(s) — last 180 days`;
      } else if (recent.length > 0) {
        insiderNote = `${recent.length} insider filing(s) — awards/options, no open-market trades`;
      }
    } else { console.log(`  [${ticker}] Insiders: ${res.status}`); }
  } catch (e) { console.log(`  [${ticker}] Insiders error: ${e.message}`); }
  await sleep(400);

  // ── 3. Hedge Fund 13F Changes ─────────────────────────────────────────────
  // Confirmed: https://api.quiverquant.com/beta/live/sec13fchanges?ticker={ticker}
  // Fields confirmed from live API response: Date, ReportPeriod, Ticker, Fund, Change_Share,
  //   Change_Pct, Held, Held_Normalized, Close
  let hedgeFundSignal = "neutral";
  let hedgeFundNote = "No hedge fund data found";
  let hedgeFundBuys = 0, hedgeFundSells = 0;
  let topHedgeFund = null;

  try {
    const res = await fetch(
      `https://api.quiverquant.com/beta/live/sec13fchanges?ticker=${ticker}`,
      { headers }
    );
    if (res.ok) {
      const data = await res.json();
      if (data && data.length > 0) {
        if (data.length > 0) validateRecord(ticker, "HedgeFunds", data[0], [["Fund", "Owner"], ["Change_Share", "Change"], "ReportPeriod"]);

        // Get most recent quarter
        const periods = [...new Set(data.map(d => d.ReportPeriod))].sort().reverse();
        const latestPeriod = periods[0];
        const latestQ = data.filter(d => d.ReportPeriod === latestPeriod);

        // Change_Share is pre-computed by Quiver: positive = bought more, negative = sold
        const buyers  = latestQ.filter(d => (parseFloat(getField(d, "Change_Share", "Change") || 0)) > 0);
        const sellers = latestQ.filter(d => (parseFloat(getField(d, "Change_Share", "Change") || 0)) < 0);
        hedgeFundBuys  = buyers.length;
        hedgeFundSells = sellers.length;

        // Top buyer = fund with largest positive Change_Share
        const sortedBuyers = [...buyers].sort((a, b) =>
          (parseFloat(getField(b, "Change_Share", "Change") || 0)) -
          (parseFloat(getField(a, "Change_Share", "Change") || 0))
        );
        topHedgeFund = getField(sortedBuyers[0] || latestQ[0] || {}, "Fund", "Owner");

        console.log(`  [${ticker}] HedgeFunds: ${data.length} records, latest Q: ${latestPeriod}, ${latestQ.length} funds — ${buyers.length} buying, ${sellers.length} selling`);

        if (buyers.length > sellers.length && buyers.length > 0) {
          hedgeFundSignal = "bullish";
          hedgeFundNote = `${buyers.length} fund(s) increasing positions vs ${sellers.length} decreasing — ${latestPeriod}${topHedgeFund ? ` · Top: ${topHedgeFund}` : ""}`;
        } else if (sellers.length > buyers.length && sellers.length > 0) {
          hedgeFundSignal = "bearish";
          hedgeFundNote = `${sellers.length} fund(s) reducing positions vs ${buyers.length} increasing — ${latestPeriod}`;
        } else if (latestQ.length > 0) {
          hedgeFundNote = `${latestQ.length} institutional holders — stable positioning — ${latestPeriod}`;
        }
      }
    } else { console.log(`  [${ticker}] HedgeFunds: ${res.status}`); }
  } catch (e) { console.log(`  [${ticker}] HedgeFunds error: ${e.message}`); }
  await sleep(400);

  // ── 4. Government Contracts ───────────────────────────────────────────────
  // Confirmed: https://api.quiverquant.com/beta/historical/govcontractsall/{ticker}
  let govContractNote = "No government contracts found";
  let govContractTotal = 0;
  let hasGovContracts = false;

  try {
    const res = await fetch(
      `https://api.quiverquant.com/beta/historical/govcontractsall/${ticker}`,
      { headers }
    );
    if (res.ok) {
      const data = await res.json();
      if ((data || []).length > 0) validateRecord(ticker, "GovContracts", data[0], [["Date", "date"], ["Amount", "amount"]]);
      const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 1);
      const recent = (data || []).filter(d => new Date(getField(d, "Date", "date")) > cutoff);
      console.log(`  [${ticker}] GovContracts: ${(data || []).length} total, ${recent.length} recent`);
      if (recent.length > 0) {
        hasGovContracts = true;
        govContractTotal = recent.reduce((s, d) => s + (parseFloat(getField(d, "Amount", "amount")) || 0), 0);
        govContractNote = govContractTotal > 0
          ? `${recent.length} contract(s) · $${(govContractTotal / 1000000).toFixed(1)}M total — last 12mo`
          : `${recent.length} government contract(s) — last 12mo`;
      }
    } else { console.log(`  [${ticker}] GovContracts: ${res.status}`); }
  } catch (e) { console.log(`  [${ticker}] GovContracts error: ${e.message}`); }
  await sleep(400);

  // ── 5. Lobbying ───────────────────────────────────────────────────────────
  // Confirmed: https://api.quiverquant.com/beta/historical/lobbying/{ticker}
  let lobbyingNote = "No lobbying data found";
  let lobbyingTotal = 0;

  try {
    const res = await fetch(
      `https://api.quiverquant.com/beta/historical/lobbying/${ticker}`,
      { headers }
    );
    if (res.ok) {
      const data = await res.json();
      const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 1);
      const recent = (data || []).filter(d => new Date(getField(d, "Date", "date")) > cutoff);
      console.log(`  [${ticker}] Lobbying: ${(data || []).length} total, ${recent.length} recent`);
      if (recent.length > 0) {
        lobbyingTotal = recent.reduce((s, d) => s + (parseFloat(getField(d, "Amount", "amount")) || 0), 0);
        lobbyingNote = lobbyingTotal > 0
          ? `$${(lobbyingTotal / 1000000).toFixed(1)}M lobbying spend — last 12mo`
          : `${recent.length} lobbying record(s) — last 12mo`;
      }
    } else { console.log(`  [${ticker}] Lobbying: ${res.status}`); }
  } catch (e) { console.log(`  [${ticker}] Lobbying error: ${e.message}`); }
  await sleep(400);

  // ── 6. Off-Exchange / Dark Pool ───────────────────────────────────────────
  // Confirmed: https://api.quiverquant.com/beta/historical/offexchange/{ticker}
  // Fields: Date, ShortVolume, TotalVolume
  let offExchangeSignal = "neutral";
  let offExchangeNote = "No off-exchange data found";

  try {
    const res = await fetch(
      `https://api.quiverquant.com/beta/historical/offexchange/${ticker}`,
      { headers }
    );
    if (res.ok) {
      const data = await res.json();
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
      const recent = (data || []).filter(d => new Date(getField(d, "Date", "date")) > cutoff);
      console.log(`  [${ticker}] OffExchange: ${(data || []).length} total, ${recent.length} recent`);
      if (recent.length > 0) {
        const avgShortPct = recent.reduce((s, d) => {
          const total = parseFloat(getField(d, "TotalVolume", "totalVolume") || 0);
          const short = parseFloat(getField(d, "ShortVolume", "shortVolume") || 0);
          return s + (total > 0 ? short / total : 0);
        }, 0) / recent.length;

        if (avgShortPct > 0.55) {
          offExchangeSignal = "bearish";
          offExchangeNote = `High short activity: ${(avgShortPct * 100).toFixed(1)}% avg short ratio — last 30 days`;
        } else if (avgShortPct < 0.40) {
          offExchangeSignal = "bullish";
          offExchangeNote = `Low short activity: ${(avgShortPct * 100).toFixed(1)}% avg short ratio — last 30 days`;
        } else {
          offExchangeNote = `Normal activity: ${(avgShortPct * 100).toFixed(1)}% avg short ratio — last 30 days`;
        }
      }
    } else { console.log(`  [${ticker}] OffExchange: ${res.status}`); }
  } catch (e) { console.log(`  [${ticker}] OffExchange error: ${e.message}`); }

  // ── Composite institutional signal ────────────────────────────────────────
  const signals = [congressSignal, insiderSignal, hedgeFundSignal, offExchangeSignal].filter(s => s !== "neutral");
  const bulls = signals.filter(s => s === "bullish").length;
  const bears = signals.filter(s => s === "bearish").length;
  const instSentiment = bulls > bears ? "bullish" : bears > bulls ? "bearish" : "neutral";

  return {
    source: "Quiver Quant", available: true,
    instSentiment,
    congressSignal, congressNote, congressBuys, congressSells,
    insiderSignal, insiderNote,
    hedgeFundSignal, hedgeFundNote, hedgeFundBuys, hedgeFundSells, topHedgeFund,
    hasGovContracts, govContractNote, govContractTotal,
    lobbyingNote, lobbyingTotal,
    offExchangeSignal, offExchangeNote,
    quarterCovered: getQuarterLabel(),
    lastUpdated: new Date().toISOString(),
  };
}

function buildNoKeyInstitutional() {
  return {
    source: "Quiver Quant (no key)", available: false,
    instSentiment: "neutral", insiderSignal: "neutral",
    congressSignal: "neutral", congressNote: "Add QUIVER_QUANT_API_KEY to GitHub Secrets",
    hedgeFundSignal: "neutral", hedgeFundNote: "Add QUIVER_QUANT_API_KEY to GitHub Secrets",
    quarterCovered: getQuarterLabel(), lastUpdated: new Date().toISOString(),
  };
}

function buildETFInstitutional() {
  return {
    source: "N/A — ETF", available: false,
    instSentiment: "neutral", insiderSignal: "neutral",
    congressSignal: "neutral", congressNote: "N/A — ETF",
    hedgeFundSignal: "neutral", hedgeFundNote: "ETFs tracked differently",
    instNote: "ETFs do not have insider or congressional data",
    quarterCovered: getQuarterLabel(), lastUpdated: new Date().toISOString(),
  };
}

// ─── FMP ANALYST PRICE TARGETS ───────────────────────────────────────────────
// Uses BATCH endpoints to fetch ALL tickers in ONE API call each
// Confirmed free tier:
//   /stable/quote?symbol=PLTR,IREN,...  → current prices (1 call)
//   /stable/price-target-consensus?symbol=PLTR,IREN,... → targets (1 call)
// Total: 2 FMP calls for all 15 tickers instead of 45 — no rate limiting

async function fetchAllAnalystData(tickers, fmpApiKey) {
  const results = {};

  if (!fmpApiKey) {
    console.log("  FMP: no API key — analyst targets unavailable");
    return results;
  }

  // Initialize all tickers as unavailable
  tickers.forEach(({ ticker, type }) => {
    results[ticker] = type === "etf"
      ? { available: false, note: "ETFs do not have analyst price targets" }
      : { available: false, note: "FMP data unavailable" };
  });

  const stockTickers = tickers.filter(t => t.type !== "etf").map(t => t.ticker);
  if (!stockTickers.length) return results;

  const symbols = stockTickers.join(",");

  try {
    // CALL 1: Batch current prices
    console.log(`  FMP batch quote: ${stockTickers.length} tickers...`);
    const quoteRes = await fetch(
      `https://financialmodelingprep.com/stable/quote?symbol=${symbols}&apikey=${fmpApiKey}`
    );

    if (!quoteRes.ok) {
      if (quoteRes.status === 402) {
        console.log(`  FMP: 402 — daily limit reached (250 calls/day). Resets tomorrow.`);
        console.log(`  FMP: batch uses only 2 calls/day — limit was hit by previous runs today.`);
      } else {
        console.log(`  FMP batch quote: ${quoteRes.status}`);
      }
      return results;
    }

    const quoteData = await quoteRes.json();
    if (!Array.isArray(quoteData)) {
      console.log(`  FMP batch quote: unexpected response`);
      return results;
    }

    // Build price map
    const priceMap = {};
    quoteData.forEach(q => {
      if (q.symbol && q.price) {
        priceMap[q.symbol] = parseFloat(q.price);
      }
    });
    console.log(`  FMP batch quote: got prices for ${Object.keys(priceMap).length} tickers`);

    await sleep(3000);

    // CALL 2: Batch consensus targets
    console.log(`  FMP batch consensus: ${stockTickers.length} tickers...`);
    const targetRes = await fetch(
      `https://financialmodelingprep.com/stable/price-target-consensus?symbol=${symbols}&apikey=${fmpApiKey}`
    );

    let targetMap = {};
    if (targetRes.ok) {
      const targetData = await targetRes.json();
      if (Array.isArray(targetData)) {
        targetData.forEach(t => {
          if (t.symbol) {
            targetMap[t.symbol] = t;
          }
        });
        console.log(`  FMP batch consensus: got targets for ${Object.keys(targetMap).length} tickers`);
      }
    } else {
      console.log(`  FMP batch consensus: ${targetRes.status}`);
    }

    // Build results for each ticker
    stockTickers.forEach(ticker => {
      const price = priceMap[ticker];
      const target = targetMap[ticker];

      if (!price) {
        results[ticker] = { available: false, note: "No price data from FMP" };
        return;
      }

      const avgTarget = parseFloat(
        getField(target || {}, "targetConsensus", "targetMedian") || 0
      );

      if (!avgTarget) {
        results[ticker] = {
          available: false,
          note: "No analyst coverage on FMP",
          currentPrice: price,
        };
        console.log(`  [${ticker}] FMP: price $${price} — no analyst target`);
        return;
      }

      const upsidePct = parseFloat(
        ((avgTarget - price) / price * 100).toFixed(1)
      );
      const highTarget = parseFloat(getField(target, "targetHigh") || 0);
      const lowTarget  = parseFloat(getField(target, "targetLow")  || 0);

      const signal = upsidePct >= 20  ? "strong_upside"
                   : upsidePct >= 5   ? "upside"
                   : upsidePct <= -20 ? "strong_downside"
                   : upsidePct <= -5  ? "downside"
                   : "neutral";

      results[ticker] = {
        available: true,
        currentPrice: price,
        avgTarget,
        highTarget,
        lowTarget,
        numAnalysts: 0,
        upsidePct,
        signal,
        lastUpdated: new Date().toISOString(),
      };

      console.log(`  [${ticker}] FMP: $${price} → $${avgTarget} → ${upsidePct > 0 ? "+" : ""}${upsidePct}%`);
    });

  } catch (e) {
    console.log(`  FMP batch error: ${e.message}`);
  }

  return results;
}

// Keep single-ticker version for compatibility (now just reads from batch map)
async function fetchAnalystData(ticker, type, analystMap) {
  if (analystMap && analystMap[ticker]) return analystMap[ticker];
  return type === "etf"
    ? { available: false, note: "ETFs do not have analyst price targets" }
    : { available: false, note: "Run fetchAllAnalystData first" };
}


// ─── SENTIMENT ANALYSIS ───────────────────────────────────────────────────────

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
      volumeTrend: "silent", confidence: "low",
      tweetCount: 0, filteredCount: 0,
      sentimentTrend: trend.trend, sentimentDelta: 0,
      arrow: "→", compositeScore: 0,
      analyzedAt: new Date().toISOString(),
    };
  }

  const cleanedTweets = cleanTweets(tweets, ticker);
  const filteredCount = tweets.length - cleanedTweets.length;
  const tweetBlock = cleanedTweets.slice(0, 30).map((t, i) => `${i + 1}. "${t}"`).join("\n");
  const context = type === "etf"
    ? `This is an ETF (${sector}). Focus on fund flow sentiment, sector momentum, and macro themes.`
    : `This is a stock in the ${sector} sector. Focus on company-specific sentiment, earnings, and competitive positioning.`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{
      role: "user",
      content: `You are a financial sentiment analysis engine. ${context}

Analyze these ${cleanedTweets.length} pre-filtered social media posts about $${ticker} (${name}) and return ONLY valid JSON — no markdown, no preamble.

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

  const raw = message.content.find(b => b.type === "text")?.text || "{}";
  const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  const trend = calcTrend(parsed.sentimentScore, yesterday);
  const trendBonus = trend.sentimentDelta > 0 ? 0.1 : trend.sentimentDelta < 0 ? -0.1 : 0;
  const confMultiplier = parsed.confidence === "low" ? 0.5 : parsed.confidence === "medium" ? 0.8 : 1.0;
  const composite = parseFloat(((parsed.sentimentScore * 0.6 * confMultiplier) + trendBonus).toFixed(3));

  return {
    ...parsed, type, sector,
    tweetCount: cleanedTweets.length,
    filteredCount,
    sentimentTrend: trend.trend,
    sentimentDelta: trend.sentimentDelta,
    arrow: trend.arrow,
    compositeScore: Math.max(-1, Math.min(1, composite)),
    analyzedAt: new Date().toISOString(),
  };
}

// ─── VIX VOLATILITY INDEX ─────────────────────────────────────────────────────
// Source: CBOE official daily CSV — free, no API key, no rate limit
// URL: https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv
// Format: DATE,OPEN,HIGH,LOW,CLOSE  (most recent row = today/yesterday)
// Also try FMP /stable/quote?symbol=%5EVIX as fallback (uses existing FMP key)

async function fetchVIX(fmpApiKey) {
  let vixValue = null;

  // Primary: CBOE official CSV — most authoritative source, always free
  try {
    const res = await fetch("https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv");
    if (res.ok) {
      const csv = await res.text();
      const lines = csv.trim().split("\n").filter(l => l.trim());
      // Last line = most recent trading day
      const last = lines[lines.length - 1].split(",");
      const close = parseFloat(last[4]); // CLOSE is 5th column
      if (close > 0) {
        vixValue = close;
        console.log(`  VIX: ${vixValue} (source: CBOE CSV)`);
      }
    } else {
      console.log(`  VIX CBOE: HTTP ${res.status}`);
    }
  } catch (e) {
    console.log(`  VIX CBOE error: ${e.message}`);
  }

  // Fallback: FMP quote for ^VIX (uses existing FMP key, 1 extra call)
  if (!vixValue && fmpApiKey) {
    try {
      await sleep(3000);
      const res = await fetch(
        `https://financialmodelingprep.com/stable/quote?symbol=%5EVIX&apikey=${fmpApiKey}`
      );
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0 && data[0].price) {
          vixValue = parseFloat(data[0].price);
          console.log(`  VIX: ${vixValue} (source: FMP fallback)`);
        }
      } else {
        console.log(`  VIX FMP fallback: HTTP ${res.status}`);
      }
    } catch (e) {
      console.log(`  VIX FMP error: ${e.message}`);
    }
  }

  if (!vixValue) {
    console.log("  VIX: unavailable");
    return null;
  }

  // Classify VIX into zones
  const zone = vixValue < 15   ? "low"
              : vixValue < 20   ? "normal"
              : vixValue < 25   ? "elevated"
              : vixValue < 30   ? "high"
              : vixValue < 40   ? "extreme"
              : "crisis";

  const label = vixValue < 15   ? "CALM"
              : vixValue < 20   ? "NORMAL"
              : vixValue < 25   ? "CAUTION"
              : vixValue < 30   ? "ELEVATED"
              : vixValue < 40   ? "HIGH FEAR"
              : "CRISIS";

  const advice = vixValue < 15   ? "Low volatility — risk-on environment, growth positions favored"
               : vixValue < 20   ? "Normal market — maintain current allocations"
               : vixValue < 25   ? "Elevated uncertainty — consider trimming highest-beta positions"
               : vixValue < 30   ? "High stress — reduce AI/speculative exposure, increase defensive ETF allocation"
               : vixValue < 40   ? "Fear environment — significantly reduce risk, raise cash or rotate to stable ETFs"
               : "Crisis level — maximum caution, protect capital first";

  return { value: vixValue, zone, label, advice };
}


// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const WATCHLIST = loadWatchlist();
  const hasQuiver = !!process.env.QUIVER_QUANT_API_KEY;
  const hasFMP    = !!process.env.FMP_API_KEY;

  console.log(`\n🔍 SIGNAL v9 — Daily Scan: ${new Date().toISOString()}`);
  console.log(`📋 Watchlist: ${WATCHLIST.length} tickers`);
  console.log(`🏦 Quiver Quant: ${hasQuiver ? "✓ active" : "✗ no key"}`);
  console.log(`📊 FMP Analyst:  ${hasFMP    ? "✓ active" : "✗ no key"}\n`);

  // Fetch ALL analyst targets in 2 batch API calls upfront (avoids rate limiting)
  console.log("📊 Fetching analyst targets (batch)...");
  const analystMap = await fetchAllAnalystData(WATCHLIST, process.env.FMP_API_KEY);
  console.log(`   Done — ${Object.values(analystMap).filter(a => a.available).length}/${WATCHLIST.filter(t => t.type !== 'etf').length} stocks have targets\n`);

  fs.mkdirSync("data",         { recursive: true });
  fs.mkdirSync("data/history", { recursive: true });
  fs.mkdirSync("data/tweet-cache", { recursive: true });

  // Fetch VIX before scanning tickers
  console.log("📈 Fetching VIX...");
  const vix = await fetchVIX(process.env.FMP_API_KEY);
  if (vix) {
    console.log(`   VIX ${vix.value} — ${vix.label}: ${vix.advice}\n`);
  }

  const yesterday = loadYesterdayResults();
  const results   = [];

  for (const { ticker, name, type, sector, query } of WATCHLIST) {
    process.stdout.write(`  ${ticker.padEnd(6)} [${(type || "stock").toUpperCase()}] — `);

    const tweets = await fetchTweets(ticker, query);
    process.stdout.write(`${tweets.length} posts. Analyzing...`);

    const sentiment = await analyzeSentiment(
      ticker, name, type || "stock", sector || "",
      tweets, yesterday[ticker]
    );
    process.stdout.write(` ${sentiment.arrow} ${sentiment.signal}. Institutional...`);

    const institutional = await fetchInstitutionalData(ticker, type || "stock");
    process.stdout.write(` Analyst...`);

    const analyst = await fetchAnalystData(ticker, type || "stock", analystMap);
    process.stdout.write(` done\n`);


    // Composite: sentiment (60% * confidence) + trend (10%) + hf (8%) + insider (7%) + congress (6%) + offex (4%) + analyst (5%)
    const b = s => s === "bullish" ? 1 : s === "bearish" ? -1 : 0;
    const hfBonus       = b(institutional.hedgeFundSignal)  * 0.08;
    const insBonus      = b(institutional.insiderSignal)    * 0.07;
    const congBonus     = b(institutional.congressSignal)   * 0.06;
    const offBonus      = b(institutional.offExchangeSignal || "neutral") * 0.04;
    const analystBonus  = analyst.available ? (
      analyst.signal === "strong_upside"   ?  0.05 :
      analyst.signal === "upside"          ?  0.03 :
      analyst.signal === "strong_downside" ? -0.05 :
      analyst.signal === "downside"        ? -0.03 : 0
    ) : 0;

    const finalScore = parseFloat(
      Math.max(-1, Math.min(1,
        sentiment.compositeScore + hfBonus + insBonus + congBonus + offBonus + analystBonus
      )).toFixed(3)
    );

    const finalSignal = finalScore >=  0.5  ? "STRONG_BUY"
                      : finalScore >=  0.15 ? "BUY"
                      : finalScore <= -0.5  ? "STRONG_SELL"
                      : finalScore <= -0.15 ? "SELL"
                      : "NEUTRAL";

    results.push({ ...sentiment, institutional, analyst, compositeScore: finalScore, signal: finalSignal });
    await sleep(1200);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    tickerCount: results.length,
    version:     "9.0",
    vix,
    results,
  };

  fs.writeFileSync("data/results.json", JSON.stringify(output, null, 2));
  const dateStr = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(`data/history/${dateStr}.json`, JSON.stringify(output, null, 2));

  console.log("\n📊 Summary:");
  if (vix) console.log(`   VIX ${vix.value} — ${vix.label}`);
  results.forEach(r => {
    const tag      = r.type === "etf" ? "[ETF]" : "[STK]";
    const instStr  = r.institutional?.available ? `inst:${r.institutional.instSentiment}` : "inst:inactive";
    const analystStr = r.analyst?.available ? `target:${r.analyst.upsidePct > 0 ? "+" : ""}${r.analyst.upsidePct}%` : "target:N/A";
    console.log(`  ${tag} ${r.ticker.padEnd(6)} ${r.arrow} ${r.signal.padEnd(12)} score:${r.compositeScore.toFixed(2)}  ${instStr}  ${analystStr}`);
  });
  console.log(`\n✅ Done — ${results.length} tickers processed\n`);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
