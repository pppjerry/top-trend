function getDataBase() {
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const dirParts = [...pathParts];
  if (dirParts.length && dirParts[dirParts.length - 1].includes(".")) {
    dirParts.pop();
  }

  // Local dev from repository root: /web/** should resolve data at repo root /data.
  if (dirParts[0] === "web") {
    return `${"../".repeat(dirParts.length)}data`;
  }
  if (!dirParts.length) return "./data";

  // Deployed subpages: /weibo/ => ../data, /platforms/foo/ => ../../data.
  return `${"../".repeat(dirParts.length)}data`;
}
const DATA_BASE = getDataBase();
const RECENT_KEYWORDS_KEY = "toptrend:recent-keywords";
const MAX_RECENT_KEYWORDS = 5;

const state = {
  index: null,
  dayDataCache: new Map(),
  mergedSnapshotsCache: new Map(),
  itemLibraryCache: new Map(),
  source: "weibo",
  currentDayData: null,
  currentLibrary: null,
  recentKeywords: [],
};
let rankChart = null;

function fmtTime(iso) {
  const d = new Date(iso);
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

function formatDateTime(iso) {
  if (!iso || iso === "-") return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function setLastUpdated(text) {
  document.getElementById("lastUpdated").textContent = `更新时间: ${formatDateTime(text)}`;
}

function setStatusBanner(message) {
  const el = document.getElementById("statusBanner");
  if (!message) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = message;
  el.classList.remove("hidden");
}

function bindTabs() {
  const buttons = document.querySelectorAll(".tab-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      switchTab(btn.dataset.tab);
    });
  });
}

function switchTab(tab) {
  const buttons = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".tab-panel");
  buttons.forEach((b) => b.classList.toggle("tab-active", b.dataset.tab === tab));
  panels.forEach((p) => p.classList.add("hidden"));
  document.getElementById(`tab-${tab}`).classList.remove("hidden");
  if (tab === "trend" && rankChart) {
    // ECharts 在隐藏容器初始化时可能尺寸为 0，这里确保切换后重算尺寸。
    setTimeout(() => rankChart.resize(), 0);
  }
}

function loadRecentKeywords() {
  try {
    const raw = localStorage.getItem(RECENT_KEYWORDS_KEY);
    const list = JSON.parse(raw || "[]");
    if (!Array.isArray(list)) return [];
    return list.filter((item) => typeof item === "string" && item.trim()).slice(0, MAX_RECENT_KEYWORDS);
  } catch (_) {
    return [];
  }
}

function saveRecentKeywords() {
  localStorage.setItem(RECENT_KEYWORDS_KEY, JSON.stringify(state.recentKeywords));
}

function renderRecentKeywords() {
  const el = document.getElementById("recentKeywords");
  if (!state.recentKeywords.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <span class="text-sm text-slate-500">最近分析:</span>
    ${state.recentKeywords
      .map(
        (keyword) =>
          `<button class="rounded-full border border-slate-300 px-3 py-1 text-xs text-slate-700 hover:bg-slate-100 recent-keyword-btn" data-keyword="${encodeURIComponent(keyword)}">${keyword}</button>`,
      )
      .join("")}
  `;
  el.querySelectorAll(".recent-keyword-btn").forEach((btn) => {
    btn.onclick = () => {
      const keyword = decodeURIComponent(btn.dataset.keyword || "");
      void runTrendAnalysis(keyword);
    };
  });
}

function addRecentKeyword(keyword) {
  const value = keyword.trim();
  if (!value) return;
  state.recentKeywords = [value, ...state.recentKeywords.filter((k) => k !== value)].slice(
    0,
    MAX_RECENT_KEYWORDS,
  );
  saveRecentKeywords();
  renderRecentKeywords();
}

async function fetchJson(path) {
  const resp = await fetch(path, { cache: "no-store" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${path}`);
  return resp.json();
}

async function loadIndex() {
  state.index = await fetchJson(`${DATA_BASE}/index.json`);
  setLastUpdated(state.index.lastUpdated || "-");
}

async function loadStatus() {
  try {
    return await fetchJson(`${DATA_BASE}/status.json`);
  } catch (_) {
    return null;
  }
}

function minutesDiffFromNow(isoTime) {
  if (!isoTime) return Number.POSITIVE_INFINITY;
  const ms = Date.now() - new Date(isoTime).getTime();
  if (!Number.isFinite(ms)) return Number.POSITIVE_INFINITY;
  return Math.floor(ms / 60000);
}

function renderStatusBanner(status) {
  if (!status) {
    setStatusBanner("未检测到 status.json，无法判断抓取任务状态。");
    return;
  }

  const staleMinutes = minutesDiffFromNow(status.lastRunAt);
  if (status.ok === false) {
    setStatusBanner(
      `抓取任务最近一次执行失败。${status.message || ""} 最近执行时间: ${formatDateTime(status.lastRunAt)}`,
    );
    return;
  }

  if (staleMinutes > 50) {
    setStatusBanner(
      `抓取任务可能中断：距离最近一次执行已 ${staleMinutes} 分钟（预期约 20 分钟一次）。`,
    );
    return;
  }

  setStatusBanner("");
}

async function loadDay(source, date) {
  const key = `${source}:${date}`;
  if (state.dayDataCache.has(key)) return state.dayDataCache.get(key);
  const data = await fetchJson(`${DATA_BASE}/raw/${source}/${date}.json`);
  state.dayDataCache.set(key, data);
  return data;
}

async function loadAllSnapshotsBySource(source) {
  const dates = state.index?.dates?.[source] || [];
  if (!dates.length) return [];

  const cacheKey = `${source}:${dates.join(",")}`;
  if (state.mergedSnapshotsCache.has(cacheKey)) {
    return state.mergedSnapshotsCache.get(cacheKey);
  }

  const dayPayloads = await Promise.all(dates.map((date) => loadDay(source, date)));
  const snapshots = dayPayloads
    .flatMap((payload) => payload?.snapshots || [])
    .slice()
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  state.mergedSnapshotsCache.set(cacheKey, snapshots);
  return snapshots;
}

async function loadItemLibrary(source) {
  if (state.itemLibraryCache.has(source)) {
    return state.itemLibraryCache.get(source);
  }

  try {
    const payload = await fetchJson(`${DATA_BASE}/derived/${source}/items.json`);
    state.itemLibraryCache.set(source, payload);
    return payload;
  } catch (_) {
    const fallback = { source, generatedAt: "", totalItems: 0, items: [] };
    state.itemLibraryCache.set(source, fallback);
    return fallback;
  }
}

function getRankChangeMap(prevItems) {
  const map = new Map();
  prevItems.forEach((it) => map.set(it.title, it.rank));
  return map;
}

function changeLabel(currRank, prevRank) {
  if (!prevRank) return `<span class="rank-new">NEW</span>`;
  if (currRank < prevRank) return `<span class="rank-up">↑ ${prevRank - currRank}</span>`;
  if (currRank > prevRank) return `<span class="rank-down">↓ ${currRank - prevRank}</span>`;
  return `<span class="text-slate-400">-</span>`;
}

function itemStatusLabel(status, comebackCount) {
  if (status === "on_list") return `<span class="text-green-600">在榜中</span>`;
  if (comebackCount > 0) return `<span class="text-purple-600">已掉榜(曾回榜)</span>`;
  return `<span class="text-slate-500">已掉榜</span>`;
}

function normalizeKeyword(text) {
  return String(text || "").trim().toLowerCase();
}

function resolveItemUrl(item) {
  if (!item) return "";
  return String(item.url || "").trim();
}

function renderRealtime(dayData) {
  const listEl = document.getElementById("realtimeTable");
  const snapshots = dayData.snapshots || [];
  if (!snapshots.length) {
    listEl.innerHTML = `<tr><td colspan="5" class="py-3 text-slate-400">暂无数据</td></tr>`;
    return;
  }
  const latest = snapshots[snapshots.length - 1];
  const prev = snapshots[snapshots.length - 2];
  const prevMap = getRankChangeMap(prev?.items || []);

  listEl.innerHTML = latest.items
    .map((item) => {
      return `<tr class="border-b">
        <td class="py-2">${item.rank}</td>
        <td class="py-2">
          <a class="text-blue-600 hover:underline" href="${item.url || "#"}" target="_blank">${item.title}</a>
        </td>
        <td class="py-2">${changeLabel(item.rank, prevMap.get(item.title))}</td>
        <td class="py-2">${item.hotValue || "-"}</td>
        <td class="py-2">
          <button
            class="rounded border border-blue-200 px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 trend-btn"
            data-keyword="${encodeURIComponent(item.title)}"
          >
            趋势分析
          </button>
        </td>
      </tr>`;
    })
    .join("");

  listEl.querySelectorAll(".trend-btn").forEach((btn) => {
    btn.onclick = () => {
      const keyword = decodeURIComponent(btn.dataset.keyword || "");
      void runTrendAnalysis(keyword);
    };
  });

  setLastUpdated(latest.timestamp);
}

function getLibraryFilteredItems() {
  const sourceItems = state.currentLibrary?.items || [];
  const keyword = (document.getElementById("librarySearch")?.value || "").trim().toLowerCase();
  const status = document.getElementById("libraryStatus")?.value || "all";
  const sortBy = document.getElementById("librarySort")?.value || "lastSeenDesc";

  let items = sourceItems.filter((item) => item.title?.toLowerCase().includes(keyword));

  if (status === "on_list") {
    items = items.filter((item) => item.status === "on_list");
  } else if (status === "off_list") {
    items = items.filter((item) => item.status === "off_list");
  } else if (status === "comeback") {
    items = items.filter((item) => (item.comebackCount || 0) > 0);
  }

  const parseTime = (text) => new Date(text || "").getTime() || 0;
  const numOrMax = (val) => (typeof val === "number" ? val : Number.MAX_SAFE_INTEGER);

  items.sort((a, b) => {
    if (sortBy === "peakRankAsc") return numOrMax(a.peakRank) - numOrMax(b.peakRank);
    if (sortBy === "durationDesc") return (b.onListDurationMinutes || 0) - (a.onListDurationMinutes || 0);
    if (sortBy === "comebackDesc") return (b.comebackCount || 0) - (a.comebackCount || 0);
    return parseTime(b.lastSeenAt) - parseTime(a.lastSeenAt);
  });

  return items;
}

function renderLibrary() {
  const metaEl = document.getElementById("libraryMeta");
  const tableEl = document.getElementById("libraryTable");
  const generatedAt = state.currentLibrary?.generatedAt || "";
  const filtered = getLibraryFilteredItems();

  const total = state.currentLibrary?.totalItems || 0;
  const hasSnapshots = (state.index?.dates?.[state.source] || []).length > 0;
  const generatedText = generatedAt ? formatDateTime(generatedAt) : "-";
  const pendingHint =
    total === 0 && hasSnapshots
      ? " 当前词条库尚未生成，等待下一次抓取任务或手动运行 `python main.py`。"
      : "";
  metaEl.textContent = `共 ${total} 个词条，当前筛选后 ${filtered.length} 个。生成时间: ${generatedText}.${pendingHint}`;

  if (!total) {
    tableEl.innerHTML = `<tr><td colspan="9" class="py-3 text-slate-400">词条库暂无数据，请等待抓取任务完成后刷新页面。</td></tr>`;
    return;
  }

  if (!filtered.length) {
    tableEl.innerHTML = `<tr><td colspan="9" class="py-3 text-slate-400">暂无匹配词条</td></tr>`;
    return;
  }

  tableEl.innerHTML = filtered
    .map(
      (item) => {
        const title = item.title || "-";
        const itemUrl = resolveItemUrl(item);
        const titleCell = itemUrl
          ? `<a class="text-blue-600 hover:underline" href="${itemUrl}" target="_blank">${title}</a>`
          : title;
        return `<tr class="border-b">
        <td class="py-2">${titleCell}</td>
        <td class="py-2">${itemStatusLabel(item.status, item.comebackCount || 0)}</td>
        <td class="py-2">${formatDateTime(item.firstSeenAt)}</td>
        <td class="py-2">${formatDateTime(item.lastSeenAt)}</td>
        <td class="py-2">${item.peakRank ?? "-"}</td>
        <td class="py-2">${item.onListDurationMinutes ?? 0} 分钟</td>
        <td class="py-2">${item.comebackCount ?? 0}</td>
        <td class="py-2">${item.currentRank ?? "-"}</td>
        <td class="py-2">
          <button class="rounded border border-blue-200 px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 library-trend-btn" data-keyword="${encodeURIComponent(item.title || "")}">
            趋势分析
          </button>
        </td>
      </tr>`;
      },
    )
    .join("");

  tableEl.querySelectorAll(".library-trend-btn").forEach((btn) => {
    btn.onclick = () => {
      const keyword = decodeURIComponent(btn.dataset.keyword || "");
      void runTrendAnalysis(keyword);
    };
  });
}

function setupLibraryControls() {
  const search = document.getElementById("librarySearch");
  const status = document.getElementById("libraryStatus");
  const sort = document.getElementById("librarySort");

  search.oninput = () => renderLibrary();
  status.onchange = () => renderLibrary();
  sort.onchange = () => renderLibrary();
}

function collectSeries(snapshots, keyword) {
  const points = [];
  const normalizedKeyword = normalizeKeyword(keyword);
  if (!normalizedKeyword) return points;

  for (const snap of snapshots || []) {
    const items = snap.items || [];
    const exactMatch = items.find((i) => normalizeKeyword(i.title) === normalizedKeyword);
    const found = exactMatch || items.find((i) => normalizeKeyword(i.title).includes(normalizedKeyword));
    if (found) {
      points.push({
        timestamp: snap.timestamp,
        rank: found.rank,
        hotValue: found.hotValue || 0,
      });
    }
  }
  return points;
}

function renderStats(points) {
  const el = document.getElementById("trendStats");
  if (!points.length) {
    el.innerHTML = `<div class="stat-card">未找到该关键词</div>`;
    return;
  }
  const first = points[0];
  const last = points[points.length - 1];
  const best = Math.min(...points.map((p) => p.rank));
  const durationMinutes = Math.max(
    0,
    Math.round((new Date(last.timestamp) - new Date(first.timestamp)) / 60000),
  );
  el.innerHTML = `
    <div class="stat-card"><div class="text-xs text-slate-500">首次上榜</div><div>${formatDateTime(first.timestamp)}</div></div>
    <div class="stat-card"><div class="text-xs text-slate-500">当前排名</div><div>${last.rank}</div></div>
    <div class="stat-card"><div class="text-xs text-slate-500">最高排名</div><div>${best}</div></div>
    <div class="stat-card"><div class="text-xs text-slate-500">在榜时长</div><div>${durationMinutes} 分钟</div></div>
  `;
}

function renderTrendChart(points, keyword) {
  const chartEl = document.getElementById("rankChart");
  if (!rankChart) {
    rankChart = echarts.init(chartEl);
  }
  if (!points.length) {
    rankChart.setOption({
      title: {
        text: `未找到“${keyword}”的排名数据`,
        left: "center",
        top: "middle",
        textStyle: { color: "#64748b", fontSize: 14, fontWeight: "normal" },
      },
      xAxis: { show: false, type: "category", data: [] },
      yAxis: { show: false, type: "value" },
      series: [],
    });
    setTimeout(() => rankChart.resize(), 0);
    return;
  }

  rankChart.setOption({
    title: { text: "" },
    tooltip: {
      trigger: "axis",
      valueFormatter: (value) => (value == null ? "-" : String(Math.round(value))),
    },
    xAxis: {
      type: "category",
      data: points.map((p) => fmtTime(p.timestamp)),
      name: "时间",
    },
    yAxis: {
      type: "value",
      inverse: true,
      min: (v) => Math.max(1, Math.floor(v.min)),
      max: (v) => {
        const ceilMax = Math.ceil(v.max);
        return ceilMax === Math.floor(v.min) ? ceilMax + 1 : ceilMax;
      },
      interval: 1,
      minInterval: 1,
      name: "排名",
      axisLabel: { formatter: "{value}" },
    },
    series: [
      {
        name: keyword,
        type: "line",
        smooth: true,
        symbol: "circle",
        symbolSize: 7,
        data: points.map((p) => p.rank),
      },
    ],
  });
  setTimeout(() => rankChart.resize(), 0);
}

async function runTrendAnalysis(keyword) {
  if (!keyword) return;
  const source = state.source;
  const snapshots = await loadAllSnapshotsBySource(source);
  if (!snapshots.length) return;

  const input = document.getElementById("keywordInput");
  input.value = keyword;
  const points = collectSeries(snapshots, keyword);
  switchTab("trend");
  renderStats(points);
  renderTrendChart(points, keyword);
  addRecentKeyword(keyword);
}

function setupTrendSearch() {
  const input = document.getElementById("keywordInput");
  const btn = document.getElementById("keywordBtn");
  const run = () => {
    const keyword = input.value.trim();
    void runTrendAnalysis(keyword);
  };
  btn.onclick = run;
  input.onkeydown = (e) => {
    if (e.key === "Enter") run();
  };
}

function setupHistory(dayData) {
  const dateSelect = document.getElementById("dateSelect");
  const snapshotSelect = document.getElementById("snapshotSelect");
  const list = document.getElementById("historyList");

  const snapshots = dayData.snapshots || [];
  snapshotSelect.innerHTML = snapshots
    .map((snap, idx) => `<option value="${idx}">${formatDateTime(snap.timestamp)}</option>`)
    .join("");

  const render = (idx) => {
    const snap = snapshots[idx];
    if (!snap) {
      list.innerHTML = "<li class='text-slate-400'>暂无数据</li>";
      return;
    }
    list.innerHTML = (snap.items || [])
      .map(
        (it) =>
          `<li class="flex items-center justify-between rounded border bg-slate-50 p-2">
            <div><strong>#${it.rank}</strong> ${it.title} <span class="text-slate-500">(${it.hotValue || "-"})</span></div>
            <button
              class="rounded border border-blue-200 px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 history-trend-btn"
              data-keyword="${encodeURIComponent(it.title)}"
            >
              趋势分析
            </button>
          </li>`,
      )
      .join("");

    list.querySelectorAll(".history-trend-btn").forEach((btn) => {
      btn.onclick = () => {
        const keyword = decodeURIComponent(btn.dataset.keyword || "");
        void runTrendAnalysis(keyword);
      };
    });
  };

  snapshotSelect.onchange = () => {
    render(Number(snapshotSelect.value));
  };
  render(Math.max(0, snapshots.length - 1));

  dateSelect.onchange = async () => {
    const date = dateSelect.value;
    const data = await loadDay(state.source, date);
    state.currentDayData = data;
    setupHistory(data);
    renderRealtime(data);
  };
}

function initDateOptions() {
  const dates = state.index?.dates?.[state.source] || [];
  const dateSelect = document.getElementById("dateSelect");
  dateSelect.innerHTML = dates.map((d) => `<option value="${d}">${d}</option>`).join("");
  return dates[0];
}

async function reloadForSource(source) {
  state.source = source;
  const defaultDate = initDateOptions();
  state.currentLibrary = await loadItemLibrary(state.source);
  renderLibrary();

  if (!defaultDate) {
    state.currentDayData = null;
    document.getElementById("realtimeTable").innerHTML =
      `<tr><td colspan="5" class="py-3 text-slate-400">该榜单暂无数据。</td></tr>`;
    document.getElementById("historyList").innerHTML = "<li class='text-slate-400'>暂无数据</li>";
    document.getElementById("snapshotSelect").innerHTML = "";
    document.getElementById("trendStats").innerHTML = `<div class="stat-card">请先选择有数据的榜单</div>`;
    return;
  }

  const dayData = await loadDay(state.source, defaultDate);
  state.currentDayData = dayData;
  renderRealtime(dayData);
  setupHistory(dayData);
}

async function bootstrap() {
  state.recentKeywords = loadRecentKeywords();
  bindTabs();
  await loadIndex();
  const status = await loadStatus();
  renderStatusBanner(status);
  setupTrendSearch();
  setupLibraryControls();
  renderRecentKeywords();
  await reloadForSource(state.source);
}

bootstrap().catch((err) => {
  console.error(err);
  document.getElementById("realtimeTable").innerHTML =
    `<tr><td colspan="5" class="py-3 text-red-500">数据加载失败：${err.message}</td></tr>`;
});
