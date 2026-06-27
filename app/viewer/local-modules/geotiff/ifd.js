import { PlanarConfiguration, Predictor, SampleFormat, TiffTag, TiffTagGeo, } from "@cogeotiff/core";
/** Pre-fetch TIFF tags for easier visualization. */
export async function prefetchTags(image, options = {}) {
    const { signal } = options;
    // Compression is pre-fetched in init
    const compression = image.value(TiffTag.Compression);
    if (compression === null) {
        throw new Error("Compression tag should always exist.");
    }
    const [bitsPerSample, colorMap, gdalNoData, gdalMetadata, lercParameters, modelPixelScale, modelTiepoint, modelTransformation, photometric, planarConfiguration, predictor, sampleFormat, samplesPerPixel,] = await Promise.all([
        image.fetch(TiffTag.BitsPerSample, { signal }),
        image.fetch(TiffTag.ColorMap, { signal }),
        image.fetch(TiffTag.GdalNoData, { signal }),
        image.fetch(TiffTag.GdalMetadata, { signal }),
        image.fetch(TiffTag.LercParameters, { signal }),
        image.fetch(TiffTag.ModelPixelScale, { signal }),
        image.fetch(TiffTag.ModelTiePoint, { signal }),
        image.fetch(TiffTag.ModelTransformation, { signal }),
        image.fetch(TiffTag.Photometric, { signal }),
        image.fetch(TiffTag.PlanarConfiguration, { signal }),
        image.fetch(TiffTag.Predictor, { signal }),
        image.fetch(TiffTag.SampleFormat, { signal }),
        image.fetch(TiffTag.SamplesPerPixel, { signal }),
    ]);
    const missingTag = (tagName) => {
        throw new Error(`${tagName} tag should always exist.`);
    };
    if (bitsPerSample === null) {
        missingTag("BitsPerSample");
    }
    if (samplesPerPixel === null) {
        missingTag("SamplesPerPixel");
    }
    if (photometric === null) {
        missingTag("Photometric");
    }
    return {
        bitsPerSample: new Uint16Array(bitsPerSample),
        colorMap: colorMap ? new Uint16Array(colorMap) : undefined,
        compression,
        gdalMetadata,
        lercParameters,
        modelTiepoint,
        modelPixelScale,
        modelTransformation,
        nodata: gdalNoData !== null ? Number(gdalNoData) : null,
        photometric,
        // PlanarConfiguration defaults to interleaved/chunky/contig
        // https://web.archive.org/web/20240329145253/https://www.awaresystems.be/imaging/tiff/tifftags/planarconfiguration.html
        planarConfiguration: planarConfiguration ?? PlanarConfiguration.Contig,
        predictor: predictor ?? Predictor.None,
        // Uint is the default sample format according to the spec
        // https://web.archive.org/web/20240329145340/https://www.awaresystems.be/imaging/tiff/tifftags/sampleformat.html
        sampleFormat: sampleFormat ?? [SampleFormat.Uint],
        samplesPerPixel,
    };
}
export function extractGeoKeyDirectory(image) {
    const geo = (key) => image.valueGeo(key) ?? null;
    return {
        // Configuration keys
        modelType: geo(TiffTagGeo.GTModelTypeGeoKey),
        rasterType: geo(TiffTagGeo.GTRasterTypeGeoKey),
        citation: geo(TiffTagGeo.GTCitationGeoKey),
        // Geographic CRS keys
        geodeticCRS: geo(TiffTagGeo.GeodeticCRSGeoKey),
        geodeticCitation: geo(TiffTagGeo.GeodeticCitationGeoKey),
        geodeticDatum: geo(TiffTagGeo.GeodeticDatumGeoKey),
        primeMeridian: geo(TiffTagGeo.PrimeMeridianGeoKey),
        linearUnits: geo(TiffTagGeo.GeogLinearUnitsGeoKey),
        linearUnitSize: geo(TiffTagGeo.GeogLinearUnitSizeGeoKey),
        angularUnits: geo(TiffTagGeo.GeogAngularUnitsGeoKey),
        angularUnitSize: geo(TiffTagGeo.GeogAngularUnitSizeGeoKey),
        ellipsoid: geo(TiffTagGeo.EllipsoidGeoKey),
        ellipsoidSemiMajorAxis: geo(TiffTagGeo.EllipsoidSemiMajorAxisGeoKey),
        ellipsoidSemiMinorAxis: geo(TiffTagGeo.EllipsoidSemiMinorAxisGeoKey),
        ellipsoidInvFlattening: geo(TiffTagGeo.EllipsoidInvFlatteningGeoKey),
        azimuthUnits: geo(TiffTagGeo.GeogAzimuthUnitsGeoKey),
        primeMeridianLongitude: geo(TiffTagGeo.PrimeMeridianLongitudeGeoKey),
        toWGS84: geo(TiffTagGeo.GeogTOWGS84GeoKey),
        // Projected CRS keys
        projectedCRS: geo(TiffTagGeo.ProjectedCRSGeoKey),
        projectedCitation: geo(TiffTagGeo.ProjectedCitationGeoKey),
        projection: geo(TiffTagGeo.ProjectionGeoKey),
        projMethod: geo(TiffTagGeo.ProjMethodGeoKey),
        projLinearUnits: geo(TiffTagGeo.ProjLinearUnitsGeoKey),
        projLinearUnitSize: geo(TiffTagGeo.ProjLinearUnitSizeGeoKey),
        projStdParallel1: geo(TiffTagGeo.ProjStdParallel1GeoKey),
        projStdParallel2: geo(TiffTagGeo.ProjStdParallel2GeoKey),
        projNatOriginLong: geo(TiffTagGeo.ProjNatOriginLongGeoKey),
        projNatOriginLat: geo(TiffTagGeo.ProjNatOriginLatGeoKey),
        projFalseEasting: geo(TiffTagGeo.ProjFalseEastingGeoKey),
        projFalseNorthing: geo(TiffTagGeo.ProjFalseNorthingGeoKey),
        projFalseOriginLong: geo(TiffTagGeo.ProjFalseOriginLongGeoKey),
        projFalseOriginLat: geo(TiffTagGeo.ProjFalseOriginLatGeoKey),
        projFalseOriginEasting: geo(TiffTagGeo.ProjFalseOriginEastingGeoKey),
        projFalseOriginNorthing: geo(TiffTagGeo.ProjFalseOriginNorthingGeoKey),
        projCenterLong: geo(TiffTagGeo.ProjCenterLongGeoKey),
        projCenterLat: geo(TiffTagGeo.ProjCenterLatGeoKey),
        projCenterEasting: geo(TiffTagGeo.ProjCenterEastingGeoKey),
        projCenterNorthing: geo(TiffTagGeo.ProjCenterNorthingGeoKey),
        projScaleAtNatOrigin: geo(TiffTagGeo.ProjScaleAtNatOriginGeoKey),
        projScaleAtCenter: geo(TiffTagGeo.ProjScaleAtCenterGeoKey),
        projAzimuthAngle: geo(TiffTagGeo.ProjAzimuthAngleGeoKey),
        projStraightVertPoleLong: geo(TiffTagGeo.ProjStraightVertPoleLongGeoKey),
        projRectifiedGridAngle: geo(TiffTagGeo.ProjRectifiedGridAngleGeoKey),
        // Vertical CRS keys
        verticalCRS: geo(TiffTagGeo.VerticalGeoKey),
        verticalCitation: geo(TiffTagGeo.VerticalCitationGeoKey),
        verticalDatum: geo(TiffTagGeo.VerticalDatumGeoKey),
        verticalUnits: geo(TiffTagGeo.VerticalUnitsGeoKey),
    };
}
//# sourceMappingURL=ifd.js.map