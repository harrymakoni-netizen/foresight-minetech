"""Proof test 1 (spec §17 Phase 0): JuPedSim runs 100 agents in a tunnel-shaped
polygon on CPU and writes trajectories. Prints a JSON summary; no numbers are
invented: every value is measured from the run."""
import json
import pathlib
import platform
import sys
import tempfile
import time

import jupedsim as jps
import shapely
from shapely.geometry import LineString

# An L-shaped drift 3 m wide: 120 m east then 60 m north to an exit portal.
centreline = LineString([(0, 0), (120, 0), (120, 60)])
tunnel = centreline.buffer(1.5, cap_style="flat", join_style="mitre")
exit_area = shapely.Polygon([(118.5, 57), (121.5, 57), (121.5, 60), (118.5, 60)])
start_area = shapely.Polygon([(1, -1.4), (40, -1.4), (40, 1.4), (1, 1.4)])


def main(seed: int = 42) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        out = pathlib.Path(tmp) / "trajectory.sqlite"
        sim = jps.Simulation(
            model=jps.CollisionFreeSpeedModel(),
            geometry=tunnel,
            dt=0.05,
            trajectory_writer=jps.SqliteTrajectoryWriter(output_file=out, every_nth_frame=10),
        )
        exit_id = sim.add_exit_stage(exit_area)
        corner = sim.add_waypoint_stage((120, 0), 1.0)
        journey = jps.JourneyDescription([corner, exit_id])
        journey.set_transition_for_stage(corner, jps.Transition.create_fixed_transition(exit_id))
        journey_id = sim.add_journey(journey)
        positions = jps.distribute_by_number(
            polygon=start_area, number_of_agents=100, distance_to_agents=0.4,
            distance_to_polygon=0.25, seed=seed,
        )
        for p in positions:
            sim.add_agent(jps.CollisionFreeSpeedModelAgentParameters(
                position=p, journey_id=journey_id, stage_id=corner, desired_speed=1.2, radius=0.2))
        started = time.perf_counter()
        exits = []
        horizon_s = 900
        while sim.agent_count() > 0 and sim.elapsed_time() < horizon_s:
            before = sim.agent_count()
            sim.iterate()
            removed = before - sim.agent_count()
            exits.extend([sim.elapsed_time()] * removed)
        wall = time.perf_counter() - started
        size = out.stat().st_size if out.exists() else 0
        return {
            "proof": "jupedsim-100-agents",
            "jupedsim": jps.__version__ if hasattr(jps, "__version__") else jps.get_build_info().library_version,
            "python": sys.version.split()[0], "machine": platform.machine(),
            "seed": seed, "agents": len(positions), "reachedExit": len(exits),
            "remainingAtHorizon": sim.agent_count(), "horizonSeconds": horizon_s,
            "firstExitSeconds": round(min(exits), 2) if exits else None,
            "lastExitSeconds": round(max(exits), 2) if exits else None,
            "simulatedSeconds": round(sim.elapsed_time(), 2),
            "wallClockSeconds": round(wall, 2), "trajectoryBytes": size,
            "passed": len(exits) + sim.agent_count() == len(positions) and size > 0,
        }


if __name__ == "__main__":
    print(json.dumps(main(), indent=2))
