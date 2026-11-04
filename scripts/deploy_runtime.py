"""infra-1 deploy hook: build the ARM64 agent image and create or update the Runtime.

aws_sandbox.py calls deploy(ctx) after install(). `ctx` provides:

- outputs: Terraform outputs as plain values
- profile (None uses the default AWS credentials), region
- access: the contents of generated/aws/access.json (origin, username, password),
  or None to deploy without the Virtual Lab data
- extra_env (optional): more Runtime environment variables
- run(args, capture=False, data=None, quiet=False): the launcher's command helper
- directory: Path of generated/aws

The Runtime is created here, not in Terraform, because the provider can't set
requireMMDSV2 and the team password must stay out of Terraform state. See
docs/plans/infra-1-agentcore-runtime.md.
"""
import json
import os
from pathlib import Path
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL_ID = "global.anthropic.claude-sonnet-4-6"
SERVING_PORT = "8080"
# The agent is stateless (history arrives in each request), so release idle
# microVMs quickly.
LIFECYCLE = {"idleRuntimeSessionTimeout": 300, "maxLifetime": 1800}
POLL_SECONDS = 5
POLL_LIMIT = 120


def profile_args(ctx):
    return ["--profile", ctx.profile] if ctx.profile else []


def aws(ctx, service, *args):
    output = ctx.run(["aws", service, *args, *profile_args(ctx), "--region", ctx.region,
                      "--output", "json"], capture=True)
    return json.loads(output) if output.strip() else {}


def control(ctx, *args):
    return aws(ctx, "bedrock-agentcore-control", *args)


def control_with_input(ctx, operation, request):
    """Pass the request as a private file: run() prints its arguments, and the
    environment variables hold the team password."""
    with tempfile.NamedTemporaryFile("w", suffix=".json") as handle:
        os.fchmod(handle.fileno(), 0o600)
        json.dump(request, handle)
        handle.flush()
        return control(ctx, operation, "--cli-input-json", "file://" + handle.name)


def build_and_push(ctx, repository):
    registry = repository.split("/")[0]
    token = ctx.run(["aws", "ecr", "get-login-password", *profile_args(ctx),
                     "--region", ctx.region], capture=True, quiet=True)
    ctx.run(["docker", "login", "--username", "AWS", "--password-stdin", registry], data=token)
    # The repository's tags are immutable, so every deploy needs a new one.
    image = repository + ":" + time.strftime("%Y%m%d%H%M%S", time.gmtime())
    # Attestations would turn the image into a multi-entry index.
    ctx.run(["docker", "buildx", "build", "--platform", "linux/arm64", "--provenance=false",
             "--sbom=false", "-f", "docker/agent.Dockerfile", "-t", image, "--push", str(ROOT)])
    return image


def runtime_environment(ctx):
    environment = {
        "AGENT_PORT": SERVING_PORT,
        "AWS_REGION": ctx.region,
        "BEDROCK_MODEL_ID": os.environ.get("BEDROCK_MODEL_ID", DEFAULT_MODEL_ID),
    }
    if ctx.access:
        environment.update(VIRTUAL_LAB_ORIGIN=ctx.access["origin"],
                           SANDBOX_ACCESS_USERNAME=ctx.access["username"],
                           SANDBOX_ACCESS_PASSWORD=ctx.access["password"])
    if os.environ.get("KG_GATEWAY_URL"):
        environment["KG_GATEWAY_URL"] = os.environ["KG_GATEWAY_URL"]
    environment.update(getattr(ctx, "extra_env", {}))
    return environment


def runtime_settings(ctx, image, role_arn):
    return {
        "agentRuntimeArtifact": {"containerConfiguration": {"containerUri": image}},
        "roleArn": role_arn,
        "networkConfiguration": {"networkMode": "PUBLIC"},
        "protocolConfiguration": {"serverProtocol": "HTTP"},
        "lifecycleConfiguration": LIFECYCLE,
        # Sent in full on every update: whether an update keeps variables it
        # isn't given is not documented.
        "environmentVariables": runtime_environment(ctx),
    }


def find_runtime(ctx, name):
    # The CLI follows pagination itself.
    for runtime in control(ctx, "list-agent-runtimes").get("agentRuntimes", []):
        if runtime["agentRuntimeName"] == name:
            return runtime
    return None


def wait_until_ready(ctx, runtime_id, sleep=time.sleep):
    for _ in range(POLL_LIMIT):
        status = control(ctx, "get-agent-runtime", "--agent-runtime-id", runtime_id)["status"]
        if status == "READY":
            return
        if status.endswith("FAILED"):
            raise ValueError(f"Agent runtime {runtime_id} reached {status}")
        sleep(POLL_SECONDS)
    raise ValueError(f"Agent runtime {runtime_id} did not become READY")


def apply_runtime(ctx, name, settings, sleep=time.sleep):
    existing = find_runtime(ctx, name)
    if existing:
        runtime_id = existing["agentRuntimeId"]
    else:
        runtime_id = control_with_input(ctx, "create-agent-runtime",
                                        {"agentRuntimeName": name, **settings})["agentRuntimeId"]
    wait_until_ready(ctx, runtime_id, sleep)
    # CreateAgentRuntime can't set this, and invocations fail without it.
    updated = control_with_input(ctx, "update-agent-runtime", {
        "agentRuntimeId": runtime_id, **settings, "metadataConfiguration": {"requireMMDSV2": True},
    })
    wait_until_ready(ctx, runtime_id, sleep)
    return updated


def deploy(ctx):
    repository = ctx.outputs.get("agent_runtime_repository_url")
    if not repository:
        print("AgentCore steps skipped")
        return None
    image = build_and_push(ctx, repository)
    runtime = apply_runtime(ctx, ctx.outputs["agent_runtime_name"],
                            runtime_settings(ctx, image, ctx.outputs["agent_runtime_role_arn"]))
    record = {key: runtime[key] for key in ("agentRuntimeArn", "agentRuntimeId", "agentRuntimeVersion")}
    (ctx.directory / "agent-runtime.json").write_text(json.dumps(record, indent=2) + "\n")
    print("Agent runtime ready: " + record["agentRuntimeArn"])
    return record


def destroy(ctx):
    """Terraform doesn't own the Runtime, so teardown has to delete it here."""
    name = ctx.outputs.get("agent_runtime_name")
    runtime = find_runtime(ctx, name) if name else None
    if runtime:
        control(ctx, "delete-agent-runtime", "--agent-runtime-id", runtime["agentRuntimeId"])
