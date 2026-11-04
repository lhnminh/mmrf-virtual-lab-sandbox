# Terraform improvements for the AgentCore POC

Two stages on top of the merged survival work. Tag `pre-terraform-hardening` marks the last code fully deployed before this work. The fix in `e9274d2` wasn't deployed then, so it ships with the first apply.

## Stage 1: `feature/terraform-hardening`

Apply and check one commit at a time. Revert the commit, rebuild and apply if a check fails. The Runtime ARN doesn't change, so Chat needs no config change. New tests are out of scope; the existing tests must still pass.

| Commit | Change | Live effect | Check |
| --- | --- | --- | --- |
| 1 | Descriptions, retention local | None from this commit; the pending Lambda fix ships here | A CGS risk survival question in Chat |
| 2 | `lambda_memory_mb`, default 512 | Lambda updated | A tool call works |
| 3 | Timeout and token variables, passed to the agent | Lambda and Runtime updated, same values. Run `scripts/build_agent.sh` first | A full chat journey |
| 4 | Gateway trust limited to this gateway's name | Gateway role updated | A tool call through Gateway |

The last time to start applying before the Nov 4 demo is 15:00, and nothing new goes on after rehearsal. Commit 4 is the first to drop if time is short.

The Runtime keeps the `:*` trust from the AWS Runtime docs. The Gateway form comes from the AWS Gateway docs.

## Stage 2: `feature/agentcore-module`

The folder `agentcore-poc` was later renamed `agentcore`. Paths below use the old name.

Done on 2026-11-04, before the demo, by the user's decision. The new stack is created alongside the POC, and the POC is destroyed only after the new one is verified.

Move the stack into root `terraform/` as a child module.

1. Agree the module approach and contract differences with the team: AG-UI, the tool result shape and `AGENTCORE_GATEWAY_URL`.
2. Add `modules/agentcore` and `agentcore.tf`, with `count = var.enable_agentcore ? 1 : 0` and `sandbox_origin` read from the CloudFront distribution. `enable_agentcore` needs `enable_https`.
3. Raise the root AWS provider to `~> 6.71` and add `archive`. The lock pins 6.69.1, so `terraform init` fails until `init -upgrade`. Commit the lock on its own.
4. Remove the module's defaults for required inputs, and pass the source folder in as `source_dir`.
5. Have the launcher write `enable_agentcore` and `agent_zip_path`, build the agent before the plan and fill the secret after the apply.
6. Read the root plan and stop on any unexpected destroy. Back up state.
7. Destroy the POC stack from its own folder before removing those files. Don't use `terraform state mv`, because resource names change.
8. Apply only from `my-forks` until the `lhnminh` clone has the same code. The clones share root state, so applying from a clone without the module destroys AgentCore.
9. Update `AGENTCORE_RUNTIME_ARN` in `.env.development.local`, then rerun the journeys.

Take from the team's branches: `enable_agentcore`, the launcher hooks, underscore Runtime naming, tracing permissions when traces are on, and the node role and NetworkPolicy for Chat on the deployed site, narrowed to the real Runtime ARN.
