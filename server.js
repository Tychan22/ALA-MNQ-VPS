require("dotenv").config();
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
const TRADES_FILE  = path.join(__dirname, "trades.json");
const SCREENS_DIR  = path.join(__dirname, "screenshots");

if (!fs.existsSync(SCREENS_DIR)) fs.mkdirSync(SCREENS_DIR);

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
  const layoutId = symbol.includes("BTC") ? "73EEecm3" : "elAti8iP";
  try {
    const res = await axios.post(
      "https://api.chart-img.com/v2/tradingview/layout-chart/" + layoutId,
      { symbol: "OANDA:XAUUSD", interval: "5m" },
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
  const { symbol = "XAUUSD", interval = "5", entry, sl, tp, session, timestamp } = req.body;
  console.log("[OPEN]", req.body);

  const time = timestamp
    ? new Date(timestamp).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false })
    : new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

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
    const chartBuffer = await getChartBuffer(symbol);

    // Save open screenshot
    let imgOpen = null;
    if (chartBuffer) {
      imgOpen = saveScreenshot(chartBuffer, `open_${symbol}`);
      await sendTelegramPhoto(msg, chartBuffer);
    } else {
      await sendTelegram(msg);
    }

    // Store pending trade — matched on close
    pending[symbol] = {
      symbol, entry, sl, tp,
      session: session || "—",
      date: getTradingDate(),
      ts: Date.now(),
      imgOpen,
    };

    console.log(`[OPEN] Pending trade stored for ${symbol}, imgOpen: ${imgOpen}`);
    res.json({ ok: true, action: "open", symbol });
  } catch (err) {
    console.error("[OPEN] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}

// ─── CLOSE HANDLER ────────────────────────────────────────────────────────────
async function handleClose(req, res, code) {
  const { symbol = "XAUUSD", entry, exit, tp, sl, session, timestamp } = req.body;
  const isWin  = code === 2;
  const result = isWin ? "WIN" : "LOSS";
  console.log("[CLOSE]", req.body);

  const time = timestamp
    ? new Date(timestamp).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false })
    : new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });

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
    const openTrade = pending[symbol] || {};
    const imgOpen   = openTrade.imgOpen || null;
    delete pending[symbol];

    // Build trade record
    const pen    = openTrade;
    const tradeEntry = entry || pen.entry;
    const tradeSL    = sl    || pen.sl;
    const tradeTP    = tp    || pen.tp;
    const rr         = tradeEntry && tradeSL && tradeTP
      ? (Math.abs(parseFloat(tradeTP) - parseFloat(tradeEntry)) / Math.abs(parseFloat(tradeEntry) - parseFloat(tradeSL))).toFixed(2)
      : null;

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
      ts:      pen.ts || Date.now(),
      tsClose: Date.now(),
    };

    const trades = readTrades();
    trades.push(trade);
    writeTrades(trades);

    console.log(`[CLOSE] Trade logged. imgOpen: ${imgOpen} imgClose: ${imgClose}`);
    res.json({ ok: true, action: "close", result, symbol });
  } catch (err) {
    console.error("[CLOSE] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
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
  const raw  = req.body.action;
  const code = parseInt(raw);
  console.log("[/signal] action raw:", raw, "parsed:", code, "body:", JSON.stringify(req.body));
  if (code === 2 || code === 3) return handleClose(req, res, code);
  // Default to open for action=1, NaN, undefined, or any unrecognized value
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

app.listen(PORT, () => console.log(`✅ ALA VPS listening on port ${PORT}`));
