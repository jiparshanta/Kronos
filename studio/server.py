"""Kronos Studio — a small web UI for forecasting K-lines with Kronos.

Run:  python studio/server.py   (then open http://127.0.0.1:7860)
"""
import io
import os
import sys
import threading
import time
import uuid

import numpy as np
import pandas as pd
from flask import Flask, jsonify, request, send_from_directory

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
PRICE_COLS = ["open", "high", "low", "close"]
ALL_COLS = PRICE_COLS + ["volume", "amount"]

MODELS = {
    "kronos-mini": {"name": "Kronos-mini", "model_id": "NeoQuasar/Kronos-mini",
                    "tokenizer_id": "NeoQuasar/Kronos-Tokenizer-2k", "context": 2048, "params": "4.1M"},
    "kronos-small": {"name": "Kronos-small", "model_id": "NeoQuasar/Kronos-small",
                     "tokenizer_id": "NeoQuasar/Kronos-Tokenizer-base", "context": 512, "params": "24.7M"},
    "kronos-base": {"name": "Kronos-base", "model_id": "NeoQuasar/Kronos-base",
                    "tokenizer_id": "NeoQuasar/Kronos-Tokenizer-base", "context": 512, "params": "102.3M"},
}

SAMPLES = {
    "sample-5min": {"name": "A-share 5-min bars (sample)", "path": os.path.join(ROOT, "tests", "data", "regression_input.csv")},
}

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024
app.json.sort_keys = False

DATASETS = {}  # id -> {"name", "df"}
STATE = {"key": None, "predictor": None, "device": None, "loading": None, "error": None}
LOCK = threading.Lock()


# ----------------------------------------------------------------------------- data

def normalize_df(df):
    """Map arbitrary OHLCV column names onto the format Kronos expects."""
    df = df.copy()
    df.columns = [str(c).strip().lower().replace(" ", "_") for c in df.columns]
    aliases = {
        "timestamps": ["timestamps", "timestamp", "date", "datetime", "time", "open_time", "trade_date"],
        "open": ["open", "o"], "high": ["high", "h"], "low": ["low", "l"], "close": ["close", "c", "adj_close"],
        "volume": ["volume", "vol", "v"], "amount": ["amount", "turnover", "quote_volume", "value"],
    }
    rename = {}
    for target, names in aliases.items():
        if target in df.columns:
            continue
        for n in names:
            if n in df.columns and n not in rename:
                rename[n] = target
                break
    df = df.rename(columns=rename)

    missing = [c for c in ["timestamps"] + PRICE_COLS if c not in df.columns]
    if missing:
        raise ValueError(f"Missing required column(s): {', '.join(missing)}. "
                         "Need a timestamp column plus open, high, low, close.")

    ts = df["timestamps"]
    if pd.api.types.is_numeric_dtype(ts):
        unit = "ms" if ts.max() > 1e11 else "s"
        df["timestamps"] = pd.to_datetime(ts, unit=unit)
    else:
        df["timestamps"] = pd.to_datetime(ts, utc=True, errors="coerce").dt.tz_localize(None)
    for c in ALL_COLS:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    if "volume" not in df.columns:
        df["volume"] = 0.0
    if "amount" not in df.columns:
        df["amount"] = df["volume"] * df[PRICE_COLS].mean(axis=1)

    df = df.dropna(subset=["timestamps"] + PRICE_COLS)
    df[["volume", "amount"]] = df[["volume", "amount"]].fillna(0.0)
    df = df.sort_values("timestamps").drop_duplicates("timestamps").reset_index(drop=True)
    if len(df) < 20:
        raise ValueError(f"Only {len(df)} usable rows after cleaning; need at least 20.")
    return df[["timestamps"] + ALL_COLS]


def infer_step(ts):
    diffs = ts.diff().dropna()
    return diffs.median() if len(diffs) else pd.Timedelta(days=1)


def describe(ds_id):
    df = DATASETS[ds_id]["df"]
    return {
        "id": ds_id, "name": DATASETS[ds_id]["name"], "rows": len(df),
        "start": str(df["timestamps"].iloc[0]), "end": str(df["timestamps"].iloc[-1]),
        "step": str(infer_step(df["timestamps"])), "last_close": float(df["close"].iloc[-1]),
        "has_volume": bool(df["volume"].abs().sum() > 0),
    }


def register(name, df):
    ds_id = uuid.uuid4().hex[:10]
    DATASETS[ds_id] = {"name": name, "df": normalize_df(df)}
    return describe(ds_id)


def candles(df):
    return {
        "t": df["timestamps"].dt.strftime("%Y-%m-%d %H:%M:%S").tolist(),
        **{c: np.round(df[c].to_numpy(dtype=float), 6).tolist() for c in ALL_COLS},
    }


# ----------------------------------------------------------------------------- model

def build_predictor(key, device):
    from model import Kronos, KronosTokenizer, KronosPredictor
    cfg = MODELS[key]
    tokenizer = KronosTokenizer.from_pretrained(cfg["tokenizer_id"])
    model = Kronos.from_pretrained(cfg["model_id"])
    tokenizer.eval()
    model.eval()
    return KronosPredictor(model, tokenizer, device=device, max_context=cfg["context"])


def ensure_model(key, device=None):
    with LOCK:
        if STATE["key"] == key and STATE["predictor"] is not None and (device in (None, STATE["device"])):
            return STATE["predictor"]
        STATE.update(loading=key, error=None)
        try:
            predictor = build_predictor(key, device or None)
        except Exception as e:
            STATE.update(loading=None, error=f"Could not load {MODELS[key]['name']}: {e}")
            raise
        STATE.update(key=key, predictor=predictor, device=predictor.device, loading=None)
        return predictor


# ----------------------------------------------------------------------------- routes

@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/api/status")
def status():
    import torch
    devices = ["cpu"]
    if torch.cuda.is_available():
        devices.insert(0, "cuda:0")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        devices.insert(0, "mps")
    return jsonify({
        "models": MODELS, "loaded": STATE["key"], "device": STATE["device"],
        "loading": STATE["loading"], "error": STATE["error"], "devices": devices,
        "samples": {k: v["name"] for k, v in SAMPLES.items() if os.path.exists(v["path"])},
    })


@app.post("/api/model/load")
def load_model():
    body = request.get_json(force=True)
    key = body.get("model", "kronos-small")
    if key not in MODELS:
        return jsonify({"error": f"Unknown model {key}"}), 400
    t0 = time.time()
    try:
        p = ensure_model(key, body.get("device") or None)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"loaded": key, "device": p.device, "seconds": round(time.time() - t0, 1)})


@app.post("/api/data/sample")
def load_sample():
    key = request.get_json(force=True).get("sample")
    if key not in SAMPLES:
        return jsonify({"error": "Unknown sample"}), 400
    return jsonify(register(SAMPLES[key]["name"], pd.read_csv(SAMPLES[key]["path"])))


@app.post("/api/data/upload")
def upload():
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "No file uploaded"}), 400
    raw = f.read()
    try:
        if f.filename.lower().endswith((".feather", ".ftr")):
            df = pd.read_feather(io.BytesIO(raw))
        elif f.filename.lower().endswith(".parquet"):
            df = pd.read_parquet(io.BytesIO(raw))
        else:
            df = pd.read_csv(io.BytesIO(raw), sep=None, engine="python")
        return jsonify(register(f.filename, df))
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.post("/api/data/market")
def market():
    body = request.get_json(force=True)
    symbol = (body.get("symbol") or "").strip().upper()
    interval = body.get("interval", "1d")
    period = body.get("period", "2y")
    if not symbol:
        return jsonify({"error": "Enter a ticker symbol"}), 400
    try:
        import yfinance as yf
    except ImportError:
        return jsonify({"error": "yfinance is not installed. Run: pip install yfinance"}), 400
    try:
        df = yf.Ticker(symbol).history(period=period, interval=interval, auto_adjust=False)
    except Exception as e:
        return jsonify({"error": f"Download failed: {e}"}), 502
    if df is None or df.empty:
        return jsonify({"error": f"No data returned for {symbol} ({interval}, {period})"}), 404
    df = df.reset_index()
    try:
        return jsonify(register(f"{symbol} · {interval}", df))
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.get("/api/data/<ds_id>")
def get_data(ds_id):
    if ds_id not in DATASETS:
        return jsonify({"error": "Dataset not found (server restarted?)"}), 404
    return jsonify({**describe(ds_id), "candles": candles(DATASETS[ds_id]["df"])})


@app.post("/api/predict")
def predict():
    body = request.get_json(force=True)
    ds_id = body.get("dataset")
    if ds_id not in DATASETS:
        return jsonify({"error": "Load a dataset first"}), 400
    df = DATASETS[ds_id]["df"]
    key = body.get("model", "kronos-small")
    if key not in MODELS:
        return jsonify({"error": f"Unknown model {key}"}), 400

    lookback = int(body.get("lookback", 400))
    pred_len = int(body.get("pred_len", 60))
    samples = max(1, min(int(body.get("samples", 5)), 64))
    T = float(body.get("temperature", 1.0))
    top_p = float(body.get("top_p", 0.9))
    top_k = int(body.get("top_k", 0))
    mode = body.get("mode", "future")  # "future" or "backtest"
    seed = body.get("seed")

    if pred_len < 1 or lookback < 10:
        return jsonify({"error": "Lookback must be ≥ 10 and horizon ≥ 1"}), 400

    if mode == "backtest":
        end = body.get("end_index")
        end = len(df) - pred_len if end is None else int(end)
        end = max(lookback, min(end, len(df) - pred_len))
        if end - lookback < 0 or end + pred_len > len(df):
            return jsonify({"error": f"Not enough rows: backtest needs lookback + horizon = {lookback + pred_len}, dataset has {len(df)}"}), 400
    else:
        end = len(df)
    start = max(0, end - lookback)
    hist = df.iloc[start:end].reset_index(drop=True)

    if mode == "backtest":
        actual = df.iloc[end:end + pred_len].reset_index(drop=True)
        y_ts = actual["timestamps"]
    else:
        actual = None
        step = infer_step(hist["timestamps"])
        y_ts = pd.Series(pd.date_range(hist["timestamps"].iloc[-1] + step, periods=pred_len, freq=step))

    try:
        predictor = ensure_model(key, body.get("device") or None)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    import torch
    if seed not in (None, ""):
        torch.manual_seed(int(seed))
        np.random.seed(int(seed))

    t0 = time.time()
    x = hist[ALL_COLS]
    try:
        with torch.no_grad():
            # Replicate the series so every sample path is returned individually (for uncertainty bands).
            outs = predictor.predict_batch([x] * samples, [hist["timestamps"]] * samples, [y_ts] * samples,
                                           pred_len=pred_len, T=T, top_k=top_k, top_p=top_p,
                                           sample_count=1, verbose=False)
    except Exception as e:
        return jsonify({"error": f"Prediction failed: {e}"}), 500
    elapsed = time.time() - t0

    paths = np.stack([o[ALL_COLS].to_numpy(dtype=float) for o in outs])  # (samples, pred_len, 6)
    mean = paths.mean(axis=0)
    close_paths = paths[:, :, 3]
    q = {f"q{p}": np.round(np.percentile(close_paths, p, axis=0), 6).tolist() for p in (5, 25, 50, 75, 95)}

    forecast = pd.DataFrame(mean, columns=ALL_COLS)
    forecast.insert(0, "timestamps", pd.to_datetime(y_ts.values))
    last_close = float(hist["close"].iloc[-1])
    final = close_paths[:, -1]

    result = {
        "history": candles(hist),
        "forecast": candles(forecast),
        "bands": q,
        "paths": np.round(close_paths, 6).tolist() if samples <= 32 else [],
        "summary": {
            "last_close": last_close,
            "pred_close": float(mean[-1, 3]),
            "change_pct": float((mean[-1, 3] / last_close - 1) * 100),
            "pred_high": float(mean[:, 1].max()),
            "pred_low": float(mean[:, 2].min()),
            "prob_up": float((final > last_close).mean()),
            "samples": samples, "seconds": round(elapsed, 2),
            "model": MODELS[key]["name"], "device": predictor.device,
            "lookback": len(hist), "pred_len": pred_len,
        },
    }

    if actual is not None:
        a = actual["close"].to_numpy(dtype=float)
        p = mean[:, 3]
        prev = np.concatenate([[last_close], a[:-1]])
        dir_acc = float(np.mean(np.sign(p - prev) == np.sign(a - prev)))
        result["actual"] = candles(actual)
        result["metrics"] = {
            "mae": float(np.mean(np.abs(p - a))),
            "mape": float(np.mean(np.abs((p - a) / np.where(a == 0, np.nan, a))) * 100),
            "rmse": float(np.sqrt(np.mean((p - a) ** 2))),
            "direction_acc": dir_acc,
            "final_dir_correct": bool(np.sign(p[-1] - last_close) == np.sign(a[-1] - last_close)),
            "coverage_90": float(np.mean((a >= np.array(q["q5"])) & (a <= np.array(q["q95"])))),
        }
    return jsonify(result)


@app.post("/api/export")
def export_csv():
    body = request.get_json(force=True)
    fc = body.get("forecast") or {}
    df = pd.DataFrame({"timestamps": fc.get("t", []), **{c: fc.get(c, []) for c in ALL_COLS}})
    return df.to_csv(index=False), 200, {"Content-Type": "text/csv",
                                         "Content-Disposition": "attachment; filename=kronos_forecast.csv"}


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Kronos Studio web UI")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=7860)
    args = ap.parse_args()
    print(f"\n  Kronos Studio → http://{args.host}:{args.port}\n")
    app.run(host=args.host, port=args.port, debug=False, threaded=True)
