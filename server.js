const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 8002);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const MINERS_FILE = path.join(DATA_DIR, "miners.json");

const CKPOOL_HOSTS = new Set([
  "solo.ckpool.org",
  "eusolo.ckpool.org",
  "sgsolo.ckpool.org",
  "ausolo.ckpool.org"
]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function fetchText(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "accept": "application/json,text/plain,*/*",
        "user-agent": "coin-watch/1.0"
      }
    }, (upstream) => {
      let data = "";
      upstream.setEncoding("utf8");
      upstream.on("data", (chunk) => {
        data += chunk;
      });
      upstream.on("end", () => {
        resolve({
          statusCode: upstream.statusCode || 0,
          headers: upstream.headers,
          body: data
        });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Request timed out"));
    });
    req.on("error", reject);
  });
}

function normalizeMinerId(value) {
  return String(value || "")
    .trim()
    .replace(/^stratum\+tcp:\/\//i, "")
    .replace(/^https?:\/\//i, "")
    .split("/")
    .pop()
    .split(".")[0];
}

function isProbablyMinerId(value) {
  return /^[a-zA-Z0-9]{26,90}$/.test(value);
}

function normalizeMiner(miner) {
  const host = String(miner?.host || "solo.ckpool.org").trim();
  const address = normalizeMinerId(miner?.address);
  const name = String(miner?.name || "").trim().slice(0, 80);

  if (!CKPOOL_HOSTS.has(host) || !isProbablyMinerId(address)) {
    return null;
  }

  return {
    id: `${host}:${address}`,
    name: name || address,
    address,
    host
  };
}

async function readRequestBody(req, limitBytes = 100000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > limitBytes) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function readSavedMiners() {
  try {
    const content = await fsp.readFile(MINERS_FILE, "utf8");
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeMiner).filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeSavedMiners(miners) {
  const normalized = [];
  const seen = new Set();

  for (const miner of miners) {
    const next = normalizeMiner(miner);
    if (!next) {
      throw new Error("One or more miners are invalid. Check the address and region.");
    }
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    normalized.push(next);
  }

  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(MINERS_FILE, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

async function handleMinersApi(req, res) {
  if (req.method === "GET") {
    try {
      sendJson(res, 200, { miners: await readSavedMiners() });
    } catch (error) {
      sendJson(res, 500, { error: `Unable to read saved miners: ${error.message}` });
    }
    return;
  }

  if (req.method === "PUT") {
    try {
      const body = await readRequestBody(req);
      const payload = JSON.parse(body || "{}");
      if (!Array.isArray(payload.miners)) {
        sendJson(res, 400, { error: "Expected a miners array." });
        return;
      }
      sendJson(res, 200, { miners: await writeSavedMiners(payload.miners) });
    } catch (error) {
      sendJson(res, 400, { error: `Unable to save miners: ${error.message}` });
    }
    return;
  }

  sendJson(res, 405, { error: "Method not allowed." });
}

async function handleMinerApi(reqUrl, res) {
  const host = reqUrl.searchParams.get("host") || "solo.ckpool.org";
  const address = normalizeMinerId(reqUrl.searchParams.get("address"));

  if (!CKPOOL_HOSTS.has(host)) {
    sendJson(res, 400, { error: "Unsupported CKPool region." });
    return;
  }

  if (!isProbablyMinerId(address)) {
    sendJson(res, 400, { error: "Enter a Bitcoin address or CKPool username." });
    return;
  }

  try {
    const upstream = await fetchText(`https://${host}/users/${encodeURIComponent(address)}`);
    if (upstream.statusCode !== 200) {
      sendJson(res, upstream.statusCode, {
        error: `CKPool returned ${upstream.statusCode}. Check the address and region.`
      });
      return;
    }

    try {
      const payload = JSON.parse(upstream.body);
      sendJson(res, 200, {
        source: `https://${host}/users/${address}`,
        fetchedAt: Math.floor(Date.now() / 1000),
        data: payload
      });
    } catch {
      sendJson(res, 502, { error: "CKPool returned a response that was not JSON." });
    }
  } catch (error) {
    sendJson(res, 502, { error: `Unable to reach CKPool: ${error.message}` });
  }
}

async function handleDifficultyApi(res) {
  try {
    const upstream = await fetchText("https://blockchain.info/q/getdifficulty", 10000);
    const difficulty = Number(upstream.body);
    if (!Number.isFinite(difficulty) || difficulty <= 0) {
      sendJson(res, 502, { error: "Difficulty provider returned an invalid value." });
      return;
    }
    sendJson(res, 200, {
      difficulty,
      fetchedAt: Math.floor(Date.now() / 1000),
      source: "https://blockchain.info/q/getdifficulty"
    });
  } catch (error) {
    sendJson(res, 502, { error: `Unable to fetch Bitcoin difficulty: ${error.message}` });
  }
}

function serveStatic(reqUrl, res) {
  const requestedPath = reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (reqUrl.pathname === "/api/miners") {
    handleMinersApi(req, res);
    return;
  }

  if (reqUrl.pathname === "/api/miner") {
    handleMinerApi(reqUrl, res);
    return;
  }

  if (reqUrl.pathname === "/api/difficulty") {
    handleDifficultyApi(res);
    return;
  }

  serveStatic(reqUrl, res);
});

function listen(port, attemptsRemaining = 10) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attemptsRemaining > 0) {
      listen(port + 1, attemptsRemaining - 1);
      return;
    }

    console.error(`Unable to start Coin Watch: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(port, HOST, () => {
    const displayHost = HOST === "0.0.0.0" ? "localhost" : HOST;
    console.log(`Coin Watch is running at http://${displayHost}:${port}`);
  });
}

listen(PORT);
