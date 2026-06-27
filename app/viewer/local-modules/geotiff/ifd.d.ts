import type { TiffImage, TiffTagGeoType, TiffTagType } from "@cogeotiff/core";
import { Predictor, TiffTag, TiffTagGeo } from "@cogeotiff/core";
/** Subset of TIFF tags that we pre-fetch for easier visualization. */
export interface CachedTags {
    bitsPerSample: Uint16Array;
    colorMap?: Uint16Array;
    compression: TiffTagType[TiffTag.Compression];
    gdalMetadata: TiffTagType[TiffTag.GdalMetadata] | null;
    lercParameters: TiffTagType[TiffTag.LercParameters] | null;
    modelTiepoint: TiffTagType[TiffTag.ModelTiePoint] | null;
    modelPixelScale: TiffTagType[TiffTag.ModelPixelScale] | null;
    modelTransformation: TiffTagType[TiffTag.ModelTransformation] | null;
    nodata: number | null;
    photometric: TiffTagType[TiffTag.Photometric];
    /** https://web.archive.org/web/20240329145322/https://www.awaresystems.be/imaging/tiff/tifftags/photometricinterpretation.html */
    planarConfiguration: TiffTagType[TiffTag.PlanarConfiguration];
    predictor: Predictor;
    sampleFormat: TiffTagType[TiffTag.SampleFormat];
    samplesPerPixel: TiffTagType[TiffTag.SamplesPerPixel];
}
/** Pre-fetch TIFF tags for easier visualization. */
export declare function prefetchTags(image: TiffImage, options?: {
    signal?: AbortSignal;
}): Promise<CachedTags>;
/**
 * Parsed GeoKey directory.
 *
 * All fields are optional because any given GeoTIFF may only contain a subset
 * of keys. Types reference `TiffTagGeoType` so `@cogeotiff/core` remains the
 * source of truth.
 *
 * @see https://docs.ogc.org/is/19-008r4/19-008r4.html#_summary_of_geokey_ids_and_names
 */
export type GeoKeyDirectory = {
    modelType: TiffTagGeoType[TiffTagGeo.GTModelTypeGeoKey] | null;
    rasterType: TiffTagGeoType[TiffTagGeo.GTRasterTypeGeoKey] | null;
    citation: TiffTagGeoType[TiffTagGeo.GTCitationGeoKey] | null;
    geodeticCRS: TiffTagGeoType[TiffTagGeo.GeodeticCRSGeoKey] | null;
    geodeticCitation: TiffTagGeoType[TiffTagGeo.GeodeticCitationGeoKey] | null;
    geodeticDatum: TiffTagGeoType[TiffTagGeo.GeodeticDatumGeoKey] | null;
    primeMeridian: TiffTagGeoType[TiffTagGeo.PrimeMeridianGeoKey] | null;
    linearUnits: TiffTagGeoType[TiffTagGeo.GeogLinearUnitsGeoKey] | null;
    linearUnitSize: TiffTagGeoType[TiffTagGeo.GeogLinearUnitSizeGeoKey] | null;
    angularUnits: TiffTagGeoType[TiffTagGeo.GeogAngularUnitsGeoKey] | null;
    angularUnitSize: TiffTagGeoType[TiffTagGeo.GeogAngularUnitSizeGeoKey] | null;
    ellipsoid: TiffTagGeoType[TiffTagGeo.EllipsoidGeoKey] | null;
    ellipsoidSemiMajorAxis: TiffTagGeoType[TiffTagGeo.EllipsoidSemiMajorAxisGeoKey] | null;
    ellipsoidSemiMinorAxis: TiffTagGeoType[TiffTagGeo.EllipsoidSemiMinorAxisGeoKey] | null;
    ellipsoidInvFlattening: TiffTagGeoType[TiffTagGeo.EllipsoidInvFlatteningGeoKey] | null;
    azimuthUnits: TiffTagGeoType[TiffTagGeo.GeogAzimuthUnitsGeoKey] | null;
    primeMeridianLongitude: TiffTagGeoType[TiffTagGeo.PrimeMeridianLongitudeGeoKey] | null;
    toWGS84: TiffTagGeoType[TiffTagGeo.GeogTOWGS84GeoKey] | null;
    projectedCRS: TiffTagGeoType[TiffTagGeo.ProjectedCRSGeoKey] | null;
    projectedCitation: TiffTagGeoType[TiffTagGeo.ProjectedCitationGeoKey] | null;
    projection: TiffTagGeoType[TiffTagGeo.ProjectionGeoKey] | null;
    projMethod: TiffTagGeoType[TiffTagGeo.ProjMethodGeoKey] | null;
    projLinearUnits: TiffTagGeoType[TiffTagGeo.ProjLinearUnitsGeoKey] | null;
    projLinearUnitSize: TiffTagGeoType[TiffTagGeo.ProjLinearUnitSizeGeoKey] | null;
    projStdParallel1: TiffTagGeoType[TiffTagGeo.ProjStdParallel1GeoKey] | null;
    projStdParallel2: TiffTagGeoType[TiffTagGeo.ProjStdParallel2GeoKey] | null;
    projNatOriginLong: TiffTagGeoType[TiffTagGeo.ProjNatOriginLongGeoKey] | null;
    projNatOriginLat: TiffTagGeoType[TiffTagGeo.ProjNatOriginLatGeoKey] | null;
    projFalseEasting: TiffTagGeoType[TiffTagGeo.ProjFalseEastingGeoKey] | null;
    projFalseNorthing: TiffTagGeoType[TiffTagGeo.ProjFalseNorthingGeoKey] | null;
    projFalseOriginLong: TiffTagGeoType[TiffTagGeo.ProjFalseOriginLongGeoKey] | null;
    projFalseOriginLat: TiffTagGeoType[TiffTagGeo.ProjFalseOriginLatGeoKey] | null;
    projFalseOriginEasting: TiffTagGeoType[TiffTagGeo.ProjFalseOriginEastingGeoKey] | null;
    projFalseOriginNorthing: TiffTagGeoType[TiffTagGeo.ProjFalseOriginNorthingGeoKey] | null;
    projCenterLong: TiffTagGeoType[TiffTagGeo.ProjCenterLongGeoKey] | null;
    projCenterLat: TiffTagGeoType[TiffTagGeo.ProjCenterLatGeoKey] | null;
    projCenterEasting: TiffTagGeoType[TiffTagGeo.ProjCenterEastingGeoKey] | null;
    projCenterNorthing: TiffTagGeoType[TiffTagGeo.ProjCenterNorthingGeoKey] | null;
    projScaleAtNatOrigin: TiffTagGeoType[TiffTagGeo.ProjScaleAtNatOriginGeoKey] | null;
    projScaleAtCenter: TiffTagGeoType[TiffTagGeo.ProjScaleAtCenterGeoKey] | null;
    projAzimuthAngle: TiffTagGeoType[TiffTagGeo.ProjAzimuthAngleGeoKey] | null;
    projStraightVertPoleLong: TiffTagGeoType[TiffTagGeo.ProjStraightVertPoleLongGeoKey] | null;
    projRectifiedGridAngle: TiffTagGeoType[TiffTagGeo.ProjRectifiedGridAngleGeoKey] | null;
    verticalCRS: TiffTagGeoType[TiffTagGeo.VerticalGeoKey] | null;
    verticalCitation: TiffTagGeoType[TiffTagGeo.VerticalCitationGeoKey] | null;
    verticalDatum: TiffTagGeoType[TiffTagGeo.VerticalDatumGeoKey] | null;
    verticalUnits: TiffTagGeoType[TiffTagGeo.VerticalUnitsGeoKey] | null;
};
export declare function extractGeoKeyDirectory(image: TiffImage): GeoKeyDirectory;
//# sourceMappingURL=ifd.d.ts.map