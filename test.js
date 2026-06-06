#!/usr/bin/env node
/**
 * ALA VPS — Local test script
 * 
 * Usage:
 *   node test.js open         → fires fake /signal open (default: XAUUSD)
 *   node test.js close        → fires fake /signal close
 *   node test.js both         → fires open then close
 * 
 * Options:
 *   SYMBOL=BTCUSDT node test.js open  → use BTC symbol + values
 *   BASE_URL=https://... node test.js open
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SECRET   = process.env.WEBHOOK_SECRET || "";
const SYMBOL   = process.env.SYMBOL || "XAUUSD";

const isBTC = SYMBOL.includes("BTC");

const headers = {
  "Content-Type": "application/json",
  ...(SECRET ? { "X-ALA-Secret": SECRET } : {}),
};

const fakeOpen = isBTC ? {
  symbol:    "BTCUSDT",
  interval:  "3",
  action:    "1",
  entry:     "61000.00",
  sl:        "60500.00",
  tp:        "62500.00",
  exit:      "61000.00",
  timestamp: Date.now().toString(),
} : {
  symbol:    "XAUUSD",
  interval:  "5",
  action:    "1",
  entry:     "2345.50",
  sl:        "2340.00",
  tp:        "2356.00",
  exit:      "2345.50",
  session:   "London",
  timestamp: new Date().toISOString(),
};

const fakeClose = isBTC ? {
  symbol:    "BTCUSDT",
  interval:  "3",
  action:    "2",
  entry:     "61000.00",
  sl:        "60500.00",
  tp:        "62500.00",
  exit:      "62500.00",
  timestamp: Date.now().toString(),
} : {
  symbol:    "XAUUSD",
  interval:  "5",
  action:    "3",
  entry:     "2345.50",
  sl:        "2340.00",
  tp:        "2356.00",
  exit:      "2340.00",
  session:   "London",
  timestamp: new Date().toISOString(),
};

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log(`\n[${path}] ${res.status}`);
  console.log(JSON.stringify(json, null, 2));
}

const cmd = process.argv[2] || "both";

(async () => {
  if (cmd === "open" || cmd === "both") await post("/signal", fakeOpen);
  if (cmd === "close" || cmd === "both") await post("/signal", fakeClose);
})();
