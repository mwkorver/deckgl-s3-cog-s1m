/**
 * Coefficient to convert the coordinate reference system (CRS)
 * units into meters (metersPerUnit).
 *
 * From note g in http://docs.opengeospatial.org/is/17-083r2/17-083r2.html#table_2:
 *
 * > If the CRS uses meters as units of measure for the horizontal dimensions,
 * > then metersPerUnit=1; if it has degrees, then metersPerUnit=2pa/360
 * > (a is the Earth maximum radius of the ellipsoid).
 *
 * @param unit - The unit of the CRS.
 * @param semiMajorAxis - The semi-major axis of the ellipsoid, required if unit is 'degree'.
 * @returns The meters per unit conversion factor.
 */
export declare function metersPerUnit(unit: "m" | "metre" | "meter" | "meters" | "foot" | "us survey foot" | "degree", { semiMajorAxis }?: {
    semiMajorAxis?: number;
}): number;
//# sourceMappingURL=meters-per-unit.d.ts.map