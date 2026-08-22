/**
 * A Jacksonville CRM opens on Jacksonville.
 *
 * Duval County is the city of Jacksonville plus the beaches plus Baldwin, a
 * town of 1,400 at the far western edge thirty kilometres from downtown. The
 * map used to open on a county-wide camera, so Baldwin led the frame in every
 * screenshot of a product nobody opens to look at Baldwin.
 *
 * The framing is asserted as a rectangle rather than a zoom number because a
 * zoom frames a different amount of county on every monitor, and the fact being
 * defended is *which places are on screen*.
 *
 * The list's own Baldwin-first ordering is a separate defect in the criteria
 * SQL tiebreak and is not this file's business.
 */

import { describe, expect, it } from "vitest";

import {
  JACKSONVILLE_BOUNDS,
  boundsContain,
  parseMapBounds,
  publicDataConfig,
  type MapBounds,
} from "@/lib/data/public-config";

/** Places a reviewer would recognise, and the ones they would not. */
const DOWNTOWN = { lng: -81.6557, lat: 30.3322, name: "downtown Jacksonville" };
const RIVERSIDE = { lng: -81.6926, lat: 30.3072, name: "Riverside" };
const SOUTHSIDE = { lng: -81.5601, lat: 30.2588, name: "Southside" };
const ARLINGTON = { lng: -81.585, lat: 30.348, name: "Arlington" };
const MANDARIN = { lng: -81.6407, lat: 30.1666, name: "Mandarin" };
const NORTHSIDE = { lng: -81.6265, lat: 30.4419, name: "the Northside" };
const JAX_BEACH = { lng: -81.3931, lat: 30.2947, name: "Jacksonville Beach" };

const BALDWIN = { lng: -81.9757, lat: 30.3027, name: "Baldwin" };

/**
 * What MapLibre actually shows.
 *
 * `fitBounds` fits the requested rectangle inside the container and the spare
 * space on the long axis becomes extra map, so the viewport a user sees - and
 * the one "Search this view" reads back - is always at least the requested
 * rectangle and usually wider. This models that worst case: the requested
 * rectangle grown to the container's aspect ratio.
 */
function fitted(bounds: MapBounds, aspect: number): MapBounds {
  const width = bounds.east - bounds.west;
  const height = bounds.north - bounds.south;
  const lngCentre = (bounds.east + bounds.west) / 2;
  const latCentre = (bounds.north + bounds.south) / 2;

  const shown =
    width / height < aspect ? { w: height * aspect, h: height } : { w: width, h: width / aspect };

  return {
    west: lngCentre - shown.w / 2,
    east: lngCentre + shown.w / 2,
    south: latCentre - shown.h / 2,
    north: latCentre + shown.h / 2,
  };
}

describe("the rectangle the map opens on", () => {
  it("is a real rectangle, the right way up", () => {
    expect(JACKSONVILLE_BOUNDS.west).toBeLessThan(JACKSONVILLE_BOUNDS.east);
    expect(JACKSONVILLE_BOUNDS.south).toBeLessThan(JACKSONVILLE_BOUNDS.north);
  });

  it("holds the parts of Jacksonville an acquisitions team actually works", () => {
    for (const place of [
      DOWNTOWN,
      RIVERSIDE,
      SOUTHSIDE,
      ARLINGTON,
      MANDARIN,
      NORTHSIDE,
      JAX_BEACH,
    ]) {
      expect(
        boundsContain(JACKSONVILLE_BOUNDS, place.lng, place.lat),
        `${place.name} should be on screen when the map opens`,
      ).toBe(true);
    }
  });

  it("does not lead with Baldwin", () => {
    expect(
      boundsContain(JACKSONVILLE_BOUNDS, BALDWIN.lng, BALDWIN.lat),
      "Baldwin is 30 km west of downtown and must not frame the opening view",
    ).toBe(false);
  });

  it("still does not lead with Baldwin on a wide monitor", () => {
    // The failure mode this guards, and the one the first draft of these bounds
    // actually had: a rectangle that excludes Baldwin on a normal container and
    // quietly puts it back on an ultrawide, where fitBounds spends the spare
    // width on more map. This layout's map column runs about 1.2:1 to 1.6:1;
    // 2.4:1 is well past anything it produces.
    for (const aspect of [1.0, 1.4, 1.8, 2.4]) {
      const shown = fitted(JACKSONVILLE_BOUNDS, aspect);
      expect(boundsContain(shown, DOWNTOWN.lng, DOWNTOWN.lat), `downtown at aspect ${aspect}`).toBe(
        true,
      );
      expect(boundsContain(shown, BALDWIN.lng, BALDWIN.lat), `Baldwin at aspect ${aspect}`).toBe(
        false,
      );
    }
  });

  it("is what the deployed configuration uses unless an environment overrides it", () => {
    expect(publicDataConfig.initialBounds).toEqual(JACKSONVILLE_BOUNDS);
  });
});

describe('"Search this view" from the opening viewport', () => {
  it("reads back a viewport that covers Jacksonville and excludes Baldwin", () => {
    // The button reads map.getBounds() when pressed. Opening bounds are applied
    // through the map constructor rather than an animated fitBounds precisely so
    // that this is truthful from the first frame rather than mid flight.
    const shown = fitted(JACKSONVILLE_BOUNDS, 1.4);
    const viewport = {
      type: "bbox" as const,
      west: shown.west,
      south: shown.south,
      east: shown.east,
      north: shown.north,
    };

    expect(viewport.west).toBeLessThan(viewport.east);
    expect(viewport.south).toBeLessThan(viewport.north);
    expect(boundsContain(shown, DOWNTOWN.lng, DOWNTOWN.lat)).toBe(true);
    expect(boundsContain(shown, BALDWIN.lng, BALDWIN.lat)).toBe(false);
  });
});

describe("NEXT_PUBLIC_MAP_BOUNDS", () => {
  it("takes west,south,east,north in degrees", () => {
    expect(parseMapBounds("-82.05,30.1,-81.32,30.58", JACKSONVILLE_BOUNDS)).toEqual({
      west: -82.05,
      south: 30.1,
      east: -81.32,
      north: 30.58,
    });
    expect(parseMapBounds(" -81.76 , 30.15 , -81.36 , 30.47 ", JACKSONVILLE_BOUNDS)).toEqual(
      JACKSONVILLE_BOUNDS,
    );
  });

  it("keeps the Jacksonville default rather than handing the map a typo", () => {
    for (const bad of [
      undefined,
      "",
      "-81.8,30.15,-81.38",
      "-81.8,30.15,-81.38,30.48,extra",
      "west,south,east,north",
      // Inside out: east of west, or north of south.
      "-81.38,30.15,-81.8,30.48",
      "-81.8,30.48,-81.38,30.15",
      // No area at all.
      "-81.8,30.15,-81.8,30.48",
    ]) {
      expect(parseMapBounds(bad, JACKSONVILLE_BOUNDS), `input: ${String(bad)}`).toEqual(
        JACKSONVILLE_BOUNDS,
      );
    }
  });
});
