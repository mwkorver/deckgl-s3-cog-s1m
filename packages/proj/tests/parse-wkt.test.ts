import proj4 from "proj4";
import { describe, expect, it } from "vitest";
import type { ProjJson } from "../../proj/src/index.js";
import { parseWkt } from "../../proj/src/index.js";

describe("parseWkt", () => {
  it("produces degree units for EPSG:4326 PROJJSON (from epsg.io)", () => {
    // Simplified response body from https://epsg.io/4326.json. Units are
    // declared per-axis on coordinate_system.axis[].unit, not at the top level.
    // When wkt-parser fails to resolve that, parseWkt normalizes longlat to
    // degree.
    const projjson: ProjJson = {
      $schema: "https://proj.org/schemas/v0.7/projjson.schema.json",
      type: "GeographicCRS",
      name: "WGS 84",
      datum_ensemble: {
        name: "World Geodetic System 1984 ensemble",
        members: [],
        ellipsoid: {
          name: "WGS 84",
          semi_major_axis: 6378137,
          inverse_flattening: 298.257223563,
        },
      },
      coordinate_system: {
        subtype: "ellipsoidal",
        axis: [
          {
            name: "Geodetic latitude",
            abbreviation: "Lat",
            direction: "north",
            unit: "degree",
          },
          {
            name: "Geodetic longitude",
            abbreviation: "Lon",
            direction: "east",
            unit: "degree",
          },
        ],
      },
    };

    const def = parseWkt(projjson);

    expect(def.projName).toBe("longlat");
    expect(def.units).toBe("degree");
    expect(def.a).toBe(6378137);
  });

  it("normalizes longlat with units 'unknown' to degree", () => {
    // GEOGCS WKT without a UNIT directive can cause wkt-parser to emit
    // units: "unknown" or undefined. This verifies the fallback.
    const wkt =
      'GEOGCS["WGS 84",' +
      'DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],' +
      'PRIMEM["Greenwich",0],' +
      'AXIS["Latitude",NORTH],AXIS["Longitude",EAST]]';

    const def = parseWkt(wkt);

    expect(def.projName).toBe("longlat");
    expect(def.units).toBe("degree");
  });

  it("parses EPSG:6527 ProjectedCRS correctly", () => {
    const projjson: any = {
      $schema: "https://proj.org/schemas/v0.7/projjson.schema.json",
      type: "ProjectedCRS",
      name: "NAD83(2011) / New Jersey (ftUS)",
      base_crs: {
        type: "GeographicCRS",
        name: "NAD83(2011)",
        datum: {
          type: "GeodeticReferenceFrame",
          name: "NAD83 (National Spatial Reference System 2011)",
          anchor_epoch: 2010,
          ellipsoid: {
            name: "GRS 1980",
            semi_major_axis: 6378137,
            inverse_flattening: 298.257222101,
          },
        },
        coordinate_system: {
          subtype: "ellipsoidal",
          axis: [
            {
              name: "Geodetic latitude",
              abbreviation: "Lat",
              direction: "north",
              unit: "degree",
            },
            {
              name: "Geodetic longitude",
              abbreviation: "Lon",
              direction: "east",
              unit: "degree",
            },
          ],
        },
        id: {
          authority: "EPSG",
          code: 6318,
        },
      },
      conversion: {
        name: "SPCS83 New Jersey zone (US survey foot)",
        method: {
          name: "Transverse Mercator",
          id: {
            authority: "EPSG",
            code: 9807,
          },
        },
        parameters: [
          {
            name: "Latitude of natural origin",
            value: 38.8333333333333,
            unit: "degree",
            id: {
              authority: "EPSG",
              code: 8801,
            },
          },
          {
            name: "Longitude of natural origin",
            value: -74.5,
            unit: "degree",
            id: {
              authority: "EPSG",
              code: 8802,
            },
          },
          {
            name: "Scale factor at natural origin",
            value: 0.9999,
            unit: "unity",
            id: {
              authority: "EPSG",
              code: 8805,
            },
          },
          {
            name: "False easting",
            value: 492125,
            unit: {
              type: "LinearUnit",
              name: "US survey foot",
              conversion_factor: 0.304800609601219,
            },
            id: {
              authority: "EPSG",
              code: 8806,
            },
          },
          {
            name: "False northing",
            value: 0,
            unit: {
              type: "LinearUnit",
              name: "US survey foot",
              conversion_factor: 0.304800609601219,
            },
            id: {
              authority: "EPSG",
              code: 8807,
            },
          },
        ],
      },
      coordinate_system: {
        subtype: "Cartesian",
        axis: [
          {
            name: "Easting",
            abbreviation: "X",
            direction: "east",
            unit: {
              type: "LinearUnit",
              name: "US survey foot",
              conversion_factor: 0.304800609601219,
            },
          },
          {
            name: "Northing",
            abbreviation: "Y",
            direction: "north",
            unit: {
              type: "LinearUnit",
              name: "US survey foot",
              conversion_factor: 0.304800609601219,
            },
          },
        ],
      },
      scope: "Engineering survey, topographic mapping.",
      area: "United States (USA) - New Jersey - counties of Atlantic; Bergen; Burlington; Camden; Cape May; Cumberland; Essex; Gloucester; Hudson; Hunterdon; Mercer; Middlesex; Monmouth; Morris; Ocean; Passaic; Salem; Somerset; Sussex; Union; Warren.",
      bbox: {
        south_latitude: 38.87,
        west_longitude: -75.6,
        north_latitude: 41.36,
        east_longitude: -73.88,
      },
      id: {
        authority: "EPSG",
        code: 6527,
      },
    };

    const def = parseWkt(projjson);

    let error: any = null;
    let projCoords: any = null;
    try {
      const transform = proj4(def as any, "EPSG:4326");
      projCoords = transform.inverse([-74.5, 40.0]);
    } catch (e: any) {
      error = e;
    }
    expect(error).toBeNull();
    expect(projCoords).not.toBeNull();
    expect(projCoords[0]).not.toBeCloseTo(-74.5, 2);
    expect(projCoords[1]).not.toBeCloseTo(40.0, 2);
    expect(Number.isFinite(projCoords[0])).toBe(true);
    expect(Number.isFinite(projCoords[1])).toBe(true);
  });
});
