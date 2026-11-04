# AWS deployment

The launcher creates a new VPC, EKS 1.35 cluster, one m6i.xlarge worker
(4 vCPU, 16 GiB RAM, 80 GiB disk), six ECR repositories, a private ALB,
and a CloudFront distribution. No domain or certificate setup is required.
Browser HTTPS terminates at CloudFront; internal hops use HTTP.

## Prerequisites

Install Git, Python 3.9+, AWS CLI v2, Terraform >=1.9 and <2, Docker/Compose
>=2.17, Helm 3 or 4, and kubectl 1.34–1.36. Allow 12 GiB Docker memory and
30 GiB free disk. Images are built for linux/amd64; ARM hosts use emulation.

Use a dedicated sandbox account and a CLI profile that assumes an IAM role in
that account. Provisioning requires IAM/PassRole, EC2/VPC, EKS, Auto Scaling,
ECR, ELBv2, and CloudFront permissions. Organization policies can block network
creation even when the role has administrator access.

## Configure

From a dedicated checkout, replace `SANDBOX_PROFILE` and `ACCOUNT_ID`:

```sh
python3 scripts/aws_sandbox.py doctor
aws sso login --profile SANDBOX_PROFILE
python3 scripts/aws_sandbox.py init --profile SANDBOX_PROFILE --account-id ACCOUNT_ID
python3 scripts/aws_sandbox.py check
```

Skip `sso login` for profiles that use another authentication method.
`init` saves settings in `generated/aws/config.json`. Defaults are `us-east-1`,
VPC `10.86.0.0/16`, and deployment name `mmrf-synthetic`.

Optional `init` arguments: `--region`, `--name`, `--vpc-cidr`,
`--kubernetes-version`, `--operator-cidr PUBLIC_IP/32`, and
`--role-arn FULL_IAM_ROLE_ARN`. Supply the full role ARN if IAM role lookup is
unavailable. API access defaults to the detected public IPv4 address.

## Deploy

```sh
python3 scripts/aws_sandbox.py deploy
```

The command displays a Terraform plan and requests account-ID confirmation.
It then builds images while AWS provisions resources, publishes the images,
installs the chart, and checks HTTPS access and the synthetic API.

To finish building before provisioning:

```sh
python3 scripts/aws_sandbox.py build
python3 scripts/aws_sandbox.py deploy --skip-build
```

Faster redeploys, after one full build and deploy:

```sh
python3 scripts/aws_sandbox.py deploy --only identity,frontend  # rebuild only these
python3 scripts/aws_sandbox.py deploy --config-only             # Helm settings only
```

`identity`, `seed` and `proteinpaint` each contain the generated fixtures, so use `--only` with images built from this checkout. Run `scripts/smoke.py` afterwards: mismatched images leave `guppy` and `analysis` waiting for the seed, or make mutation counts disagree with cohorts.

Stop any local Compose stack before building if Docker memory is constrained.
After a failed or interrupted deployment, rerun `deploy` from the same
checkout, adding `--skip-build` if the build finished. Existing local images
must still be present.

## Knowledge graph

To also deploy the myeloma knowledge graph, run `init` with `--enable-knowledge-graph`, or set `"enable_knowledge_graph": true` in `generated/aws/config.json`. `deploy` then builds the Lambda package, creates a private VPC, Neptune, two Lambdas and a Gateway, and loads the graph from public sources. With AgentCore enabled, the agent gets the graph tools.

To load the graph again, such as after a failed load:

```sh
python3 scripts/aws_sandbox.py load-graph
```

Rerunning is safe because every write is a `MERGE`. Neptune bills while idle at a minimum of 1 capacity unit, up to 8 under load. See [`knowledge-graph/README.md`](../knowledge-graph/README.md).

## Access and test

```sh
python3 scripts/aws_sandbox.py credentials
python3 scripts/aws_sandbox.py status
```

Open the printed HTTPS URL and enter the generated team username/password.
For full API checks, replace the example hostname:

```sh
python3 scripts/smoke.py --origin https://DISTRIBUTION.cloudfront.net \
  --access-file generated/aws/access.json
```

See [validation](verification.md) for browser checks and
[cluster diagnostics](aws-manual.md) for pod logs and port forwarding.

## Tear down

```sh
python3 scripts/aws_sandbox.py destroy
```

Review the destroy plan and confirm the account ID. Cleanup can take tens of
minutes. Keep the checkout, `generated/aws/`, and Terraform state until cleanup
succeeds; retry from that directory if interrupted. Verify the created resources
are gone in the AWS console. There is no automatic shutdown.

`destroy` also deletes the knowledge graph with no snapshot. `load-graph` can rebuild it after a new deploy.

The graph can add 30 to 40 minutes. AWS can take 20 minutes or more to release the Lambdas' network interfaces, so `destroy` may stop with a `DependencyViolation` on a security group or subnet. If it does, wait and rerun `destroy` from the same checkout. Never discard the state.

## Operational notes

- Resources incur charges until deleted, including while the browser is closed.
- ProteinPaint may use 6 GiB: each concurrent edgeR differential expression
  needs about 0.85 GiB, so about six can run at once. Wilcoxon needs far less.
- Data is ephemeral and reseeded when Elasticsearch storage is recreated. An
  upgrade that changes the seed image replaces the search indices; Guppy and
  Analysis restart and wait for that reseed, and the post-deploy check compares
  High risk case membership with `generated/cases.json`.
- Keep account, region, and deployment name unchanged until teardown. If the
  public IP changes, update `operator_cidr` in the saved configuration and redeploy.
- NetworkPolicies use the VPC CNI's standard mode, which has an allow window
  during pod startup. This is a shared synthetic environment, not a production
  authorization or availability test.
