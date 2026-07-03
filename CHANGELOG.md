# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- GitHub Actions CI (`.github/workflows/ci.yml`): build, typecheck, tests, and
  Biome lint/format for the TypeScript packages; `ruff` and `pytest` for the
  Python API.
- `SECURITY.md`, `CODE_OF_CONDUCT.md`, and this changelog.
- README hero screenshot of the 3D terrain-drape viewer.

### Changed

- Terrain imagery drape: byte-budgeted decoded-COG-tile cache (96 MB) and a
  leaner per-pixel raster loop; COG-read concurrency settled at 16.

### Fixed

- NAIP terrain drape returned no imagery because the `CONUS` region sentinel was
  sent as a lake partition filter; the drape now scopes by bbox like the main
  search.

### Removed

- Dead code across the viewer, `deck.gl-geotiff`, and the Python API; the
  `vt-opendata` (VTORTHO) collection; the orphaned `nj_standalone.html`; and the
  stale committed `app/viewer/local-modules/` build output (now gitignored).

## [0.7.0]

- Baseline at the start of changelog tracking: client-side COG rendering,
  serverless GeoParquet/DuckDB spatial search, per-COG requester-pays URL
  signing, and browser GPU rendering of NAIP imagery over 3DEP S1M terrain.

[Unreleased]: https://github.com/mwkorver/deckgl-s3-cog-s1m/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/mwkorver/deckgl-s3-cog-s1m/releases/tag/v0.7.0
