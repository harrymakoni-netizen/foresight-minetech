"""Proof test 2 (spec §17 Phase 0): walkable polygons from a 10-junction
network; close tunnels; people reroute or are counted as cut off."""
import json
import sys

from services.simulator.test_escape import scenario
from services.simulator import escape


def summary(name, closures):
    r = escape.run(scenario(closures, recordTrajectories=False))
    east = [p["atSeconds"] for p in r["people"] if p["id"].startswith("e") and p["atSeconds"] is not None]
    return {"case": name, "closures": closures, "totals": r["totals"], "times": r["times"],
            "eastLastArrivalSeconds": max(east) if east else None,
            "cutOff": [(p["name"], p["reason"]) for p in r["people"] if p["outcome"] == "cut-off"],
            "durationMs": r["diagnostics"]["durationMs"]}


if __name__ == "__main__":
    out = [summary("open network", []),
           summary("T2 closed: reroute", [{"tunnelId": "T2", "atSeconds": 0}]),
           summary("T2+T3+T10 closed: North isolated", [{"tunnelId": t, "atSeconds": 0} for t in ("T2", "T3", "T10")]),
           summary("T4 closes at 10 s with people inside", [{"tunnelId": "T4", "atSeconds": 10}])]
    json.dump(out, sys.stdout, indent=1)
