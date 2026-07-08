# @s3-cog/proj

> Derived from [Development Seed's deck.gl-raster](https://github.com/developmentseed/deck.gl-raster) monorepo (MIT), vendored into this repo — see [LICENSE](./LICENSE). Not this project's original work.

Utilities for coordinate reprojections.

This module is designed to work seamlessly alongside [proj4.js](https://github.com/proj4js/proj4js)—the robust and industry-standard library for coordinate projections in JavaScript. To maintain maximum flexibility, it does not enforce a hard dependency on proj4, allowing users the freedom to integrate other projection engines (such as WebAssembly-based implementations like [`proj-wasm`](https://github.com/willcohen/clj-proj)) if needed.
