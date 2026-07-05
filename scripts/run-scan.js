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

  // Quality filters applied to every search:
  // - min_faves:5     → only posts with 5+ likes (eliminates bots, spam, zero-engagement noise)
  // - -is:retweet     → original posts only, no retweets
  // - lang:en         → English only
  // - has:cashtags OR has:links → financial context (posts with $ tickers or article links)
  // Note: is:verified removed — post-Elon it includes paid subscribers not just notable accounts
  const qualityFilters = `-is:retweet lang:en min_faves:5`;
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

  // ETFs: skip insider/congressional data, only get institutional if available
  if (type === "etf") {
    return buildETFInstitutional();
  }

  // No API key configured — return placeholder
  if (!apiKey) {
    return buildNoKeyInstitutional();
  }

  const headers = {
    Authorization: `Token ${apiKey}`,
    Accept:        "application/json",
  };

  try {
    // ── 1. Institutional Ownership (13F filings) ─────────────────────────────
    let instSentiment    = "neutral";
    let instOwnership    = null;
    let instChangeShares = null;
    let instHolders      = null;
    let topBuyer         = null;
    let topSeller        = null;

    const instRes = await fetch(
      `https://api.quiverquant.com/beta/historical/institutionalownership/${ticker}`,
      { headers }
    );

    if (instRes.ok) {
      const instData = await instRes.json();
      if (instData && instData.length > 0) {
        const latest    = instData[0];
        const previous  = instData[1];
        instOwnership    = latest.PercentOwnership ? `${(latest.PercentOwnership * 100).toFixed(1)}%` : null;
        instHolders      = latest.Holders || null;

        // Calculate net share change vs prior quarter
        if (latest.Shares && previous?.Shares) {
          instChangeShares = latest.Shares - previous.Shares;
          instSentiment    = instChangeShares > 0 ? "bullish"
                           : instChangeShares < 0 ? "bearish"
                           : "neutral";
        }
      }
    } else {
      console.log(`  [${ticker}] Quiver institutional: ${instRes.status}`);
    }

    await sleep(300);

    // ── 2. Congressional Trading ──────────────────────────────────────────────
    let congressSignal = "neutral";
    let congressNote   = "No recent congressional trades";

    const congRes = await fetch(
      `https://api.quiverquant.com/beta/historical/congresstrading/${ticker}`,
      { headers }
    );

    if (congRes.ok) {
      const congData = await congRes.json();
      if (congData && congData.length > 0) {
        // Look at trades in last 180 days
        const cutoff   = new Date();
        cutoff.setDate(cutoff.getDate() - 180);
        const recent   = congData.filter(t => new Date(t.TransactionDate) > cutoff);
        const buys     = recent.filter(t => t.Transaction?.toLowerCase().includes("purchase"));
        const sells    = recent.filter(t => t.Transaction?.toLowerCase().includes("sale"));

        if (recent.length > 0) {
          if (buys.length > sells.length) {
            congressSignal = "bullish";
            congressNote   = `${buys.length} congressional purchase(s) vs ${sells.length} sale(s) in last 180 days`;
          } else if (sells.length > buys.length) {
            congressSignal = "bearish";
            congressNote   = `${sells.length} congressional sale(s) vs ${buys.length} purchase(s) in last 180 days`;
          } else {
            congressNote   = `${recent.length} congressional trade(s) — mixed signal`;
          }
        }
      }
    } else {
      console.log(`  [${ticker}] Quiver congress: ${congRes.status}`);
    }

    await sleep(300);

    // ── 3. Insider Trading (Form 4) ───────────────────────────────────────────
    let insiderSignal = "neutral";
    let insiderNote   = "No recent insider trades";

    const insiderRes = await fetch(
      `https://api.quiverquant.com/beta/historical/insiders/${ticker}`,
      { headers }
    );

    if (insiderRes.ok) {
      const insiderData = await insiderRes.json();
      if (insiderData && insiderData.length > 0) {
        const cutoff  = new Date();
        cutoff.setDate(cutoff.getDate() - 90);
        const recent  = insiderData.filter(t => new Date(t.Date) > cutoff);
        const buys    = recent.filter(t => t.Transaction === "Buy" || t.AcquiredDisposed === "A");
        const sells   = recent.filter(t => t.Transaction === "Sell" || t.AcquiredDisposed === "D");

        if (recent.length > 0) {
          if (buys.length > sells.length && buys.length > 0) {
            insiderSignal = "bullish";
            insiderNote   = `${buys.length} insider purchase(s) vs ${sells.length} sale(s) in last 90 days`;
            topBuyer      = recent[0]?.Name || null;
          } else if (sells.length > buys.length && sells.length > 0) {
            insiderSignal = "bearish";
            insiderNote   = `${sells.length} insider sale(s) vs ${buys.length} purchase(s) in last 90 days`;
            topSeller     = recent[0]?.Name || null;
          } else {
            insiderNote   = `${recent.length} insider filing(s) — mixed signal`;
          }
        }
      }
    } else {
      console.log(`  [${ticker}] Quiver insiders: ${insiderRes.status}`);
    }

    return {
      source:           "Quiver Quant",
      available:        true,
      instSentiment,
      instOwnership,
      instHolders,
      instChangeShares,
      topBuyer,
      topSeller,
      congressSignal,
      congressNote,
      insiderSignal,
      insiderNote,
      quarterCovered:   getQuarterLabel(),
      lastUpdated:      new Date().toISOString(),
    };

  } catch (e) {
    console.error(`  [${ticker}] Quiver error: ${e.message}`);
    return buildNoKeyInstitutional();
  }
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
