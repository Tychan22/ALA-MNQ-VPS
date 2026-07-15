require("dotenv").config();
const path_temp = require("path");
const fs_temp   = require("fs");
const _configPath = path_temp.join(__dirname, "config.json");
const pairConfig  = fs_temp.existsSync(_configPath) ? JSON.parse(fs_temp.readFileSync(_configPath, "utf8")).pairs || {} : {};
function getPairConfig(symbol) {
  const key = Object.keys(pairConfig).find(k => symbol && (symbol.includes(k) || k.includes(symbol)));
  return key ? pairConfig[key] : null;
}
const express  = require("express");
const axios    = require("axios");
const fs       = require("fs");
const path     = require("path");
const FormData = require("form-data");

const app  = express();
app.use(express.json());
app.use(require("cors")());

const PORT             = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const CHART_IMG_KEY      = process.env.CHART_IMG_KEY;
const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET;

// ─── FILE STORAGE ─────────────────────────────────────────────────────────────
const DATA_DIR     = process.env.DATA_DIR || path.join(__dirname);
const TRADES_FILE  = path.join(DATA_DIR, "trades.json");
const SCREENS_DIR    = path.join(DATA_DIR, "screenshots");
const SETTINGS_FILE  = path.join(DATA_DIR, "settings.json");

function readSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch { return {}; }
}
function writeSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

if (!fs.existsSync(SCREENS_DIR)) fs.mkdirSync(SCREENS_DIR, { recursive: true });

function readTrades() {
  try {
    if (!fs.existsSync(TRADES_FILE)) return [];
    return JSON.parse(fs.readFileSync(TRADES_FILE, "utf8"));
  } catch { return []; }
}

function writeTrades(trades) {
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}
function getTradingDate() {
  // Trading day schedule (EST):
  // Sun 6PM - Mon 4PM = Monday
  // Mon 6PM - Tue 4PM = Tuesday
  // Tue 6PM - Wed 4PM = Wednesday
  // Wed 6PM - Thu 4PM = Thursday
  // Thu 6PM - Fri 4PM = Friday
  // Fri 4PM - Sun 6PM = market closed
  const now = new Date();
  const estStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const estDate = new Date(estStr);
  const estHour = estDate.getHours();
  const estDay  = estDate.getDay(); // 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat

  // Trading day labels by current EST day + hour:
  // Sun any = Monday (market opened Sun 6PM)
  // Mon 0-15 = Monday (still in Mon trading day that opened Sun 6PM)
  // Mon 16+ = Tuesday (Mon 4PM cutoff passed, now Tue trading day)
  // Tue 0-15 = Tuesday
  // Tue 16+ = Wednesday
  // etc.

  if (estDay === 0) {
    // Sunday always = Monday trading day
    estDate.setDate(estDate.getDate() + 1);
  } else if (estHour >= 16) {
    // After 4PM cutoff = next trading day
    estDate.setDate(estDate.getDate() + 1);
  }
  // Before 4PM = same calendar day = correct trading day already

  const y = estDate.getFullYear();
  const m = String(estDate.getMonth() + 1).padStart(2, "0");
  const d = String(estDate.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}


// ─── PENDING OPEN TRADES (in-memory, matched on close) ───────────────────────
// key = symbol, value = { entry, sl, tp, session, ts, imgOpen }
const pending = {};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function getChartBuffer(symbol = "XAUUSD") {
  if (!CHART_IMG_KEY) return null;
  const cfg = getPairConfig(symbol);
  const layoutId   = cfg ? cfg.layoutId   : "elAti8iP";
  const chartSym   = cfg ? cfg.chartSymbol : "OANDA:XAUUSD";
  const interval   = cfg ? cfg.interval    : "5m";
  try {
    const res = await axios.post(
      "https://api.chart-img.com/v2/tradingview/layout-chart/" + layoutId,
      { symbol: chartSym, interval },
      { headers: { "x-api-key": CHART_IMG_KEY, "content-type": "application/json" }, responseType: "arraybuffer" }
    );
    return Buffer.from(res.data);
  } catch (err) {
    console.error("[CHART-IMG] Failed:", err.message);
    return null;
  }
}

function saveScreenshot(buffer, label) {
  const fname = `${label}_${Date.now()}.png`;
  const fpath = path.join(SCREENS_DIR, fname);
  fs.writeFileSync(fpath, buffer);
  return `/screenshots/${fname}`;
}

async function sendTelegram(text) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML",
  });
}

async function sendTelegramPhoto(caption, buffer) {
  const form = new FormData();
  form.append("chat_id", TELEGRAM_CHAT_ID);
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("photo", buffer, { filename: "chart.png", contentType: "image/png" });
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
    form, { headers: form.getHeaders() }
  );
}

// ─── LUNE FORWARD ─────────────────────────────────────────────────────────────
async function forwardToLune(payload) {
  const settings = readSettings();
  if (!settings.autotrading || !settings.luneWebhook) return;
  try {
    await axios.post(settings.luneWebhook, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 5000,
    });
    console.log("[LUNE] Forwarded:", payload.action);
  } catch (err) {
    console.error("[LUNE] Forward failed:", err.message);
  }
}

function fmtPnl(val) {
  const n = parseFloat(val);
  return isNaN(n) ? "—" : `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`;
}

function authCheck(req, res) {
  if (!WEBHOOK_SECRET) return true;
  if (req.headers["x-ala-secret"] !== WEBHOOK_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ─── OPEN HANDLER ─────────────────────────────────────────────────────────────
async function handleOpen(req, res) {
  const { symbol = "XAUUSD", interval = "5", entry, sl, tp, tp1, session, timestamp, risk, direction = "LONG" } = req.body;
  console.log("[OPEN]", req.body);

  const tsNum = parseInt(timestamp);
  const tsDate = timestamp
    ? (tsNum > 1e12 ? new Date(tsNum) : new Date(timestamp))
    : new Date();
  const time = tsDate.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

  const rr = entry && sl && tp
    ? (Math.abs(parseFloat(tp) - parseFloat(entry)) / Math.abs(parseFloat(entry) - parseFloat(sl))).toFixed(2)
    : "—";

  const msg = [
    `🟢 <b>ALA SIGNAL — LONG ${symbol}</b>`,
    ``,
    `📍 <b>Entry:</b>  ${entry ?? "—"}`,
    `🛑 <b>SL:</b>     ${sl ?? "—"}`,
    `🎯 <b>TP:</b>     ${tp ?? "—"}`,
    `📐 <b>R:R:</b>    1:${rr}`,
    ``,
    `⏱  <b>Time:</b>  ${time} EST`,
  ].join("\n");

  try {
    // Store pending FIRST before anything else
    if (pending[symbol]) {
      console.log(`[OPEN] Updated signal for ${symbol} — replacing pending with new entry`);
    }
    pending[symbol] = {
      symbol, entry, sl, tp, tp1,
      session: session || "—",
      date: getTradingDate(),
      ts: Date.now(),
      imgOpen: null,
      risk: risk || null,
      direction: direction || "LONG",
    };

    // Respond to TradingView immediately
    res.json({ ok: true, action: "open", symbol });

    // Then grab screenshot and send Telegram async
    const chartBuffer = await getChartBuffer(symbol);
    let imgOpen = null;
    if (chartBuffer) {
      imgOpen = saveScreenshot(chartBuffer, `open_${symbol}`);
      await sendTelegramPhoto(msg, chartBuffer);
    } else {
      await sendTelegram(msg);
    }
    if (pending[symbol]) pending[symbol].imgOpen = imgOpen;
    console.log(`[OPEN] Pending trade stored for ${symbol}, imgOpen: ${imgOpen}`);
  } catch (err) {
    console.error("[OPEN] Error:", err.message);
  }
}

// ─── CLOSE HANDLER ────────────────────────────────────────────────────────────
async function handleClose(req, res, code) {
  const { symbol = "XAUUSD", entry, exit, tp, sl, session, timestamp, rr: payloadRR } = req.body;
  const isWin  = code === 2;
  const result = isWin ? "WIN" : "LOSS";
  console.log("[CLOSE]", req.body);

  const tsNum = parseInt(timestamp);
  const tsDate = timestamp
    ? (tsNum > 1e12 ? new Date(tsNum) : new Date(timestamp))
    : new Date();
  const time = tsDate.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

  const exitPrice = exit ?? (isWin ? tp : sl) ?? "—";
  const pnlStr    = entry && exitPrice ? fmtPnl(parseFloat(exitPrice) - parseFloat(entry)) : "—";
  const emoji     = isWin ? "✅" : "❌";

  const msg = [
    `${emoji} <b>ALA CLOSED — ${result} ${symbol}</b>`,
    ``,
    `📍 <b>Entry:</b>  ${entry ?? "—"}`,
    `🚪 <b>Exit:</b>   ${exitPrice}`,
    `💰 <b>PnL:</b>    ${pnlStr} pts`,
    ``,
    `🕒 <b>Time:</b>   ${time} EST`,
  ].join("\n");

  try {
    // Grab close screenshot
    const chartBuffer = await getChartBuffer(symbol);
    let imgClose = null;
    if (chartBuffer) {
      imgClose = saveScreenshot(chartBuffer, `close_${symbol}`);
      await sendTelegramPhoto(msg, chartBuffer);
    } else {
      await sendTelegram(msg);
    }

    // Match to pending open trade
    const openTrade = pending[symbol] || null;
    if (!openTrade) {
      console.log(`[CLOSE] No pending trade found for ${symbol} — orphan close, logging with flag`);
    }
    const imgOpen = openTrade ? openTrade.imgOpen : null;
    if (pending[symbol]) delete pending[symbol];

    // Build trade record
    const pen    = openTrade;
    const tradeEntry = entry || pen.entry;
    const tradeSL    = sl    || pen.sl;
    const tradeTP    = tp    || pen.tp;
    const rr         = payloadRR && payloadRR !== 'NaN'
      ? parseFloat(payloadRR).toFixed(2)
      : (tradeEntry && tradeSL && tradeTP
        ? (Math.abs(parseFloat(tradeTP) - parseFloat(tradeEntry)) / Math.abs(parseFloat(tradeEntry) - parseFloat(tradeSL))).toFixed(2)
        : null);

    const trade = {
      symbol,
      date:    pen.date || new Date().toISOString().split("T")[0],
      session: session  || pen.session || "—",
      entry:   tradeEntry,
      sl:      tradeSL,
      tp:      tradeTP,
      exit:    exitPrice,
      result,
      rr,
      imgOpen,
      imgClose,
      risk:    pen.risk || null,
      direction: pen.direction || "LONG",
      ts:      pen.ts || Date.now(),
      orphan:  !openTrade,
      tsClose: Date.now(),
    };

    const trades = readTrades();
    trades.push(trade);
    writeTrades(trades);

    console.log(`[CLOSE] Trade logged. imgOpen: ${imgOpen} imgClose: ${imgClose}`);
  } catch (err) {
    console.error("[CLOSE] Error:", err.message);
  }
}


// ─── PARTIAL HANDLER (action 4 — TP1 hit, SL moved to BE) ───────────────────
async function handlePartial(req, res) {
  const { symbol = "XAUUSD", entry, sl, tp, tp1, timestamp } = req.body;
  console.log("[PARTIAL]", req.body);

  const tsNum  = parseInt(timestamp);
  const tsDate = timestamp ? (tsNum > 1e12 ? new Date(tsNum) : new Date(timestamp)) : new Date();
  const time   = tsDate.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

  const msg = [
    `⚡ <b>ALA PARTIAL — TP1 HIT ${symbol}</b>`,
    ``,
    `✅ <b>1R secured</b> — SL moved to BE`,
    `📍 <b>Entry:</b>  ${entry ?? "—"}`,
    `🎯 <b>TP1:</b>    ${tp1 ?? "—"}`,
    `🎯 <b>TP2:</b>    ${tp ?? "—"}`,
    ``,
    `⏱  <b>Time:</b>  ${time} EST`,
  ].join("\n");

  try {
    // Update pending SL to entry (BE)
    if (pending[symbol]) {
      pending[symbol].sl = entry;
      pending[symbol].tp1Hit = true;
      console.log(`[PARTIAL] Updated pending ${symbol} SL to BE: ${entry}`);
    }
    res.json({ ok: true, action: "partial", symbol });
    await sendTelegram(msg);
  } catch (err) {
    console.error("[PARTIAL] Error:", err.message);
  }
}

// ─── BE HANDLER (action 5 — stopped at breakeven after partial) ──────────────
async function handleBE(req, res) {
  const { symbol = "XAUUSD", entry, exit, tp, sl, timestamp } = req.body;
  console.log("[BE]", req.body);

  const tsNum  = parseInt(timestamp);
  const tsDate = timestamp ? (tsNum > 1e12 ? new Date(tsNum) : new Date(timestamp)) : new Date();
  const time   = tsDate.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

  const msg = [
    `⚪ <b>ALA CLOSED — BE ${symbol}</b>`,
    ``,
    `📍 <b>Entry:</b>  ${entry ?? "—"}`,
    `🚪 <b>Exit:</b>   ${exit ?? entry ?? "—"}`,
    `💰 <b>PnL:</b>    +$${pen.risk ? (parseFloat(pen.risk)/2).toFixed(0) : "—"} (1R from partial)`,
    ``,
    `🕒 <b>Time:</b>   ${time} EST`,
  ].join("\n");

  try {
    const chartBuffer = await getChartBuffer(symbol);
    let imgClose = null;
    if (chartBuffer) {
      imgClose = saveScreenshot(chartBuffer, `close_${symbol}`);
      await sendTelegramPhoto(msg, chartBuffer);
    } else {
      await sendTelegram(msg);
    }

    const openTrade  = pending[symbol] || null;
    const imgOpen    = openTrade ? openTrade.imgOpen : null;
    if (pending[symbol]) delete pending[symbol];

    const pen        = openTrade || {};
    const tradeEntry = entry || pen.entry;
    const tradeSL    = sl    || pen.sl;
    const tradeTP    = tp    || pen.tp;
    const tradeRisk  = pen.risk || null;
    const rr         = 1; // BE = 1R achieved from partial

    const trade = {
      symbol,
      date:      pen.date || getTradingDate(),
      session:   pen.session || "—",
      entry:     tradeEntry,
      sl:        tradeSL,
      tp:        tradeTP,
      exit:      exit || tradeEntry,
      result:    "PARTIAL",
      rr,
      imgOpen,
      imgClose,
      risk:      tradeRisk,
      direction: pen.direction || "LONG",
      ts:        pen.ts || Date.now(),
      tsClose:   Date.now(),
      orphan:    !openTrade,
    };

    const trades = readTrades();
    trades.push(trade);
    writeTrades(trades);

    console.log(`[BE] Trade logged. imgOpen: ${imgOpen} imgClose: ${imgClose}`);
    res.json({ ok: true, action: "be", symbol });
  } catch (err) {
    console.error("[BE] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}


// ─── MNQ OPEN HANDLER ────────────────────────────────────────────────────────
async function handleMNQOpen(req, res) {
  const { symbol = "MNQ1!", type = "LONG", entry, sl, tp, risk, timestamp } = req.body;
  const direction = type.includes("SHORT") ? "SHORT" : "LONG";
  const signalType = type; // LONG, SHORT, BD_LONG, BD_SHORT
  console.log("[MNQ OPEN]", req.body);

  const tsNum  = parseInt(timestamp);
  const tsDate = timestamp ? (tsNum > 1e12 ? new Date(tsNum) : new Date(timestamp)) : new Date();
  const time   = tsDate.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

  const rr = entry && sl && tp
    ? (Math.abs(parseFloat(tp) - parseFloat(entry)) / Math.abs(parseFloat(entry) - parseFloat(sl))).toFixed(2)
    : "—";

  const dirEmoji = direction === "SHORT" ? "🔴" : "🟢";
  const msg = [
    `${dirEmoji} <b>MNQ SIGNAL — ${signalType}</b>`,
    ``,
    `📍 <b>Entry:</b>  ${entry ?? "—"}`,
    `🛑 <b>SL:</b>     ${sl ?? "—"}`,
    `🎯 <b>TP:</b>     ${tp ?? "—"}`,
    `📐 <b>R:R:</b>    1:${rr}`,
    ``,
    `⏱  <b>Time:</b>  ${time} EST`,
  ].join("\n");

  try {
    pending[symbol] = {
      symbol, entry, sl, tp,
      session: "NY",
      direction,
      date: getTradingDate(),
      ts: Date.now(),
      imgOpen: null,
      risk: risk || null,
    };

    res.json({ ok: true, action: "open", symbol, direction });

    // Forward to LUNE if autotrading enabled
    await forwardToLune({
      strategy_id: readSettings().luneStrategyId || "",
      action: direction === "SHORT" ? "ShortEntry" : "LongEntry",
      symbol, type, entry, sl, tp, risk, timestamp,
    });

    const chartBuffer = await getChartBuffer(symbol);
    let imgOpen = null;
    if (chartBuffer) {
      imgOpen = saveScreenshot(chartBuffer, `open_${symbol}`);
      await sendTelegramPhoto(msg, chartBuffer);
    } else {
      await sendTelegram(msg);
    }
    if (pending[symbol]) pending[symbol].imgOpen = imgOpen;
    console.log(`[MNQ OPEN] Pending stored for ${symbol}, direction: ${direction}, imgOpen: ${imgOpen}`);
  } catch (err) {
    console.error("[MNQ OPEN] Error:", err.message);
  }
}

// ─── MNQ CLOSE HANDLER ───────────────────────────────────────────────────────
async function handleMNQClose(req, res, isWin) {
  const { symbol = "MNQ1!", type = "LONG", exit, timestamp } = req.body;
  const result = isWin ? "WIN" : "LOSS";
  const direction = type.includes("SHORT") ? "SHORT" : "LONG";
  console.log(`[MNQ ${result}]`, req.body);

  const tsNum  = parseInt(timestamp);
  const tsDate = timestamp ? (tsNum > 1e12 ? new Date(tsNum) : new Date(timestamp)) : new Date();
  const time   = tsDate.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

  const emoji = isWin ? "✅" : "❌";
  const msg = [
    `${emoji} <b>MNQ CLOSED — ${result} ${direction}</b>`,
    ``,
    `🚪 <b>Exit:</b>   ${exit ?? "—"}`,
    ``,
    `🕒 <b>Time:</b>   ${time} EST`,
  ].join("\n");

  try {
    res.json({ ok: true, action: "close", result, symbol });

    // Forward exit to LUNE if autotrading enabled
    await forwardToLune({
      strategy_id: readSettings().luneStrategyId || "",
      action: direction === "SHORT" ? "ShortExit" : "LongExit",
      symbol, type, exit, timestamp, result,
    });

    const chartBuffer = await getChartBuffer(symbol);
    let imgClose = null;
    if (chartBuffer) {
      imgClose = saveScreenshot(chartBuffer, `close_${symbol}`);
      await sendTelegramPhoto(msg, chartBuffer);
    } else {
      await sendTelegram(msg);
    }

    const openTrade  = pending[symbol] || null;
    const imgOpen    = openTrade ? openTrade.imgOpen : null;
    if (pending[symbol]) delete pending[symbol];

    const pen = openTrade || {};
    const tradeEntry = pen.entry;
    const tradeSL    = pen.sl;
    const tradeTP    = pen.tp;
    const tradeRisk  = pen.risk;
    const rr = tradeEntry && tradeSL && tradeTP
      ? (Math.abs(parseFloat(tradeTP) - parseFloat(tradeEntry)) / Math.abs(parseFloat(tradeEntry) - parseFloat(tradeSL))).toFixed(2)
      : null;

    const trade = {
      symbol,
      date:      pen.date || getTradingDate(),
      session:   pen.session || "NY",
      entry:     tradeEntry,
      sl:        tradeSL,
      tp:        tradeTP,
      exit:      exit,
      result,
      rr,
      imgOpen,
      imgClose,
      risk:      tradeRisk,
      direction: pen.direction || direction,
      ts:        pen.ts || Date.now(),
      tsClose:   Date.now(),
      orphan:    !openTrade,
    };

    const trades = readTrades();
    trades.push(trade);
    writeTrades(trades);
    console.log(`[MNQ ${result}] Trade logged. imgOpen: ${imgOpen} imgClose: ${imgClose}`);
  } catch (err) {
    console.error(`[MNQ CLOSE] Error:`, err.message);
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ALA VPS online", version: "2.0.0" }));

// Serve screenshots statically
app.use("/screenshots", express.static(SCREENS_DIR));
app.use(express.static(path.join(__dirname, "public")));

// Unified webhook
app.post("/signal", async (req, res) => {
  if (!authCheck(req, res)) return;
  const { action, symbol } = req.body;
  console.log("[/signal] action:", action, "symbol:", symbol, "body:", JSON.stringify(req.body));

  // MNQ uses string actions: "entry", "tp", "sl"
  if (action === "entry") return handleMNQOpen(req, res);
  if (action === "tp")    return handleMNQClose(req, res, true);
  if (action === "sl")    return handleMNQClose(req, res, false);

  // Gold/BTC uses numeric action codes
  const code = parseInt(action);
  if (code === 2 || code === 3) return handleClose(req, res, code);
  if (code === 4) return handlePartial(req, res);
  if (code === 5) return handleBE(req, res);
  return handleOpen(req, res);
});

// Legacy
app.post("/signal/open",  async (req, res) => { if (!authCheck(req, res)) return; return handleOpen(req, res); });
app.post("/signal/close", async (req, res) => { if (!authCheck(req, res)) return; return handleClose(req, res, 2); });

// Trade log endpoints
app.get("/trades", (req, res) => res.json(readTrades()));
app.post("/log", (req, res) => {
  const trade  = { ...req.body, ts: req.body.ts || Date.now() };
  const trades = readTrades();
  trades.push(trade);
  writeTrades(trades);
  res.json({ ok: true, total: trades.length });
});


// DELETE /trades/:index — remove a single trade by index
app.delete("/trades/:index", (req, res) => {
  const i = parseInt(req.params.index);
  const trades = readTrades();
  if (isNaN(i) || i < 0 || i >= trades.length) {
    return res.status(404).json({ ok: false, error: "Trade not found" });
  }
  trades.splice(i, 1);
  writeTrades(trades);
  res.json({ ok: true, total: trades.length });
});

// ─── HERMES — AI ANALYSIS ─────────────────────────────────────────────────────
const Anthropic = require("@anthropic-ai/sdk");
const REPORTS_FILE = path.join(DATA_DIR, "hermes-reports.json");

function readReports() {
  try {
    if (!fs.existsSync(REPORTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(REPORTS_FILE, "utf8"));
  } catch { return []; }
}

function saveReport(report) {
  const reports = readReports();
  reports.push(report);
  fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2));
}

function computeBreakdown(closed, key) {
  const groups = {};
  closed.forEach(t => {
    const k = t[key] || "—";
    if (!groups[k]) groups[k] = { trades: 0, wins: 0 };
    groups[k].trades++;
    if (t.result === "WIN") groups[k].wins++;
  });
  return Object.entries(groups).map(([k, v]) => ({
    [key === "direction" ? "setup" : "session"]: k,
    trades: v.trades,
    winRate: v.trades ? (v.wins / v.trades) * 100 : 0,
  }));
}

const HERMES_TOOL = {
  name: "hermes_report",
  description: "Structured trading pattern analysis report",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "2-4 paragraph narrative analysis in plain language" },
      flags: {
        type: "array",
        minItems: 1,
        description: "REQUIRED — do not leave empty. Extract every distinct pattern, bias, or risk called out in your summary into its own flag object here. If your summary mentions a setup or session performing well below breakeven, that is a critical flag. If it mentions a directional bias or a concerning-but-not-alarming pattern, that is a warning or insight flag.",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["critical", "warning", "insight"] },
            setup: { type: "string", description: "which setup/direction this flag applies to, if any" },
            title: { type: "string" },
            detail: { type: "string" },
            stat: { type: "string", description: "short stat callout, e.g. '10.4% WR' or '88% LONG bias'" },
          },
          required: ["severity", "title", "detail"],
        },
      },
      evidence: {
        type: "array",
        minItems: 1,
        description: "REQUIRED — do not leave empty. For every specific trade index you referenced by number in your summary (e.g. trades you called out as [0], [4], [9], etc.), add one entry here with that tradeIndex and a one-sentence note on why it's evidence. Pull directly from the trade indices you already cited in your prose — do not leave this array empty just because the reasoning is in the summary text.",
        items: {
          type: "object",
          properties: {
            tradeIndex: { type: "integer", description: "0-based index into the TRADE DATA array" },
            note: { type: "string", description: "why this trade is evidence, one sentence" },
          },
          required: ["tradeIndex", "note"],
        },
      },
    },
    required: ["summary", "flags", "evidence"],
  },
};

async function runHermesAnalysis(focusPrompt = null) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const trades = readTrades();
  const closed = trades.filter(t => t.result === "WIN" || t.result === "LOSS" || t.result === "PARTIAL");

  if (closed.length === 0) return null;

  const wins = closed.filter(t => t.result === "WIN").length;
  const losses = closed.filter(t => t.result === "LOSS").length;
  const wr = (wins / closed.length) * 100;
  const totalPnl = closed.reduce((s, t) => s + (t.pnl || (t.result === "WIN" ? parseFloat(t.risk || 0) * parseFloat(t.rr || 2) : -(parseFloat(t.risk || 0)))), 0);

  const bySetup = computeBreakdown(closed, "direction");
  const bySession = computeBreakdown(closed, "session");

  const content = [];
  content.push({
    type: "text",
    text: `You are Hermes, an AI trading analyst for ALA (Autonomous Learning Algorithm) — a MNQ futures spotter system.

TRADE SUMMARY:
- Total closed trades: ${closed.length}
- Wins: ${wins} | Losses: ${losses}
- Win rate: ${wr.toFixed(1)}% (breakeven at 2:1 RR is 33.4%)
- Estimated total PnL: $${totalPnl.toFixed(0)}
- Instrument: MNQ1! (Micro Nasdaq futures), 5-minute chart
- Setup types: LONG, SHORT, BD_LONG (breakout long), BD_SHORT (breakdown short)
- Risk per trade: $400, Target: 2:1 RR ($800 win / $400 loss)

BY SETUP: ${JSON.stringify(bySetup)}
BY SESSION: ${JSON.stringify(bySession)}

TRADE DATA (JSON, indexed — use these indices for evidence.tradeIndex):
${JSON.stringify(closed.map((t, i) => ({
  index: i,
  date: t.date,
  session: t.session,
  direction: t.direction,
  result: t.result,
  entry: t.entry,
  sl: t.sl,
  tp: t.tp,
  exit: t.exit,
  rr: t.rr,
  risk: t.risk,
  hasOpenChart: !!t.imgOpen,
  hasCloseChart: !!t.imgClose,
})), null, 2)}

${focusPrompt
  ? `SPECIFIC FOCUS: ${focusPrompt}`
  : `ANALYSIS REQUESTED:
1. Pattern recognition — what do the losing trades have in common? (direction, session, setup type, timing)
2. What are the winning trades doing differently?
3. Looking at the chart screenshots provided, identify any visual patterns (wick size, EMA position, candle structure) that correlate with wins vs losses
4. What 1-2 specific filters would most improve win rate based on this data?
5. Run a basic Monte Carlo assessment — at current win rate + RR, what is the probability of hitting a 5% prop firm drawdown limit over the next 20 trades? Mention this in the summary, not as a flag.

Call the hermes_report tool with your findings.

IMPORTANT — do not put your findings only in the summary text. For every distinct pattern you describe in the summary, also add a corresponding entry in the flags array, and for every specific trade you reference by index number (e.g. "[4]", "[9]"), also add a corresponding entry in the evidence array with that tradeIndex. The flags and evidence arrays must not be empty if the summary discusses specific patterns or trades — extract them out into the structured fields as well as writing about them in prose.

Flag severity: "critical" for setups/sessions with WR well below breakeven or clear structural problems, "warning" for concerning-but-not-alarming patterns, "insight" for neutral observations worth noting. Aim for 3-6 flags and 3-6 evidence entries on a typical run.`
}`
  });

  let imgCount = 0;
  for (let i = 0; i < closed.length; i++) {
    const trade = closed[i];
    const label = `[${i}] ${trade.date} ${trade.direction} → ${trade.result}`;

    if (trade.imgOpen) {
      const fpath = path.join(DATA_DIR, trade.imgOpen.replace(/^\//, ""));
      if (fs.existsSync(fpath)) {
        try {
          const b64 = fs.readFileSync(fpath).toString("base64");
          content.push({ type: "text", text: `ENTRY chart — ${label}:` });
          content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } });
          imgCount++;
        } catch {}
      }
    }

    if (trade.imgClose) {
      const fpath = path.join(DATA_DIR, trade.imgClose.replace(/^\//, ""));
      if (fs.existsSync(fpath)) {
        try {
          const b64 = fs.readFileSync(fpath).toString("base64");
          content.push({ type: "text", text: `EXIT chart — ${label}:` });
          content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } });
          imgCount++;
        } catch {}
      }
    }
  }

  console.log(`[HERMES] Sending ${closed.length} trades + ${imgCount} screenshots to Claude`);

  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 2048,
    tools: [HERMES_TOOL],
    tool_choice: { type: "tool", name: "hermes_report" },
    messages: [{ role: "user", content }],
  });

  const toolBlock = response.content.find(b => b.type === "tool_use");
  if (!toolBlock) throw new Error("Hermes did not return a structured report");

  const parsed = toolBlock.input;

  let evidenceSource = parsed.evidence || [];

  // Fallback: if Hermes cited specific trade indices inside its flags (e.g. "[4]", "[9]")
  // but left the evidence array empty, extract those indices deterministically instead
  // of relying on the model to have also copied them into evidence.
  if (evidenceSource.length === 0 && (parsed.flags || []).length > 0) {
    const cited = new Map(); // tradeIndex -> note
    for (const f of parsed.flags) {
      const text = `${f.title || ""} ${f.detail || ""}`;
      const matches = text.matchAll(/\[(\d+)\]/g);
      for (const m of matches) {
        const idx = parseInt(m[1], 10);
        if (!cited.has(idx)) cited.set(idx, `Referenced in flag: ${f.title || "untitled"}`);
      }
    }
    evidenceSource = Array.from(cited.entries()).map(([tradeIndex, note]) => ({ tradeIndex, note }));
    if (evidenceSource.length > 0) {
      console.log(`[HERMES] Evidence array was empty — backfilled ${evidenceSource.length} trades cited in flags`);
    }
  }

  const evidence = evidenceSource
    .map(e => {
      const t = closed[e.tradeIndex];
      if (!t) return null;
      return {
        imgOpen: t.imgOpen || null,
        imgClose: t.imgClose || null,
        setup: t.direction,
        result: t.result,
        note: e.note,
      };
    })
    .filter(Boolean);

  const report = {
    ts: Date.now(),
    tradesAnalyzed: closed.length,
    winRate: wr,
    summary: parsed.summary,
    flags: parsed.flags || [],
    bySetup,
    bySession,
    evidence,
  };

  saveReport(report);
  return report;
}

// POST /hermes/analyze — on-demand analysis with optional focus
app.post("/hermes/analyze", async (req, res) => {
  try {
    const { focus } = req.body;
    console.log("[HERMES] Analysis requested, focus:", focus || "general");
    const report = await runHermesAnalysis(focus || null);
    if (!report) return res.status(400).json({ ok: false, error: "No closed trades to analyze yet." });
    res.json(report);
  } catch (err) {
    console.error("[HERMES] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /hermes/analyze — quick trigger from browser/dashboard
app.get("/hermes/analyze", async (req, res) => {
  try {
    const report = await runHermesAnalysis(req.query.focus || null);
    if (!report) return res.status(400).json({ ok: false, error: "No closed trades to analyze yet." });
    res.json(report);
  } catch (err) {
    console.error("[HERMES] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /hermes/reports — full report history, newest first
app.get("/hermes/reports", (req, res) => {
  const reports = readReports().sort((a, b) => b.ts - a.ts);
  res.json(reports);
});

// DELETE /hermes/reports/:index — remove a single report by index
// NOTE: index here refers to position in the array as stored on disk (oldest-first,
// same order readReports() returns before sorting). The frontend sends the ts instead
// to avoid index-drift from the sort, see route below.
app.delete("/hermes/reports/:ts", (req, res) => {
  const ts = parseInt(req.params.ts, 10);
  const reports = readReports();
  const idx = reports.findIndex(r => r.ts === ts);
  if (idx === -1) {
    return res.status(404).json({ ok: false, error: "Report not found" });
  }
  reports.splice(idx, 1);
  fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2));
  res.json({ ok: true, total: reports.length });
});

// ─── SETTINGS ENDPOINTS ───────────────────────────────────────────────────────
app.get("/settings", (req, res) => res.json(readSettings()));
app.post("/settings", (req, res) => {
  const current = readSettings();
  const updated = { ...current, ...req.body };
  writeSettings(updated);
  console.log("[SETTINGS] Updated:", updated);
  res.json({ ok: true, settings: updated });
});

app.listen(PORT, () => console.log(`✅ ALA VPS listening on port ${PORT}`));
