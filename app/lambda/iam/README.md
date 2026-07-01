# IAM for deckgl-s3-cog-s1m — demo deploy role

This demo uses one scoped deploy role for the human/CLI path. That role can
create and update the demo's CloudFormation stacks, SAM-created Lambda execution
roles, ECR image repository, SAM artifact bucket, and viewer/output bucket.
The running Lambdas still use SAM-managed runtime roles, so the app itself does
not run with deploy permissions.

| Layer | Who | What it owns | Frequency |
|---|---|---|---|
| **Deploy** | you, via an **SSO-assumed role** (`deckgl-s3-cog-s1m-deploy`) — no static keys | foundation bucket, app code/config, ECR push, SAM-created exec roles, viewer sync | as needed |
| **Runtime** | the Lambdas themselves | two **SAM-managed execution roles**, generated from `template.yaml` and `ingest-template.yaml` | per request |

The deploy role is intentionally bounded to `deckgl-s3-cog-s1m-*` app resources
and the shared read-only source buckets the demo needs.

## Policy / file layout

| File | Type | Attached to | Purpose |
|---|---|---|---|
| `deckgl-s3-cog-s1m-deploy.json` | customer-managed policy | `deckgl-s3-cog-s1m-deploy` role | deploy plane (CFN/Lambda/ECR/SAM-bucket/`iam:PassRole`+`CreateRole`). |
| `deckgl-s3-cog-s1m-data.json` | inline policy | `deckgl-s3-cog-s1m-deploy` role | S3 data plane for local CLI / docker-compose ingest (read `naip-analytic` + `naip-stac-catalog`, RW the lake). |
| `deckgl-s3-cog-s1m-deploy-trust.json` | trust policy | `deckgl-s3-cog-s1m-deploy` role | who may `sts:AssumeRole` the deploy role (your human SSO principal). |

No AWS-managed policies — they're account-wide and defeat the "narrow" goal.
Every app-owned statement is scoped to this demo's `deckgl-s3-cog-s1m-*`
resources and region-locked to us-west-2.

Both JSON policy files are templated with `__ACCOUNT_ID__`; the trust file also
uses `__DEPLOY_PRINCIPAL_ARN__`. Render with `sed` before applying.

---

## Foundation stack (one-time, before app deploy)

`foundation.yaml` creates the retained viewer/output S3 bucket, copies demo seed
data from `deckgl-s3-cog-s1m-seed-us-west2`, and exports its ids
(`ViewerBucketName`, `ViewerUrl`). _(The CloudFront CORS/cache tile proxy was
removed — the viewer reads public source COGs directly via their own CORS — so
there is no longer a `TileBase`/`DistributionId` output.)_

```bash
cd app/lambda

# Green-field account (no viewer bucket yet):
./deploy-foundation.sh                 # wraps `aws cloudformation deploy`
```

### If the viewer bucket already exists (older bootstrap)

The foundation stack CREATES the bucket. If `deckgl-s3-cog-s1m-<acct>-us-west2`
already exists out-of-band, `deploy-foundation.sh` refuses to create duplicates
and makes no changes. Import or migrate that bucket deliberately before putting
it under the foundation stack. Do not delete the bucket as part of a routine
deployment.

(Green-field accounts with no bucket skip the cleanup and just run
`./deploy-foundation.sh`.)

Once the foundation stack exists, running `./deploy-foundation.sh` again is a
read-only no-op that prints its outputs. An intentional template update requires
the explicit `./deploy-foundation.sh --update` command.

### Legacy resources without a foundation stack

During migration, `deploy-ingest.sh` and `deploy-read.sh` also accept an existing
`deckgl-s3-cog-s1m-<account>-us-west2` bucket when the foundation stack is absent.
No tile-proxy URL is needed — the viewer reads public source COGs directly.

Foundation-created buckets receive an `Application=deckgl-s3-cog-s1m` tag
automatically.

The seed copy is implemented as a CloudFormation custom resource. On create or
update it copies `lake/`, `collections.geojson`, and `anchors.geojson` from
`deckgl-s3-cog-s1m-seed-us-west2` into the deployer's bucket. On delete it leaves
the copied objects in place because the bucket is retained. Cross-account
deployments require the seed bucket policy to allow the target account's
seed-copy role to `ListBucket` and `GetObject`.

---

## Deploy role (create once; then assume it)

```bash
cd app/lambda/iam
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# 1. WHO may assume the role. Run `aws sts get-caller-identity` while logged in
#    as the human identity that should deploy (your SSO login),
#    and use its role ARN form. For SSO that is the permission-set role, e.g.
#    arn:aws:iam::<acct>:role/aws-reserved/sso.amazonaws.com/<region>/AWSReservedSSO_<name>_<id>
#    (the account-root ARN arn:aws:iam::<acct>:root also works but is broader).
DEPLOY_PRINCIPAL_ARN="arn:aws:iam::${ACCOUNT_ID}:root"   # tighten to the SSO role

sed "s|__DEPLOY_PRINCIPAL_ARN__|${DEPLOY_PRINCIPAL_ARN}|g" \
  deckgl-s3-cog-s1m-deploy-trust.json > /tmp/deckgl-s3-cog-s1m-deploy-trust.json

# 2. Create the role with that trust policy.
aws iam create-role --role-name deckgl-s3-cog-s1m-deploy \
  --assume-role-policy-document file:///tmp/deckgl-s3-cog-s1m-deploy-trust.json

# 3. Deploy-plane policy (customer-managed) -> attach.
sed "s/__ACCOUNT_ID__/$ACCOUNT_ID/g" deckgl-s3-cog-s1m-deploy.json > /tmp/deckgl-s3-cog-s1m-deploy.json
aws iam create-policy --policy-name deckgl-s3-cog-s1m-deploy \
  --policy-document file:///tmp/deckgl-s3-cog-s1m-deploy.json
aws iam attach-role-policy --role-name deckgl-s3-cog-s1m-deploy \
  --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/deckgl-s3-cog-s1m-deploy"

# 4. Data-plane policy (inline) for local CLI / docker-compose ingest.
sed "s/__ACCOUNT_ID__/$ACCOUNT_ID/g" deckgl-s3-cog-s1m-data.json > /tmp/deckgl-s3-cog-s1m-data.json
aws iam put-role-policy --role-name deckgl-s3-cog-s1m-deploy \
  --policy-name deckgl-s3-cog-s1m-data --policy-document file:///tmp/deckgl-s3-cog-s1m-data.json
```

### Assume it from the CLI

Add a profile to `~/.aws/config` that assumes the role from your SSO login, then
point the repo at it (`app/.env` already sets `AWS_PROFILE=deckgl-s3-cog-s1m-deploy`):

```ini
[profile deckgl-s3-cog-s1m-deploy]
role_arn       = arn:aws:iam::495811053987:role/deckgl-s3-cog-s1m-deploy
source_profile = deploy-admin        ; or: sso_session = <your-sso-session>
region         = us-west-2
```

Verify: `aws sts get-caller-identity --profile deckgl-s3-cog-s1m-deploy` →
`assumed-role/deckgl-s3-cog-s1m-deploy/...`. Then run `./deploy.sh`.

> Also delete the stray empty `[profile ]` block in `~/.aws/config` (left over
> from a blank `AWS_PROFILE=`); it caused "config profile () could not be found".

---

## Runtime roles (no manual step)

The Lambda execution roles are auto-generated by SAM from the `Policies:` blocks
in `template.yaml` (read-only lake access) and `ingest-template.yaml` (lake
write access). They carry no human credentials. The deploy role can create only
`role/deckgl-s3-cog-s1m-read-*` and `role/deckgl-s3-cog-s1m-ingest-*` roles.

> **Public collections (KyFromAbove, New Jersey)** are read with an *unsigned/
> anonymous* S3 client, which bypasses the role's identity policy — so neither
> role needs (or should get) permissions for `kyfromabove`/`njogis-imagery`.

---

## Notes / tradeoffs

- **Region lock:** the foundation, read, and ingest templates force deployment
  to us-west-2 because the principal COG source buckets (`naip-analytic`,
  `njogis-imagery`, and `kyfromabove`) are hosted there. Keeping compute,
  GeoParquet output, and source reads in-region reduces latency and avoids
  cross-region S3 transfer charges. `deploy-foundation.sh` rejects any other
  `REGION` before making AWS calls.
- **No static keys:** the deploy identity is the SSO-assumed
  `deckgl-s3-cog-s1m-deploy` role with short-lived credentials.
- **No CloudFront:** the former CORS/cache tile proxy was removed. The viewer is
  served from the S3 website endpoint and reads public **source** COG buckets
  directly via their own CORS, so there is no distribution to create, no cache to
  invalidate, and the deploy role needs no `cloudfront:*` permissions.
- **`iam:PassRole`** is constrained to `lambda.amazonaws.com` and `deckgl-s3-cog-s1m-*`
  roles only — the guardrail against privilege escalation.
- **Independent application stacks:** `./deploy-ingest.sh` builds the container;
  `./deploy-read.sh` reads its `IngestUrl` output and passes it to the read stack.
  The read API continues to expose the URL through `/environment`; no SSM
  parameter or CloudFormation cross-stack export is required.
- **Migration:** the independent stack uses the physical function name
  `deckgl-s3-cog-s1m-ingest-worker`, allowing it to deploy before the legacy combined
  stack removes `deckgl-s3-cog-s1m-ingest`. This avoids a physical-name collision.
- **Build needs Docker:** both SAM builds use the configured arm64 container
  build. The scripts automatically use Colima's socket when available.
- **ECR companion stack:** `resolve_image_repos = true` makes SAM create a
  `deckgl-s3-cog-s1m-ingest-*-CompanionStack` holding the ingest ECR repo. The deploy
  policy therefore covers `stack/deckgl-s3-cog-s1m-ingest-*/*`; ECR authorization is
  scoped to repositories named `deckgl-s3-cog-s1m-*`.
