import { parseWkt } from "./parse-wkt.js";
/**
 * A global registry holding parsed projection definitions.
 */
export const PROJECTION_REGISTRY = new Map();
export async function epsgResolver(epsg) {
    const key = `EPSG:${epsg}`;
    const cachedProj = PROJECTION_REGISTRY.get(key);
    if (cachedProj !== undefined) {
        return cachedProj;
    }
    const projjson = await getProjjson(epsg);
    const proj = parseWkt(projjson);
    PROJECTION_REGISTRY.set(key, proj);
    return proj;
}
/** Query epsg.io for the PROJJSON corresponding to the given EPSG code. */
async function getProjjson(epsg) {
    const url = `https://epsg.io/${epsg}.json`;
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`Failed to fetch PROJJSON from ${url}`);
    }
    return await resp.json();
}
//# sourceMappingURL=registry.js.map