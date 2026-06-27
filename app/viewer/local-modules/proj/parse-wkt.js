import wktParser from "wkt-parser";
/**
 * Parse a WKT string or PROJJSON object into a proj4-compatible projection
 * definition.
 *
 * This is a typed wrapper around the `wkt-parser` package.
 */
export function parseWkt(input) {
    const def = wktParser(input);
    // wkt-parser doesn't always resolve per-axis units from GeographicCRS
    // PROJJSON, leaving units: "unknown". longlat is always degrees by definition.
    if (def.projName === "longlat" && (!def.units || def.units === "unknown")) {
        def.units = "degree";
        def.to_meter = undefined;
    }
    return def;
}
//# sourceMappingURL=parse-wkt.js.map