"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  status: null,
  model: "kronos-small",
  dataset: null,   // describe() + candles
  mode: "future",
  result: null,
};

// ------------------------------------------------------------------ helpers
async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  let body;
  try { body = await res.json(); } catch { body = { error: `HTTP ${res.status}` }; }
  if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
const postJSON = (path, data) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

let toastTimer;
function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), isError ? 7000 : 3000);
}

function busy(on, text = "Working…") {
  $("#overlay").classList.toggle("hidden", !on);
  $("#overlayText").textContent = text;
}

function fmt(v, digits) {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v);
  const d = digits ?? (a >= 1000 ? 2 : a >= 1 ? 3 : 5);
  return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
const pct = (v, d = 2) => (v == null || !isFinite(v) ? "—" : (v > 0 ? "+" : "") + v.toFixed(d) + "%");
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ------------------------------------------------------------------ theme
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("kronos-theme"); } catch {}
  if (saved) document.documentElement.dataset.theme = saved;
  $("#themeBtn").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("kronos-theme", next); } catch {}
    redraw();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);
})();

// ------------------------------------------------------------------ status / models
function renderModelPill() {
  const s = state.status, pill = $("#modelPill");
  pill.className = "pill";
  if (s?.loading) { pill.classList.add("busy"); $("#modelPillText").textContent = `Loading ${s.models[s.loading].name}…`; }
  else if (s?.loaded) { pill.classList.add("ok"); $("#modelPillText").textContent = `${s.models[s.loaded].name} · ${s.device}`; }
  else if (s?.error) { pill.classList.add("err"); $("#modelPillText").textContent = "Model failed to load"; }
  else $("#modelPillText").textContent = "No model loaded";
}

function renderModels() {
  const s = state.status;
  $("#modelList").innerHTML = Object.entries(s.models).map(([k, m]) => `
    <label class="model ${k === state.model ? "sel" : ""}" data-key="${k}">
      <input type="radio" name="model" value="${k}" ${k === state.model ? "checked" : ""}>
      <div><div class="mname">${m.name}</div><div class="mmeta">${m.params} params · context ${m.context}</div></div>
      ${s.loaded === k ? '<span class="badge">loaded</span>' : ""}
    </label>`).join("");
  $$("#modelList input").forEach((r) => r.addEventListener("change", () => {
    state.model = r.value;
    renderModels();
    updateRanges();
  }));
}

async function refreshStatus() {
  state.status = await api("/api/status");
  if (state.status.loaded) state.model = state.model || state.status.loaded;
  renderModels();
  renderModelPill();
  const dev = $("#device");
  if (!dev.options.length) {
    dev.innerHTML = `<option value="">Auto</option>` + state.status.devices.map((d) => `<option>${d}</option>`).join("");
  }
  const samples = Object.entries(state.status.samples);
  $("#sampleSelect").innerHTML = samples.map(([k, n]) => `<option value="${k}">${n}</option>`).join("") || `<option disabled>No bundled samples</option>`;
}

$("#loadModelBtn").addEventListener("click", async () => {
  const name = state.status.models[state.model].name;
  busy(true, `Loading ${name}… (first run downloads weights from Hugging Face)`);
  state.status.loading = state.model; renderModelPill();
  try {
    const r = await postJSON("/api/model/load", { model: state.model, device: $("#device").value });
    toast(`${name} ready on ${r.device} (${r.seconds}s)`);
  } catch (e) { toast(e.message, true); }
  finally { busy(false); await refreshStatus(); }
});

// ------------------------------------------------------------------ data loading
$$(".tab").forEach((t) => t.addEventListener("click", () => {
  $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $$(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== t.dataset.tab));
}));

async function useDataset(desc) {
  const full = await api(`/api/data/${desc.id}`);
  state.dataset = full;
  state.result = null;
  const d = full;
  $("#dsInfo").classList.remove("hidden");
  $("#dsInfo").innerHTML = `
    <div class="name">${escapeHtml(d.name)}</div>
    <span class="k">Rows</span><span class="v">${d.rows.toLocaleString()}</span>
    <span class="k">From</span><span class="v">${d.start}</span>
    <span class="k">To</span><span class="v">${d.end}</span>
    <span class="k">Bar size</span><span class="v">${prettyStep(d.step)}</span>
    <span class="k">Volume</span><span class="v">${d.has_volume ? "yes" : "no (filled with 0)"}</span>`;
  updateRanges(null, true);
  $("#runBtn").disabled = false;
  $("#runHint").textContent = "Ready";
  clearResultUI();
  redraw();
  toast(`Loaded ${d.rows.toLocaleString()} bars`);
}

function prettyStep(s) {
  // pandas Timedelta string like "0 days 00:05:00"
  const m = /(\d+) days? (\d+):(\d+):(\d+)/.exec(s);
  if (!m) return s;
  const [d, h, mi] = [+m[1], +m[2], +m[3]];
  if (d) return d === 7 ? "1 week" : `${d} day${d > 1 ? "s" : ""}`;
  if (h) return `${h} hour${h > 1 ? "s" : ""}`;
  return `${mi} min`;
}
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

$("#sampleBtn").addEventListener("click", async () => {
  busy(true, "Loading sample…");
  try { await useDataset(await postJSON("/api/data/sample", { sample: $("#sampleSelect").value })); }
  catch (e) { toast(e.message, true); } finally { busy(false); }
});

async function uploadFile(file) {
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  busy(true, `Uploading ${file.name}…`);
  try { await useDataset(await api("/api/data/upload", { method: "POST", body: fd })); }
  catch (e) { toast(e.message, true); } finally { busy(false); }
}
$("#fileInput").addEventListener("change", (e) => uploadFile(e.target.files[0]));
const drop = $("#drop");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => uploadFile(e.dataTransfer.files[0]));

async function fetchMarket() {
  busy(true, `Fetching ${$("#symbol").value.toUpperCase()}…`);
  try {
    await useDataset(await postJSON("/api/data/market", {
      symbol: $("#symbol").value, interval: $("#interval").value, period: $("#period").value,
    }));
  } catch (e) { toast(e.message, true); } finally { busy(false); }
}
$("#marketBtn").addEventListener("click", fetchMarket);
$("#symbol").addEventListener("keydown", (e) => { if (e.key === "Enter") fetchMarket(); });

// ------------------------------------------------------------------ forecast controls
$$("#modeSeg button").forEach((b) => b.addEventListener("click", () => {
  state.mode = b.dataset.mode;
  $$("#modeSeg button").forEach((x) => x.classList.toggle("active", x === b));
  $$(".backtest-only").forEach((el) => el.classList.toggle("hidden", state.mode !== "backtest"));
  updateRanges();
  redraw();
}));

const outs = {
  lookback: (v) => `${v} bars`, predLen: (v) => `${v} bars`, samples: (v) => v,
  temp: (v) => (+v).toFixed(2), topP: (v) => (+v).toFixed(2),
  endIdx: (v) => state.dataset ? state.dataset.candles.t[Math.min(+v, state.dataset.rows - 1)] ?? "end" : "—",
};
Object.keys(outs).forEach((id) => {
  const el = $("#" + id);
  el.addEventListener("input", () => {
    if (id === "lookback" || id === "predLen") updateRanges(id);
    else syncOut(id);
    if (id === "endIdx" && !state.result) redraw();
  });
  syncOut(id);
});
function syncOut(id) { $("#" + id + "Out").textContent = outs[id]($("#" + id).value); }

function updateRanges(_, resetOrigin = false) {
  const ctx = state.status?.models[state.model]?.context ?? 512;
  const rows = state.dataset?.rows ?? 2048;
  const lb = $("#lookback"), pl = $("#predLen"), ei = $("#endIdx");
  const backtest = state.mode === "backtest";

  pl.max = Math.max(1, Math.min(512, backtest ? rows - 10 : 512));
  if (+pl.value > +pl.max) pl.value = pl.max;
  lb.max = Math.max(16, Math.min(ctx, backtest ? rows - +pl.value : rows));
  lb.min = Math.min(32, +lb.max);
  if (+lb.value > +lb.max) lb.value = lb.max;

  // Set max before min: browsers clamp the value as soon as min changes.
  const prev = +ei.value;
  ei.max = Math.max(+lb.value, rows - +pl.value);
  ei.min = +lb.value;
  ei.value = resetOrigin || prev > +ei.max || prev < +ei.min ? ei.max : prev;
  Object.keys(outs).forEach(syncOut);
}

$("#runBtn").addEventListener("click", async () => {
  if (!state.dataset) return;
  const m = state.status.models[state.model];
  const needLoad = state.status.loaded !== state.model;
  const t0 = performance.now();
  busy(true, needLoad ? `Loading ${m.name} and forecasting…` : `Sampling ${$("#samples").value} paths with ${m.name}…`);
  const tick = setInterval(() => {
    $("#overlayText").textContent = `${needLoad ? `Loading ${m.name} and forecasting` : `Forecasting with ${m.name}`}… ${((performance.now() - t0) / 1000).toFixed(0)}s`;
  }, 500);
  $("#runBtn").disabled = true;
  try {
    state.result = await postJSON("/api/predict", {
      dataset: state.dataset.id, model: state.model, device: $("#device").value,
      mode: state.mode, lookback: +$("#lookback").value, pred_len: +$("#predLen").value,
      end_index: state.mode === "backtest" ? +$("#endIdx").value : null,
      samples: +$("#samples").value, temperature: +$("#temp").value, top_p: +$("#topP").value,
      top_k: +$("#topK").value || 0, seed: $("#seed").value,
    });
    renderResult();
    toast(`Forecast done in ${state.result.summary.seconds}s`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    clearInterval(tick);
    busy(false);
    $("#runBtn").disabled = false;
    refreshStatus();
  }
});

// ------------------------------------------------------------------ results
function clearResultUI() {
  ["sLast", "sPred", "sChg", "sProb", "sRange"].forEach((id) => { $("#" + id).textContent = "—"; $("#" + id).className = $("#" + id).className.replace(/ ?(up|down)/g, ""); });
  ["sLastSub", "sPredSub", "sChgSub", "sRangeSub"].forEach((id) => ($("#" + id).innerHTML = "&nbsp;"));
  $("#sProbBar").style.width = "0";
  $("#metricsCard").classList.add("hidden");
  $("#tableCard").classList.add("hidden");
  if (state.dataset) {
    $("#sLast").textContent = fmt(state.dataset.last_close);
    $("#sLastSub").textContent = state.dataset.end;
  }
}

function setDir(el, v) { el.classList.remove("up", "down"); if (v > 0) el.classList.add("up"); else if (v < 0) el.classList.add("down"); }

function renderResult() {
  const r = state.result, s = r.summary;
  const h = r.history;
  $("#sLast").textContent = fmt(s.last_close);
  $("#sLastSub").textContent = h.t[h.t.length - 1];
  $("#sPred").textContent = fmt(s.pred_close);
  $("#sPredSub").textContent = r.forecast.t[r.forecast.t.length - 1];
  $("#sChg").textContent = pct(s.change_pct);
  setDir($("#sChg"), s.change_pct);
  $("#sChgSub").textContent = `${s.pred_len} bars ahead`;
  $("#sProb").textContent = (s.prob_up * 100).toFixed(0) + "%";
  setDir($("#sProb"), s.prob_up - 0.5);
  $("#sProbBar").style.width = (s.prob_up * 100).toFixed(1) + "%";
  $("#sRange").textContent = `${fmt(s.pred_low)} – ${fmt(s.pred_high)}`;
  $("#sRangeSub").textContent = `${s.samples} paths · ${s.seconds}s · ${s.device}`;

  if (r.metrics) {
    const m = r.metrics;
    $("#metricsCard").classList.remove("hidden");
    const items = [
      ["MAE", fmt(m.mae)], ["RMSE", fmt(m.rmse)], ["MAPE", m.mape.toFixed(2) + "%"],
      ["Step direction acc.", (m.direction_acc * 100).toFixed(0) + "%"],
      ["Final direction", m.final_dir_correct ? "✓ correct" : "✗ wrong"],
      ["Inside 90% band", (m.coverage_90 * 100).toFixed(0) + "%"],
    ];
    $("#metrics").innerHTML = items.map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
  } else $("#metricsCard").classList.add("hidden");

  const f = r.forecast;
  const rows = f.t.map((t, i) => {
    const act = r.actual ? `<td>${fmt(r.actual.close[i])}</td>` : "";
    return `<tr><td>${t}</td><td>${fmt(f.open[i])}</td><td>${fmt(f.high[i])}</td><td>${fmt(f.low[i])}</td><td>${fmt(f.close[i])}</td>${act}<td>${fmt(r.bands.q5[i])} – ${fmt(r.bands.q95[i])}</td><td>${fmt(f.volume[i], 0)}</td></tr>`;
  }).join("");
  $("#fcTable").innerHTML = `<thead><tr><th>Time</th><th>Open</th><th>High</th><th>Low</th><th>Close</th>${r.actual ? "<th>Actual close</th>" : ""}<th>Close 90% range</th><th>Volume</th></tr></thead><tbody>${rows}</tbody>`;
  $("#tableCard").classList.remove("hidden");
  redraw();
}

$("#exportBtn").addEventListener("click", async () => {
  if (!state.result) return;
  const res = await fetch("/api/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ forecast: state.result.forecast }) });
  const blob = await res.blob();
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "kronos_forecast.csv" });
  a.click();
  URL.revokeObjectURL(a.href);
});

["showBand", "showPaths", "showCandles", "showVolume"].forEach((id) => $("#" + id).addEventListener("change", redraw));

// ------------------------------------------------------------------ chart
function redraw() {
  const el = $("#chart");
  if (!state.dataset) return;
  const up = css("--up"), down = css("--down"), accent = css("--accent"), actualC = css("--actual");
  const text = css("--text"), muted = css("--muted"), grid = css("--grid"), panel = css("--panel");
  const showVol = $("#showVolume").checked;
  const traces = [];
  const shapes = [];
  const r = state.result;
  const candle = (d, name, opts = {}) => ({
    type: "candlestick", name, x: d.t, open: d.open, high: d.high, low: d.low, close: d.close,
    increasing: { line: { color: opts.up || up, width: 1 }, fillcolor: opts.upFill || up },
    decreasing: { line: { color: opts.down || down, width: 1 }, fillcolor: opts.downFill || down },
    whiskerwidth: 0, opacity: opts.opacity ?? 1, showlegend: opts.legend ?? true, hoverinfo: "x+text",
    text: d.t.map((_, i) => `O ${fmt(d.open[i])}  H ${fmt(d.high[i])}  L ${fmt(d.low[i])}  C ${fmt(d.close[i])}`),
  });
  const volBars = (d, color, name) => ({
    type: "bar", x: d.t, y: d.volume, yaxis: "y2", name, marker: { color }, showlegend: false, hovertemplate: "Vol %{y:,.0f}<extra></extra>",
  });

  let title = state.dataset.name, sub;
  if (!r) {
    const c = state.dataset.candles;
    traces.push(candle(c, "History"));
    if (showVol) traces.push(volBars(c, c.close.map((v, i) => alpha(v >= c.open[i] ? up : down, 0.45)), "Volume"));
    if (state.mode === "backtest") {
      const idx = Math.min(+$("#endIdx").value, c.t.length - 1);
      const lb = +$("#lookback").value, pl = +$("#predLen").value;
      shapes.push(vrect(c.t[Math.max(0, idx - lb)], c.t[idx], alpha(accent, 0.08)));
      shapes.push(vrect(c.t[idx], c.t[Math.min(c.t.length - 1, idx + pl - 1)], alpha(actualC, 0.12)));
      shapes.push(vline(c.t[idx], accent));
      sub = "Shaded: context window (purple) and the held-out period the model will try to predict (amber)";
    } else {
      sub = `${state.dataset.rows.toLocaleString()} bars · forecast will start after ${state.dataset.end}`;
    }
  } else {
    const h = r.history, f = r.forecast, b = r.bands;
    const origin = h.t[h.t.length - 1];
    const fx = [origin, ...f.t];
    const last = h.close[h.close.length - 1];
    traces.push(candle(h, "History"));
    if ($("#showBand").checked) {
      traces.push({ x: fx, y: [last, ...b.q95], mode: "lines", line: { width: 0 }, hoverinfo: "skip", showlegend: false });
      traces.push({ x: fx, y: [last, ...b.q5], mode: "lines", line: { width: 0 }, fill: "tonexty", fillcolor: alpha(accent, 0.12), name: "90% band", hoverinfo: "skip" });
      traces.push({ x: fx, y: [last, ...b.q75], mode: "lines", line: { width: 0 }, hoverinfo: "skip", showlegend: false });
      traces.push({ x: fx, y: [last, ...b.q25], mode: "lines", line: { width: 0 }, fill: "tonexty", fillcolor: alpha(accent, 0.2), name: "50% band", hoverinfo: "skip" });
    }
    if ($("#showPaths").checked && r.paths.length) {
      r.paths.forEach((p, i) => traces.push({
        x: fx, y: [last, ...p], mode: "lines", line: { width: 1, color: alpha(accent, 0.35) },
        hoverinfo: "skip", showlegend: i === 0, name: "Sample paths", legendgroup: "paths",
      }));
    }
    if ($("#showCandles").checked) {
      traces.push(candle(f, "Forecast OHLC", {
        up: alpha(up, 0.9), down: alpha(down, 0.9), upFill: alpha(up, 0.25), downFill: alpha(down, 0.25),
      }));
    }
    traces.push({ x: fx, y: [last, ...f.close], mode: "lines", name: "Forecast close (mean)", line: { color: accent, width: 2.5 }, hovertemplate: "Forecast %{y:.4f}<extra></extra>" });
    if (r.actual) {
      traces.push({ x: [origin, ...r.actual.t], y: [last, ...r.actual.close], mode: "lines", name: "Actual close", line: { color: actualC, width: 2, dash: "dot" }, hovertemplate: "Actual %{y:.4f}<extra></extra>" });
    }
    if (showVol) {
      traces.push(volBars(h, h.close.map((v, i) => alpha(v >= h.open[i] ? up : down, 0.45)), "Volume"));
      traces.push(volBars(f, alpha(accent, 0.45), "Forecast volume"));
    }
    shapes.push(vline(origin, muted));
    shapes.push(vrect(origin, f.t[f.t.length - 1], alpha(accent, 0.04)));
    sub = `${r.summary.model} · ${r.summary.lookback} bars of context → ${r.summary.pred_len} bars ahead · ${r.summary.samples} sample paths`;
    title = `${state.dataset.name} — ${state.mode === "backtest" ? "Backtest" : "Forecast"}`;
  }
  $("#chartTitle").textContent = title;
  $("#chartSub").textContent = sub;

  const layout = {
    paper_bgcolor: panel, plot_bgcolor: panel, font: { family: "Inter, sans-serif", color: text, size: 11 },
    margin: { l: 56, r: 16, t: 8, b: 40 }, hovermode: "x unified", dragmode: "zoom",
    hoverlabel: { bgcolor: css("--panel-2"), bordercolor: css("--border"), font: { color: text, family: "JetBrains Mono, monospace", size: 11 } },
    legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", bgcolor: "rgba(0,0,0,0)", font: { color: muted } },
    xaxis: {
      type: "category", rangeslider: { visible: false }, showgrid: false, nticks: 8,
      tickfont: { color: muted }, linecolor: grid, showspikes: true, spikemode: "across", spikethickness: 1, spikecolor: muted, spikedash: "dot",
    },
    yaxis: { domain: showVol ? [0.24, 1] : [0, 1], gridcolor: grid, zeroline: false, tickfont: { color: muted }, side: "left", fixedrange: false },
    yaxis2: { domain: [0, 0.18], gridcolor: grid, zeroline: false, tickfont: { color: muted }, showticklabels: true, nticks: 3, visible: showVol },
    shapes, bargap: 0.15,
  };
  if (r) {
    // focus on the most recent part of the context + forecast
    const all = r.history.t.length + r.forecast.t.length;
    const startIdx = Math.max(0, r.history.t.length - Math.max(r.forecast.t.length * 3, 120));
    layout.xaxis.range = [startIdx - 0.5, all - 0.5];
  }
  el.querySelector(".empty")?.remove();
  Plotly.react(el, traces, layout, { responsive: true, displaylogo: false, modeBarButtonsToRemove: ["lasso2d", "select2d"] });
}

function vline(x, color) { return { type: "line", xref: "x", yref: "paper", x0: x, x1: x, y0: 0, y1: 1, line: { color, width: 1, dash: "dash" } }; }
function vrect(x0, x1, fill) { return { type: "rect", xref: "x", yref: "paper", x0, x1, y0: 0, y1: 1, fillcolor: fill, line: { width: 0 }, layer: "below" }; }
function alpha(color, a) {
  const c = color.trim();
  if (c.startsWith("#")) {
    const n = c.length === 4 ? c.slice(1).split("").map((x) => x + x).join("") : c.slice(1);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
    return `rgba(${r},${g},${b},${a})`;
  }
  return c;
}

// ------------------------------------------------------------------ boot
refreshStatus().then(() => { updateRanges(); clearResultUI(); }).catch((e) => toast("Server not reachable: " + e.message, true));
