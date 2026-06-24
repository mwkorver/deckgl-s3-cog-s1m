# IAM for cog-stac — three layers by blast radius

Identities and provisioning are split into three layers so the credential you
use every day is as small as possible:

| Layer | Who | What it owns | Frequency |
|---|---|---|---|
| **Foundation** | admin, one-time | the Retain'd viewer/output **S3 bucket** (`foundation.yaml`, stack `cog-stac-foundation`) | rare |
| **Deploy** | you, via an **SSO-assumed role** (`cog-stac-deploy`) — no static keys | app **code/config**: independent `cog-stac-read` and `cog-stac-ingest` stacks, ECR push, SAM-created exec roles, viewer sync | frequent |
| **Runtime** | the Lambdas themselves | two **SAM-managed execution roles**, generated from `template.yaml` and `ingest-template.yaml` | per request |

You manage **two standing identities** day-to-day (the deploy role + the runtime
roles). The foundation is an admin step run once, not a standing credential.

## Policy / file layout

| File | Type | Attached to | Purpose |
|---|---|---|---|
| `cog-stac-deploy.json` | customer-managed policy | `cog-stac-deploy` role | deploy plane (CFN/Lambda/ECR/SAM-bucket/`iam:PassRole`+`CreateRole`). |
| `cog-stac-data.json` | inline policy | `cog-stac-deploy` role | S3 data plane for local CLI / docker-compose ingest (read `naip-analytic` + `cog-stac-catalog`, RW the lake). |
| `cog-stac-deploy-trust.json` | trust policy | `cog-stac-deploy` role | who may `sts:AssumeRole` the deploy role (your human SSO principal). |

No AWS-managed policies — they're account-wide and defeat the "narrow" goal.
Every statement is scoped to this stack's `cog-stac-*` resources, region-locked
to us-west-2.

Both JSON policy files are templated with `__ACCOUNT_ID__`; the trust file also
uses `__DEPLOY_PRINCIPAL_ARN__`. Render with `sed` before applying.

---

## Foundation stack (admin, one-time, BEFORE any deploy)

`foundation.yaml` creates the Retain'd viewer/output S3 bucket and exports its
ids (`ViewerBucketName`, `ViewerUrl`). _(The CloudFront CORS/cache tile proxy was
removed — the viewer reads public source COGs directly via their own CORS — so
there is no longer a `TileBase`/`DistributionId` output.)_

```bash
cd app/lambda

# Green-field account (no viewer bucket yet):
./deploy-foundation.sh                 # wraps `aws cloudformation deploy`
```

### If the viewer bucket already exists (older bootstrap)

The foundation stack CREATES the bucket. If `cog-stac-viewer-<acct>-<region>`
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
`cog-stac-viewer-<account>-<region>` bucket when the foundation stack is absent.
No tile-proxy URL is needed — the viewer reads public source COGs directly.

Foundation-created buckets receive an `Application=deck.gl-s3-cog` tag
automatically.

---

## Deploy role (admin creates once; you assume it)

```bash
cd app/lambda/iam
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# 1. WHO may assume the role. Run `aws sts get-caller-identity` while logged in
#    as the human identity that should deploy (your SSO/`deploy-admin` login),
#    and use its role ARN form. For SSO that is the permission-set role, e.g.
#    arn:aws:iam::<acct>:role/aws-reserved/sso.amazonaws.com/<region>/AWSReservedSSO_<name>_<id>
#    (the account-root ARN arn:aws:iam::<acct>:root also works but is broader).
DEPLOY_PRINCIPAL_ARN="arn:aws:iam::${ACCOUNT_ID}:root"   # tighten to the SSO role

sed "s|__DEPLOY_PRINCIPAL_ARN__|${DEPLOY_PRINCIPAL_ARN}|g" \
  cog-stac-deploy-trust.json > /tmp/cog-stac-deploy-trust.json

# 2. Create the role with that trust policy.
aws iam create-role --role-name cog-stac-deploy \
  --assume-role-policy-document file:///tmp/cog-stac-deploy-trust.json

# 3. Deploy-plane policy (customer-managed) -> attach.
sed "s/__ACCOUNT_ID__/$ACCOUNT_ID/g" cog-stac-deploy.json > /tmp/cog-stac-deploy.json
aws iam create-policy --policy-name cog-stac-deploy \
  --policy-document file:///tmp/cog-stac-deploy.json
aws iam attach-role-policy --role-name cog-stac-deploy \
  --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/cog-stac-deploy"

# 4. Data-plane policy (inline) for local CLI / docker-compose ingest.
sed "s/__ACCOUNT_ID__/$ACCOUNT_ID/g" cog-stac-data.json > /tmp/cog-stac-data.json
aws iam put-role-policy --role-name cog-stac-deploy \
  --policy-name cog-stac-data --policy-document file:///tmp/cog-stac-data.json
```

### Assume it from the CLI

Add a profile to `~/.aws/config` that assumes the role from your SSO login, then
point the repo at it (`app/.env` already sets `AWS_PROFILE=cog-stac-deploy`):

```ini
[profile cog-stac-deploy]
role_arn       = arn:aws:iam::495811053987:role/cog-stac-deploy
source_profile = deploy-admin        ; or: sso_session = <your-sso-session>
region         = us-west-2
```

Verify: `aws sts get-caller-identity --profile cog-stac-deploy` →
`assumed-role/cog-stac-deploy/...`. Then run `./deploy.sh`.

> Also delete the stray empty `[profile ]` block in `~/.aws/config` (left over
> from a blank `AWS_PROFILE=`); it caused "config profile () could not be found".

---

## Runtime roles (no manual step)

The Lambda execution roles are auto-generated by SAM from the `Policies:` blocks
in `template.yaml` (read-only lake access) and `ingest-template.yaml` (lake
write access). They carry no human credentials. The deploy role can create only
`role/cog-stac-read-*` and `role/cog-stac-ingest-*` roles.

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
  `cog-stac-deploy` role with short-lived credentials.
- **No CloudFront:** the former CORS/cache tile proxy was removed. The viewer is
  served from the S3 website endpoint and reads public **source** COG buckets
  directly via their own CORS, so there is no distribution to create, no cache to
  invalidate, and the deploy role needs no `cloudfront:*` permissions.
- **`iam:PassRole`** is constrained to `lambda.amazonaws.com` and `cog-stac-*`
  roles only — the guardrail against privilege escalation.
- **Independent application stacks:** `./deploy-ingest.sh` builds the container;
  `./deploy-read.sh` reads its `IngestUrl` output and passes it to the read stack.
  The read API continues to expose the URL through `/environment`; no SSM
  parameter or CloudFormation cross-stack export is required.
- **Migration:** the independent stack uses the physical function name
  `cog-stac-ingest-worker`, allowing it to deploy before the legacy combined
  stack removes `cog-stac-ingest`. This avoids a physical-name collision.
- **Build needs Docker:** both SAM builds use the configured arm64 container
  build. The scripts automatically use Colima's socket when available.
- **ECR companion stack:** `resolve_image_repos = true` makes SAM create a
  `cog-stac-ingest-*-CompanionStack` holding the ingest ECR repo. The deploy
  policy therefore covers `stack/cog-stac-ingest-*/*`; ECR authorization remains
  account-level.
