# Knowledge graph

The Lambda code, scripts and tests behind the five `kg_*` tools the Virtual Lab agent can call. Terraform for it is in `terraform/modules/knowledge-graph`, switched on by `enable_knowledge_graph`. See [the design](../docs/superpowers/specs/2026-11-04-knowledge-graph-in-sandbox-design.md).

## Where the code came from

It's copied from the team's `MMRF-KnowledgeGraph` repo at commit `2e11be0`, and the smoke test from `4ff2fe1`. `lambda/handler.py` and `lambda/load_neo4j.py` are unchanged, so `docs/mcp-tools.md` in that repo still describes the tools. This copy doesn't sync automatically.

| Path | Holds |
| --- | --- |
| `lambda/handler.py` | The `kg-graph` tools, read only |
| `lambda/load_neo4j.py` | The `kg-ingest` loader |
| `tools.json` | The tool schemas that Gateway publishes |
| `scripts/` | Fetch the sources, build `build/lambda.zip`, smoke test the Gateway |

## Commands

```sh
uv run pytest -q                             # Unit tests, no AWS needed
uv run python scripts/build_lambda.py        # Rebuild the Lambda package
AWS_PROFILE=workshop uv run python scripts/smoke_test.py   # Call every tool through the deployed Gateway
```

From the repo root, `python3 scripts/aws_sandbox.py load-graph` fetches the sources, uploads them and loads the graph. It's safe to rerun because every write is a `MERGE`.

## Data

- Monarch KG is fetched live, so its version can change between loads.
- DisMech is pinned to commit `b1ca0b232b815a21b4ba95a62828c9979e9a49e7` (release `v0.1.46`).
- Raw files stay in the git-ignored `data/`. Don't commit DisMech data: its bulk-data terms are unconfirmed.
- All of it is public reference data, not the Virtual Lab's synthetic data.

## Rules for answers from the graph

- Pass on `limitations`, and cite each source and version.
- Keep `observations` apart from `interpretation`.
- Say "none recorded", never "none exists".
- Give no treatment recommendations.
- Graph content is published knowledge, and never validates a synthetic Virtual Lab result.
