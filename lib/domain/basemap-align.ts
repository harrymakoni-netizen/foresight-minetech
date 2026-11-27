// Placing a georeferenced base map under the mine plan. The plan has its own
// origin (0, 0) and axes in metres. A map coordinate is
//   map = origin + R(theta) * plan
// where theta is the angle (degrees, counter-clockwise) from map east to the
// plan's +x axis. With theta = 0 the two grids are parallel. Pure.
export type Alignment = { planOriginEasting: number; planOriginNorthing: number; rotationDegrees?: number };
const rad = (a: Alignment) => ((a.rotationDegrees ?? 0) * Math.PI) / 180;
export function planToMap(a: Alignment, x: number, y: number) {
  const t = rad(a), c = Math.cos(t), s = Math.sin(t);
  return { easting: a.planOriginEasting + x * c - y * s, northing: a.planOriginNorthing + x * s + y * c };
}
export function mapToPlan(a: Alignment, easting: number, northing: number) {
  const t = rad(a), c = Math.cos(t), s = Math.sin(t);
  const ox = easting - a.planOriginEasting, oy = northing - a.planOriginNorthing;
  return { x: ox * c + oy * s, y: -ox * s + oy * c };
}
/** SVG matrix (a b c d e f) that draws an image of the map's rectangle in plan space, given the plan -> screen mapping sx/sy. */
export function imageMatrix(a: Alignment, bounds: { west: number; north: number }, sx: (x: number) => number, sy: (y: number) => number) {
  const t = rad(a), c = Math.cos(t), s = Math.sin(t);
  const nw = mapToPlan(a, bounds.west, bounds.north); // top-left corner of the picture, in plan coordinates
  // Map east in plan space is (cos, -sin); the screen flips y, so the image's x axis is (cos, +sin) and its y axis (down = south) is (-sin, cos).
  return { a: c, b: s, c: -s, d: c, e: sx(nw.x), f: sy(nw.y) };
}
