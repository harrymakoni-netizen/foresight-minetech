// Plan <-> map geometry for base maps (hand-worked angles).
import test from "node:test";
import assert from "node:assert/strict";
import { imageMatrix, mapToPlan, planToMap } from "../lib/domain/basemap-align.ts";

const close = (a: number, b: number, d = 1e-9) => assert.ok(Math.abs(a - b) < d, `${a} vs ${b}`);
const origin = { planOriginEasting: 310000, planOriginNorthing: 8000100 };

test("no rotation: the map is the plan shifted by the origin", () => {
  assert.deepEqual(planToMap(origin, 10, 20), { easting: 310010, northing: 8000120 });
  assert.deepEqual(mapToPlan(origin, 310010, 8000120), { x: 10, y: 20 });
});
test("90 degrees counter-clockwise: plan +x points to map north, plan +y to map west", () => {
  const a = { ...origin, rotationDegrees: 90 };
  const p = planToMap(a, 1, 0);
  close(p.easting, 310000);
  close(p.northing, 8000101);
  const q = planToMap(a, 0, 1);
  close(q.easting, 309999);
  close(q.northing, 8000100);
});
test("45 degrees: a plan point 100 m along x lies 70.71 m east and 70.71 m north of the origin", () => {
  const p = planToMap({ ...origin, rotationDegrees: 45 }, 100, 0);
  close(p.easting - 310000, 100 * Math.SQRT1_2, 1e-9);
  close(p.northing - 8000100, 100 * Math.SQRT1_2, 1e-9);
});
test("map -> plan inverts plan -> map for any angle", () => {
  for (const deg of [-180, -135, -30, 0, 17.5, 90, 179]) {
    const a = { ...origin, rotationDegrees: deg };
    const m = planToMap(a, 123.4, -56.7);
    const p = mapToPlan(a, m.easting, m.northing);
    close(p.x, 123.4, 1e-6);
    close(p.y, -56.7, 1e-6);
  }
});
test("image matrix: unrotated it is a translation to the plan position of the map's north-west corner", () => {
  const m = imageMatrix(origin, { west: 310000 - 50, north: 8000100 + 30 }, (x) => x + 40, (y) => 220 - y);
  assert.deepEqual([m.a, m.b, m.c, m.d, m.e, m.f], [1, 0, -0, 1, -10, 190]);
  const r = imageMatrix({ ...origin, rotationDegrees: 90 }, { west: 310000, north: 8000100 }, (x) => x, (y) => y);
  close(r.a, 0);
  close(r.b, 1);
  close(r.c, -1);
  close(r.d, 0);
});
