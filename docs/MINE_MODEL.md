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


## Importing a surveyor's DXF (phase 9)

Mine → Import. ASCII DXF only (not DWG or binary DXF); `LINE`, `LWPOLYLINE` and `POLYLINE` centrelines are read and everything else on a layer is listed as "not read".

1. **Layers and unit.** Pick the centreline layers. Choose the drawing unit yourself (the file's `$INSUNITS` is only shown as a hint; a file that declares none gives no default). Coordinates are converted to metres and otherwise kept as drawn.
2. **Detection.** Line ends closer than the snap distance (default 0.1 m) are joined; a line end resting on another line splits it there (T-junction); crossings without an end are not junctions. Dead ends within the near-miss distance (default 3 m) of something else are **listed, never joined**: tick the ones that are the same drive and rebuild. Isolated parts are reported. A bent polyline keeps its drawn path length; arcs (bulges) are approximated by chords and counted in a warning.
3. **Elevations.** Use the drawing's Z values (only on lines that carry any: a flat layer is never read as 0 m), one constant (recorded as an *assumed* value), or leave them not entered.
4. **Confirm and create a draft.** Both the unit and the elevation handling must be confirmed. The result is a **draft** (never published) with `survey-plan` provenance. A centreline drawing has no tunnel widths, exits, zones, sumps or pumps, so preflight blocks runs and publishing until you add them in the editor.

Limits: 4 MB per file; at most 5000 line ends. Larger drawings: export only the centreline layers or split them.

## Base maps and subsidence marks (phase 9)

Mine → Surface. A GeoTIFF orthophoto or elevation model (metre-based projected CRS such as UTM, north-up, up to 3 MB; reduce larger ones first, for example `gdal_translate -outsize 2000 0`) is read in the worker and shown as a reduced picture. You enter the map coordinate the plan's origin sits at and confirm both are in metres; rotation is not applied. It is a picture to read the plan against and never changes a tunnel. Elevation models are drawn with a plain colour ramp and report their real value range, not assumed to be metres.

A subsidence mark (click the plan, describe it, add a photo of up to 2.5 MB) is placed **near a zone** when it is within 100 m (plan distance) of one of that zone's tunnels. That distance is a development default, not a validated value. A mark near a zone raises a concern for review; a mark farther away is only recorded. Marks can be retracted with a reason.
