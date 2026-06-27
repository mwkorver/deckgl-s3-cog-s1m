/**
 * Mapping from matplotlib / rio-tiler colormap name to its layer index in
 * the shipped `colormaps.png` sprite. Pass values from this object as the
 * `colormapIndex` prop of the {@link Colormap} shader module:
 *
 * ```ts
 * { module: Colormap, props: {
 *     colormapTexture,
 *     colormapIndex: COLORMAP_INDEX.viridis,
 *   } }
 * ```
 *
 * Names are sorted alphabetically. Reversed variants (`_r` suffix) are not
 * listed separately — use the module's `reversed` uniform to flip a
 * colormap at render time instead of binding a distinct layer.
 */
export declare const COLORMAP_INDEX: {
    readonly accent: 0;
    readonly afmhot: 1;
    readonly algae: 2;
    readonly amp: 3;
    readonly autumn: 4;
    readonly balance: 5;
    readonly binary: 6;
    readonly blues: 7;
    readonly bone: 8;
    readonly brbg: 9;
    readonly brg: 10;
    readonly bugn: 11;
    readonly bupu: 12;
    readonly bwr: 13;
    readonly cfastie: 14;
    readonly cividis: 15;
    readonly cmrmap: 16;
    readonly cool: 17;
    readonly coolwarm: 18;
    readonly copper: 19;
    readonly cubehelix: 20;
    readonly curl: 21;
    readonly dark2: 22;
    readonly deep: 23;
    readonly delta: 24;
    readonly dense: 25;
    readonly diff: 26;
    readonly flag: 27;
    readonly gist_earth: 28;
    readonly gist_gray: 29;
    readonly gist_heat: 30;
    readonly gist_ncar: 31;
    readonly gist_rainbow: 32;
    readonly gist_stern: 33;
    readonly gist_yarg: 34;
    readonly gnbu: 35;
    readonly gnuplot: 36;
    readonly gnuplot2: 37;
    readonly gray: 38;
    readonly greens: 39;
    readonly greys: 40;
    readonly haline: 41;
    readonly hot: 42;
    readonly hsv: 43;
    readonly ice: 44;
    readonly inferno: 45;
    readonly jet: 46;
    readonly magma: 47;
    readonly matter: 48;
    readonly nipy_spectral: 49;
    readonly ocean: 50;
    readonly oranges: 51;
    readonly orrd: 52;
    readonly oxy: 53;
    readonly paired: 54;
    readonly pastel1: 55;
    readonly pastel2: 56;
    readonly phase: 57;
    readonly pink: 58;
    readonly piyg: 59;
    readonly plasma: 60;
    readonly prgn: 61;
    readonly prism: 62;
    readonly pubu: 63;
    readonly pubugn: 64;
    readonly puor: 65;
    readonly purd: 66;
    readonly purples: 67;
    readonly rain: 68;
    readonly rainbow: 69;
    readonly rdbu: 70;
    readonly rdgy: 71;
    readonly rdpu: 72;
    readonly rdylbu: 73;
    readonly rdylgn: 74;
    readonly reds: 75;
    readonly rplumbo: 76;
    readonly schwarzwald: 77;
    readonly seismic: 78;
    readonly set1: 79;
    readonly set2: 80;
    readonly set3: 81;
    readonly solar: 82;
    readonly spectral: 83;
    readonly speed: 84;
    readonly spring: 85;
    readonly summer: 86;
    readonly tab10: 87;
    readonly tab20: 88;
    readonly tab20b: 89;
    readonly tab20c: 90;
    readonly tarn: 91;
    readonly tempo: 92;
    readonly terrain: 93;
    readonly thermal: 94;
    readonly topo: 95;
    readonly turbid: 96;
    readonly turbo: 97;
    readonly twilight: 98;
    readonly twilight_shifted: 99;
    readonly viridis: 100;
    readonly winter: 101;
    readonly wistia: 102;
    readonly ylgn: 103;
    readonly ylgnbu: 104;
    readonly ylorbr: 105;
    readonly ylorrd: 106;
};
/** Name of any colormap in the shipped sprite; a key of {@link COLORMAP_INDEX}. */
export type ColormapName = keyof typeof COLORMAP_INDEX;
//# sourceMappingURL=colormap-names.d.ts.map