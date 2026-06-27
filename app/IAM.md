# IAM strategy

This is a demo application, so the AWS deployment path intentionally stays
simple: one scoped human/CLI deploy role, plus SAM-managed Lambda runtime roles.

## Resource prefix

All app-owned AWS resources use the `deckgl-s3-cog-s1m-*` prefix:

- `deckgl-s3-cog-s1m-foundation`
- `deckgl-s3-cog-s1m-read`
- `deckgl-s3-cog-s1m-ingest`
- `deckgl-s3-cog-s1m-<account>-us-west2`
- `deckgl-s3-cog-s1m-read-*` / `deckgl-s3-cog-s1m-ingest-*` SAM runtime roles
- `deckgl-s3-cog-s1m-*` ECR repositories

The shared `cog-stac-catalog` bucket is not app-owned and keeps its existing
name.

## One deploy role

Create one SSO-assumed role named `deckgl-s3-cog-s1m-deploy` using the policy
files in `lambda/iam/`.

That role can:

- deploy the foundation, read, and ingest CloudFormation stacks;
- let the foundation stack copy seed data from `deckgl-s3-cog-s1m-seed-us-west2`;
- let SAM create/update the Lambda execution roles for this demo;
- push the ingest image to prefix-scoped ECR repositories;
- manage the viewer/output bucket for this demo;
- publish the browser viewer files;
- read the shared catalog and requester-pays NAIP source bucket.

The role is intentionally scoped to `us-west-2` and to `deckgl-s3-cog-s1m-*`
resources wherever AWS supports resource-level constraints.

## Runtime roles

The Lambdas do not run as the deploy role. SAM creates runtime roles from the
`Policies:` blocks in:

- `lambda/template.yaml` for the read API;
- `lambda/ingest-template.yaml` for the ingest API.

Runtime permissions stay narrow:

- read Lambda: read lake output, shared manifest index, and NAIP source data;
- ingest Lambda: read/write lake output, read shared manifest index, and read
  NAIP source data.

Public COG collections such as New Jersey and KyFromAbove are accessed with
unsigned S3 clients, so they do not need identity-policy grants.

## Seed data

The foundation stack copies `lake/`, `collections.geojson`, and `anchors.geojson` from
`deckgl-s3-cog-s1m-seed-us-west2` into the deployer's bucket
`deckgl-s3-cog-s1m-<account>-us-west2`.

For deployments outside the seed bucket's owning account, the seed bucket policy
must allow the target account's foundation seed-copy role to list and read those
objects. The runtime Lambda roles do not need access to the seed bucket after
the copy finishes.

## Tradeoff

This is not the tightest possible production IAM model. It is the right shape
for a demo: one role to hand to a deployer, predictable prefixed resources, and
runtime roles that remain narrower than deploy permissions.
