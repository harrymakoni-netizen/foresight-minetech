# Mine model

Foresight represents a mine as a **tunnel network** (spec §8), not a reconstruction. The 3D view is a schematic of entered values. Every value records provenance: `measured`, `survey-plan`, `assumed` or `default`, with a note, author and time (`provenance["<elementId>.<field>"]`). Unknown values are `null` and block the engines that need them; they are never filled with zero.

## Schema (`mine-model-1`, `lib/domain/mine-model.ts`, JSON schema in `contracts/`)

Junctions (x, y metres in a local plan datum; elevation), tunnels (from/to, width, height, box/arched, walkable, optional entered length and airway resistance), exits (shaft/adit/incline/portal, usable for escape, hoist cage capacity, loading and trip times, ladder climb time, link to a check-in shaft), refuges (capacity, air supply m³), sumps (level–volume table, danger level, starting volume, inflow, tunnels closed at danger level), pumps (effective capacity, duty/backup), fans, doors, zones (tunnels, shafts) and reviewed storage links.

## Revisions

A training workspace starts with the fictional **Mavambo training mine** published as revision 1. Edit by starting a draft (Mine → Edit). Drafts can be saved freely; **publishing requires a preflight with no blocking errors**. Published revisions never change; the previous one becomes *superseded*. Every scenario run stores the revision it used, so it can be reproduced. Zones in check-ins, reports and incidents follow the published revision (earlier zone ids remain valid for historical records).

Demo reset: Mine → Edit → *Demo reset: restore training mine* (or `POST /api/workspace/mine-model/reset-training`) publishes the template as a new revision and restores the training messaging configuration. Nothing is deleted.

## Preflight (blocks runs, shown live in the editor)

Connectivity and isolated parts; tunnels crossing in plan without a junction (the 2-D escape engine would otherwise invent a connection — model different levels separately); elevation consistency (> 60 % slope is an error, > 35 % walkway a warning); zones without a walkable route to an exit or refuge; exits, refuges, sumps on known junctions; refuge capacity and air supply; pump capacities and sump attachment; sump geometry ordering and danger level; fans and doors on known airways; units confirmed; entered length versus geometry; values without provenance; storage links reviewed before flooding beyond a single sump. Each issue names the engines it blocks (escape, flooding, routes, cage, ventilation).

## How engines use it

* Escape (`services/simulator/escape.py`): walkable polygons are tunnel centrelines buffered by half their width; closures split the run; people start **evenly spread along their zone's tunnel centrelines** with a seeded lateral offset (falls back to seeded random placement only if the zone is too crowded, and records that).
* Flooding (`lumped-water-1.0.0`, unchanged): one sump per run; the sump's danger level closes the tunnels listed in `closesTunnelIds` from that instant (one-way handoff). The engine labels storage with `zone-a/b/c` only; a sump in another zone is reported as a limitation rather than relabelled.
* Not yet built: DXF import, GeoTIFF base maps, subsidence marks (phase 9); ventilation (phase 10).
