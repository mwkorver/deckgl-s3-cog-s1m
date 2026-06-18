# COG display value ranges

The viewer passes an optional per-collection `display.domain` from
`registry.yaml` through `collections.geojson` to `COGLayer`. The domain is in raw
sample units. A domain equal to the sample type's full range is an identity
mapping.

## New Jersey imagery

The New Jersey COGs are unsigned 16-bit RGBA images and must use:

```yaml
display:
  sample_bits: 16
  domain: [0, 65535]
```

This is not an 8-bit dataset stored in a 16-bit container. A representative 2020
COG (`A15B12.tif`) was decoded and its RGB overview values spanned much of the
full 16-bit range (roughly 181 through 61611). Setting the domain to `[0,255]`
clips nearly all pixels at the upper bound and produces a white image. Treating
the texture as 8-bit or otherwise applying the wrong normalization can produce
black imagery.

The deployed viewer was visually verified with `[0,65535]` on June 7, 2026.

## Render path

```text
registry.yaml display.domain
  -> collections.geojson
  -> viewer collectionForHref(href)
  -> COGLayer domain
  -> fragment shader remap
```

The shader mapping is:

```text
display = clamp((sampled * typeMax - domainMin)
                / (domainMax - domainMin), 0, 1)
```

For NJ, `typeMax` and `domainMax` are both `65535`, so this is an identity
mapping. Standard 8-bit imagery uses `[0,255]`.

Do not infer a collection domain from `BitsPerSample` alone. Verify the decoded
sample values from a representative COG before changing `display.domain`.
