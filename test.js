#!/usr/bin/env node
/**
 * ALA VPS — Local test script
 * 
 * Usage:
 *   node test.js open      → fires a fake /signal/open
 *   node test.js close     → fires a fake /signal/close
 *   node test.js both      → fires open then close
 * 
 * Set BASE_URL to your Railway URL once deployed.
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SECRET   = process.env.WEBHOOK_SECRET || "";

const headers = {
  "Content-Type": "application/json",
  ...(SECRET ? { "X-ALA-Secret": SECRET } : {}),
};

const fakeOpen = {
  symbol:    "XAUUSD",
  interval:  "5",
  entry:     "2345.50",
  sl:        "2340.00",
  tp:        "2356.00",
  session:   "London",
  timestamp: new Date().toISOString(),
};

const fakeClose = {
  symbol:    "XAUUSD",
  entry:     "2345.50",
  exit:      "2356.00",
  pnl:       "210.00",
  result:    "WIN",
  session:   "London",
  duration:  "14m",
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
  if (cmd === "open" || cmd === "both") await post("/signal/open", fakeOpen);
  if (cmd === "close" || cmd === "both") await post("/signal/close", fakeClose);
})();
