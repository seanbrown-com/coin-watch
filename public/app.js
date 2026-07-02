const STORAGE_KEY = "coinWatch.miners";
const REFRESH_SECONDS = 60;
const HASH_UNITS = {
  H: 1,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18
};

const state = {
  miners: [],
  results: new Map(),
  difficulty: null,
  refreshTimer: null,
  countdownTimer: null,
  nextRefreshAt: null,
  loaded: false
};

const elements = {
  form: document.querySelector("#minerForm"),
  list: document.querySelector("#minerList"),
  template: document.querySelector("#minerTemplate"),
  refreshNow: document.querySelector("#refreshNow"),
  refreshStatus: document.querySelector("#refreshStatus"),
  fleetHashrate: document.querySelector("#fleetHashrate"),
  fleetHashrateNote: document.querySelector("#fleetHashrateNote"),
  fleetWorkers: document.querySelector("#fleetWorkers"),
  fleetWorkersNote: document.querySelector("#fleetWorkersNote"),
  fleetProgress: document.querySelector("#fleetProgress"),
  fleetProgressNote: document.querySelector("#fleetProgressNote")
};

function loadLocalMiners() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

async function loadMiners() {
  try {
    const payload = await fetchJson("/api/miners");
    state.miners = Array.isArray(payload.miners) ? payload.miners : [];

    const localMiners = loadLocalMiners();
    if (!state.miners.length && localMiners.length) {
      state.miners = localMiners;
      await saveMiners();
    }
  } catch {
    state.miners = loadLocalMiners();
  } finally {
    state.loaded = true;
  }
}

async function saveMiners() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.miners));
  const response = await fetch("/api/miners", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ miners: state.miners })
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Unable to save miners.");
  }
  state.miners = Array.isArray(payload.miners) ? payload.miners : state.miners;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.miners));
}

function normalizeMinerAddress(value) {
  return String(value || "")
    .trim()
    .replace(/^stratum\+tcp:\/\//i, "")
    .replace(/^https?:\/\//i, "")
    .split("/")
    .pop()
    .split(".")[0];
}

function shortAddress(address) {
  if (address.length <= 18) return address;
  return `${address.slice(0, 10)}...${address.slice(-8)}`;
}

function regionName(host) {
  return {
    "solo.ckpool.org": "Americas",
    "eusolo.ckpool.org": "Europe / Africa",
    "sgsolo.ckpool.org": "Asia / Middle East",
    "ausolo.ckpool.org": "Oceania"
  }[host] || host;
}

function parseHashrate(value) {
  const match = String(value || "").trim().match(/^([\d.]+)\s*([KMGTPE]?)(?:H|h)?$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2] || "H";
  return Number.isFinite(amount) ? amount * HASH_UNITS[unit] : 0;
}

function formatHashrate(hashesPerSecond) {
  if (!hashesPerSecond) return "0 H/s";
  const units = [
    ["E", 1e18],
    ["P", 1e15],
    ["T", 1e12],
    ["G", 1e9],
    ["M", 1e6],
    ["K", 1e3]
  ];
  const unit = units.find(([, size]) => hashesPerSecond >= size);
  if (!unit) return `${Math.round(hashesPerSecond)} H/s`;
  return `${(hashesPerSecond / unit[1]).toFixed(2).replace(/\.00$/, "")} ${unit[0]}H/s`;
}

function formatNumber(value, maximumFractionDigits = 0) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value);
}

function formatCompact(value) {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 2
  }).format(value);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "--";
  if (value > 0 && value < 0.0001) return "<0.0001%";
  return `${value.toFixed(value < 1 ? 4 : 2)}%`;
}

function formatRelativeTime(epochSeconds) {
  if (!epochSeconds) return "No shares yet";
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - epochSeconds));
  if (seconds < 60) return "just now";
  const units = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60]
  ];
  const [unit, size] = units.find(([, amount]) => seconds >= amount);
  const value = Math.floor(seconds / size);
  return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
}

function expectedTime(hashrate, difficulty) {
  if (!hashrate || !difficulty) return null;
  const seconds = difficulty * 2 ** 32 / hashrate;
  const years = seconds / 31536000;
  const days = seconds / 86400;
  return { seconds, days, years };
}

function dailyOdds(hashrate, difficulty) {
  if (!hashrate || !difficulty) return null;
  const chance = 1 - Math.exp(-(hashrate * 86400) / (difficulty * 2 ** 32));
  if (!Number.isFinite(chance) || chance <= 0) return null;
  return chance;
}

function statusForMiner(data) {
  const hashrate = parseHashrate(data.hashrate5m || data.hashrate1m);
  const lastShareAge = Math.round(Date.now() / 1000 - Number(data.lastshare || 0));
  if (!hashrate) return { text: "Idle", tone: "warning" };
  if (lastShareAge > 3600) return { text: "Stale", tone: "warning" };
  return { text: "Active", tone: "ok" };
}

async function fetchJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  return payload;
}

async function refreshDifficulty() {
  try {
    const payload = await fetchJson("/api/difficulty");
    state.difficulty = payload.difficulty;
  } catch {
    state.difficulty = null;
  }
}

async function refreshMiners() {
  elements.refreshNow.disabled = true;
  elements.refreshStatus.textContent = "Refreshing...";
  await refreshDifficulty();

  await Promise.all(state.miners.map(async (miner) => {
    try {
      const params = new URLSearchParams({ address: miner.address, host: miner.host });
      const payload = await fetchJson(`/api/miner?${params}`);
      state.results.set(miner.id, { ok: true, payload });
    } catch (error) {
      state.results.set(miner.id, { ok: false, error: error.message });
    }
  }));

  elements.refreshNow.disabled = false;
  scheduleRefresh();
  render();
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  clearInterval(state.countdownTimer);
  state.nextRefreshAt = Date.now() + REFRESH_SECONDS * 1000;
  state.refreshTimer = setTimeout(refreshMiners, REFRESH_SECONDS * 1000);
  state.countdownTimer = setInterval(updateCountdown, 1000);
  updateCountdown();
}

function updateCountdown() {
  if (!state.nextRefreshAt) return;
  const seconds = Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000));
  elements.refreshStatus.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}; next refresh in ${seconds}s`;
}

function renderSummary() {
  const successful = state.miners
    .map((miner) => state.results.get(miner.id))
    .filter((result) => result && result.ok)
    .map((result) => result.payload.data);

  const totalHashrate = successful.reduce((sum, data) => sum + parseHashrate(data.hashrate5m || data.hashrate1m), 0);
  const workers = successful.reduce((sum, data) => sum + Number(data.workers || 0), 0);
  const best = Math.max(0, ...successful.map((data) => Number(data.bestever || data.bestshare || 0)));
  const progress = state.difficulty ? best / state.difficulty * 100 : null;

  elements.fleetHashrate.textContent = totalHashrate ? formatHashrate(totalHashrate) : "--";
  elements.fleetHashrateNote.textContent = totalHashrate ? "Combined 5-minute speed." : "No live hashrate yet.";
  elements.fleetWorkers.textContent = successful.length ? formatNumber(workers) : "--";
  elements.fleetWorkersNote.textContent = successful.length === 1 ? "Across 1 saved miner." : `Across ${successful.length} saved miners.`;
  elements.fleetProgress.textContent = progress === null ? "--" : formatPercent(progress);
  elements.fleetProgressNote.textContent = state.difficulty ? "Best ever share vs. Bitcoin difficulty." : "Difficulty unavailable right now.";
}

function renderMiner(miner) {
  const fragment = elements.template.content.cloneNode(true);
  const card = fragment.querySelector(".miner-card");
  const result = state.results.get(miner.id);

  fragment.querySelector(".miner-region").textContent = regionName(miner.host);
  fragment.querySelector(".miner-title").textContent = miner.name || shortAddress(miner.address);
  fragment.querySelector(".miner-address").textContent = miner.address;
  fragment.querySelector(".remove-miner").addEventListener("click", () => removeMiner(miner.id));

  if (!result) {
    fragment.querySelector(".status-pill").textContent = "Loading";
    fragment.querySelector(".plain-status").textContent = "Loading this miner for the first time.";
    return fragment;
  }

  if (!result.ok) {
    const pill = fragment.querySelector(".status-pill");
    pill.textContent = "Check";
    pill.classList.add("error");
    fragment.querySelector(".plain-status").textContent = result.error;
    card.querySelectorAll(".metric strong, .metric-note, .progress-value").forEach((node) => {
      node.textContent = "--";
    });
    return fragment;
  }

  const data = result.payload.data;
  const status = statusForMiner(data);
  const hashrate = parseHashrate(data.hashrate5m || data.hashrate1m);
  const bestShare = Number(data.bestshare || 0);
  const bestEver = Number(data.bestever || bestShare);
  const progress = state.difficulty ? bestEver / state.difficulty * 100 : null;
  const chance = dailyOdds(hashrate, state.difficulty);
  const expected = expectedTime(hashrate, state.difficulty);
  const lastShareText = formatRelativeTime(Number(data.lastshare || 0));
  const workerCount = Number(data.workers || 0);

  const pill = fragment.querySelector(".status-pill");
  pill.textContent = status.text;
  if (status.tone !== "ok") pill.classList.add(status.tone);

  const plain = status.tone === "ok"
    ? `${miner.name || "This miner"} is submitting shares. At the current 5-minute rate of ${formatHashrate(hashrate)}, it is connected and doing work.`
    : `${miner.name || "This miner"} needs attention. Check whether the miner is powered on, connected to ${miner.host}, and using this Bitcoin address as its username.`;
  fragment.querySelector(".plain-status").textContent = plain;

  fragment.querySelector(".hashrate-now").textContent = formatHashrate(hashrate);
  fragment.querySelector(".hashrate-note").textContent = `1h ${data.hashrate1hr || "--"} · 1d ${data.hashrate1d || "--"} · 7d ${data.hashrate7d || "--"}`;
  fragment.querySelector(".last-share").textContent = lastShareText;
  fragment.querySelector(".last-share-note").textContent = workerCount === 1 ? "1 worker is reporting." : `${workerCount} workers are reporting.`;
  fragment.querySelector(".best-share").textContent = formatCompact(bestEver);
  fragment.querySelector(".best-share-note").textContent = state.difficulty
    ? `Needs about ${formatCompact(state.difficulty)} to solve a block right now.`
    : "Bitcoin difficulty could not be loaded.";
  fragment.querySelector(".daily-odds").textContent = chance ? `1 in ${formatNumber(Math.round(1 / chance))}` : "--";
  fragment.querySelector(".daily-odds-note").textContent = expected
    ? `Average wait at this speed: about ${formatNumber(Math.round(expected.years))} years.`
    : "Odds need live Bitcoin difficulty.";
  fragment.querySelector(".progress-value").textContent = progress === null ? "--" : formatPercent(progress);
  fragment.querySelector(".progress-bar").style.width = `${Math.max(0.25, Math.min(progress || 0, 100))}%`;

  const workerList = fragment.querySelector(".worker-list");
  (data.worker || []).forEach((worker) => {
    const row = document.createElement("div");
    row.className = "worker-row";
    const name = document.createElement("strong");
    const speed = document.createElement("span");
    const lastShare = document.createElement("span");
    const best = document.createElement("span");

    name.textContent = worker.workername || "Unnamed worker";
    speed.textContent = `${worker.hashrate5m || "--"} 5m`;
    lastShare.textContent = formatRelativeTime(Number(worker.lastshare || 0));
    best.textContent = `Best ${formatCompact(Number(worker.bestshare || 0))}`;
    row.append(name, speed, lastShare, best);
    workerList.append(row);
  });
  fragment.querySelector(".raw-json").textContent = JSON.stringify(data, null, 2);

  return fragment;
}

function render() {
  renderSummary();
  elements.list.replaceChildren();
  if (!state.loaded) {
    const loading = document.createElement("div");
    loading.className = "empty";
    loading.textContent = "Loading saved miners...";
    elements.list.append(loading);
    return;
  }

  if (!state.miners.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No miners saved yet. Add a Bitcoin address above to start monitoring.";
    elements.list.append(empty);
    return;
  }
  state.miners.forEach((miner) => {
    elements.list.append(renderMiner(miner));
  });
}

async function upsertMiner(formData) {
  const address = normalizeMinerAddress(formData.get("address"));
  const host = formData.get("host");
  const name = String(formData.get("name") || "").trim() || shortAddress(address);
  const id = `${host}:${address}`;
  const nextMiner = { id, name, address, host };
  const existingIndex = state.miners.findIndex((miner) => miner.id === id);

  if (existingIndex >= 0) {
    state.miners[existingIndex] = nextMiner;
  } else {
    state.miners.push(nextMiner);
  }

  try {
    await saveMiners();
    elements.form.reset();
    render();
    refreshMiners();
  } catch (error) {
    state.results.set(id, { ok: false, error: error.message });
    render();
  }
}

async function removeMiner(id) {
  const previousMiners = state.miners;
  state.miners = state.miners.filter((miner) => miner.id !== id);
  state.results.delete(id);
  try {
    await saveMiners();
    render();
  } catch (error) {
    state.miners = previousMiners;
    state.results.set(id, { ok: false, error: error.message });
    render();
  }
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  upsertMiner(new FormData(elements.form));
});

elements.refreshNow.addEventListener("click", refreshMiners);

async function init() {
  render();
  await loadMiners();
  render();
  refreshMiners();
}

init();
