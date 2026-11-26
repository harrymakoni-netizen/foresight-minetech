# Render setup — engines and messaging service

The web app runs on Vercel (`foresight-minetech-v2`). Two things cannot run
there: the Python simulation engines (escape, flood-escape chain, Time to act)
and the always-on messaging service (overdue-return scheduler, escalation,
gateway polling). Both run in **one Render web service** defined by
`render.yaml` and built from `deploy/render.Dockerfile`.

```
Vercel (web app) ──jobs──▶ Render: foresight-engine ──▶ Neon PostgreSQL
                                 ├─ simulator worker (Python, port $PORT)
                                 └─ messaging service (Node, no port)
```

`deploy/render-start.sh` starts both processes and exits if either stops, so
Render restarts the container.

## 1. Create the service

1. Render dashboard → **New → Blueprint**.
2. Connect GitHub repository `harrymakoni-netizen/foresight-minetech` and pick
   branch `claude/minetech-v2`. Render reads `render.yaml`.
3. It proposes one service, `foresight-engine` (Docker, Starter plan, Virginia,
   health check `/healthz`). Check the price Render shows before confirming.

## 2. Enter the three secrets

Render asks for these because they are marked `sync: false`. Paste them into the
Render form only — never into chat, commits or tickets.

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Neon console → your database → Connection string (pooled). The same database the Vercel project uses. |
| `FORESIGHT_WORKER_TOKEN` | Must equal the value on the Vercel project (Settings → Environment Variables). |
| `FORESIGHT_PERSONAL_DATA_KEY` | Must equal the value on the Vercel project, or sealed phone numbers cannot be read. |

`MESSAGING_MODE` is preset to `dry-run`. Do not change it here: `live` is chosen
by an administrator in workspace settings, and sends are still limited to the
allow-list.

## 3. Deploy and check

First build takes several minutes (JuPedSim, PedPy, SciPy). When it is live:

- `https://<service>.onrender.com/healthz` → `{"status":"ok"}`
- `https://<service>.onrender.com/health` → `401` without the worker token
  (expected — the engines are not public).

## 4. Connect Vercel

Set `FORESIGHT_SIMULATOR_URL` to the exact URL shown on the Render service page (Render may add a suffix, e.g. `https://foresight-engine-xxxx.onrender.com`) on the Vercel
project (Production and Preview) and redeploy. Then in the app:

- **Scenarios → Run scenario** completes and shows balanced totals.
- **Find latest backup start** returns a tested boundary with its search range.
- The sidebar system status shows the scheduler **Running** (heartbeat from the
  messaging service).

## Notes

- After pulling new commits, **Manual Deploy** the service: the cage (SimPy), DXF (ezdxf) and base map (rasterio) engines only exist in the newer image. `/health` (with the worker token) should list `cage-simpy-1.0.0`, `dxf-ezdxf-1.0.0` and `basemap-rasterio-1.0.0`.
- The image is about 2 GB (JuPedSim, SciPy, GDAL). rasterio needs `libexpat`, which the Dockerfile copies from its build stage.
- `autoDeploy` is off: deploy new commits with **Manual Deploy** in Render.
- JuPedSim is installed with `--no-deps`; its GUI dependencies (PySide6, VTK,
  ~1.2 GB) are not used by the engines.
- Job records live in `/tmp` inside the container and are lost on restart; run
  results the app needs are stored in PostgreSQL by the web app.
- The image was built and run locally against a fresh PostgreSQL database:
  `/healthz` ok, `/health` 401 without the token and lists all four engines with
  it, and both the messaging-service and gateway heartbeats were written.
- If a build fails, open the service → **Events/Logs** in Render and look at the
  last red lines of the build log.
