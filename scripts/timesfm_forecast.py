#!/usr/bin/env python3
"""Forecast CPI and the cash rate 8 quarters ahead with Google TimesFM 2.5 (CPU) -> data/forecast_timesfm.json."""
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import timesfm
import torch

DATA = Path(__file__).resolve().parent.parent / "data"
H = 8
MODEL = "google/timesfm-2.5-200m-pytorch"


def add_months(ym, n):
    y, m = map(int, ym.split("-"))
    t = y * 12 + m - 1 + n
    return f"{t // 12}-{t % 12 + 1:02d}"


macro = json.loads((DATA / "macro.json").read_text())
cpi = macro["cpi"]["history"]  # already quarterly, year-ended %
cash = [p for p in macro["cashRate"]["history"] if p["date"][5:] in ("03", "06", "09", "12")]  # end-of-quarter
series = {"cpi": cpi, "cashRate": cash}

torch.set_num_threads(2)
model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(MODEL)
model.compile(timesfm.ForecastConfig(
    max_context=256, max_horizon=H, normalize_inputs=True, use_continuous_quantile_head=True,
    force_flip_invariance=True, infer_is_positive=False, fix_quantile_crossing=True))
point, q = model.forecast(horizon=H, inputs=[np.array([p["value"] for p in s], dtype=np.float32) for s in series.values()])
# q[..., 0] is the mean; 1..9 are the 10th..90th percentiles, so index 1 = p10 and 9 = p90.

out = {"generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "model": MODEL}
for i, (k, s) in enumerate(series.items()):
    out[k] = [
        {"date": add_months(s[-1]["date"], 3 * (h + 1)), "value": round(float(q[i, h, 5]), 2),
         "lo": round(float(q[i, h, 1]), 2), "hi": round(float(q[i, h, 9]), 2)}
        for h in range(H)
    ]
(DATA / "forecast_timesfm.json").write_text(json.dumps(out, indent=2) + "\n")
print("wrote forecast_timesfm.json")
