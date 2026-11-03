#!/usr/bin/env python3
"""Run the agent on AgentCore Runtime without the rest of the sandbox.

Stands in for what infra-3's F1 will provide: the repository and role that
terraform/agentcore-runtime.tf creates, and the `ctx` that aws_sandbox.py passes
to deploy_runtime.deploy(). Names use `mmrf-smoke`, so they can't collide with
the real resources. Uses the default AWS credentials.

    python3 scripts/runtime_smoke.py up       # create everything and invoke
    python3 scripts/runtime_smoke.py invoke "A question"
    python3 scripts/runtime_smoke.py down     # delete everything

Without VIRTUAL_LAB_ORIGIN the agent is chat-only. To use the tools, also set
SANDBOX_ACCESS_USERNAME and SANDBOX_ACCESS_PASSWORD.
"""
import argparse
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import deploy_runtime  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
NAME = "mmrf-smoke"
REPOSITORY = NAME + "/agent-runtime"
ROLE = NAME + "-agent-runtime"
RUNTIME = NAME.replace("-", "_") + "_agent"
TAGS = [{"Key": "Project", "Value": "mmrf-virtual-lab-sandbox"},
        {"Key": "Purpose", "Value": "agentcore-runtime-smoke"}]
DEFAULT_QUESTION = "In one sentence, what is this sandbox for?"


@dataclass
class Context:
    region: str
    account: str
    outputs: dict = field(default_factory=dict)
    access: dict | None = None
    extra_env: dict = field(default_factory=dict)
    profile: str | None = None
    directory: Path = ROOT / "generated/runtime-smoke"

    def run(self, args, capture=False, data=None, quiet=False):
        args = [str(arg) for arg in args]
        if not quiet:
            print("+ " + " ".join(args), flush=True)
        return subprocess.run(args, cwd=ROOT, input=data, text=True, check=True,
                              stdout=subprocess.PIPE if capture else None).stdout

    def probe(self, args):
        return subprocess.run(args, cwd=ROOT, capture_output=True, text=True)


def trust_policy(ctx):
    return {"Version": "2012-10-17", "Statement": [{
        "Effect": "Allow",
        "Principal": {"Service": "bedrock-agentcore.amazonaws.com"},
        "Action": "sts:AssumeRole",
        "Condition": {
            "StringEquals": {"aws:SourceAccount": ctx.account},
            "ArnLike": {"aws:SourceArn": f"arn:aws:bedrock-agentcore:{ctx.region}:{ctx.account}:*"},
        },
    }]}


def role_policy(ctx):
    """Keep in step with aws_iam_role_policy.agent_runtime."""
    logs = f"arn:aws:logs:{ctx.region}:{ctx.account}:log-group:"
    runtimes = logs + "/aws/bedrock-agentcore/runtimes/"
    directory = f"arn:aws:bedrock-agentcore:{ctx.region}:{ctx.account}:workload-identity-directory/default"
    allow = lambda action, resource, **extra: {"Effect": "Allow", "Action": action, "Resource": resource, **extra}
    return {"Version": "2012-10-17", "Statement": [
        allow(["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
              f"arn:aws:ecr:{ctx.region}:{ctx.account}:repository/{REPOSITORY}"),
        allow("ecr:GetAuthorizationToken", "*"),
        allow(["logs:DescribeLogStreams", "logs:CreateLogGroup"], runtimes + "*"),
        allow("logs:PutResourcePolicy", runtimes + RUNTIME + "-*"),
        allow("logs:DescribeLogGroups", logs + "*"),
        allow(["logs:CreateLogStream", "logs:PutLogEvents"], runtimes + "*:log-stream:*"),
        allow(["xray:PutTraceSegments", "xray:PutTelemetryRecords",
               "xray:GetSamplingRules", "xray:GetSamplingTargets"], "*"),
        allow("cloudwatch:PutMetricData", "*",
              Condition={"StringEquals": {"cloudwatch:namespace": "bedrock-agentcore"}}),
        allow(["bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
               "bedrock-agentcore:GetWorkloadAccessTokenForUserId"],
              [directory, f"{directory}/workload-identity/{RUNTIME}-*"]),
        allow(["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
              ["arn:aws:bedrock:*::foundation-model/*", f"arn:aws:bedrock:{ctx.region}:{ctx.account}:*"]),
        allow(["aws-marketplace:ViewSubscriptions", "aws-marketplace:Subscribe"], "*"),
    ]}


def exists(ctx, *args):
    return ctx.probe(["aws", *args, "--region", ctx.region]).returncode == 0


def ensure_repository(ctx):
    if not exists(ctx, "ecr", "describe-repositories", "--repository-names", REPOSITORY):
        deploy_runtime.aws(ctx, "ecr", "create-repository", "--repository-name", REPOSITORY,
                           "--image-tag-mutability", "IMMUTABLE",
                           "--tags", json.dumps(TAGS))
    return f"{ctx.account}.dkr.ecr.{ctx.region}.amazonaws.com/{REPOSITORY}"


def ensure_role(ctx):
    created = not exists(ctx, "iam", "get-role", "--role-name", ROLE)
    if created:
        deploy_runtime.aws(ctx, "iam", "create-role", "--role-name", ROLE,
                           "--assume-role-policy-document", json.dumps(trust_policy(ctx)),
                           "--tags", json.dumps(TAGS))
    deploy_runtime.aws(ctx, "iam", "put-role-policy", "--role-name", ROLE, "--policy-name", "agent-runtime",
                       "--policy-document", json.dumps(role_policy(ctx)))
    if created:
        time.sleep(15)  # New IAM roles take a moment to reach AgentCore.
    return f"arn:aws:iam::{ctx.account}:role/{ROLE}"


def configure(ctx):
    origin = os.environ.get("VIRTUAL_LAB_ORIGIN")
    if origin:
        ctx.access = {"origin": origin, "username": os.environ["SANDBOX_ACCESS_USERNAME"],
                      "password": os.environ["SANDBOX_ACCESS_PASSWORD"]}
    else:
        ctx.extra_env = {"AGENT_CHAT_ONLY": "1"}


def up(ctx):
    configure(ctx)
    ctx.directory.mkdir(parents=True, exist_ok=True)
    ctx.outputs = {"agent_runtime_repository_url": ensure_repository(ctx),
                   "agent_runtime_role_arn": ensure_role(ctx), "agent_runtime_name": RUNTIME}
    deploy_runtime.deploy(ctx)


def invoke(ctx, question, session=None):
    record = json.loads((ctx.directory / "agent-runtime.json").read_text())
    session = session or str(uuid.uuid4())
    with tempfile.TemporaryDirectory() as folder:
        payload = Path(folder) / "payload.json"
        payload.write_text(json.dumps({"prompt": question}))
        response = Path(folder) / "response.json"
        started = time.monotonic()
        ctx.run(["aws", "bedrock-agentcore", "invoke-agent-runtime", "--region", ctx.region,
                 "--agent-runtime-arn", record["agentRuntimeArn"], "--runtime-session-id", session,
                 "--content-type", "application/json", "--accept", "application/json",
                 "--payload", f"fileb://{payload}", response], capture=True)
        elapsed = time.monotonic() - started
        print(f"[{elapsed:.1f}s, session {session}]")
        print(response.read_text())
    return session


def down(ctx):
    ctx.outputs = {"agent_runtime_name": RUNTIME}
    deploy_runtime.destroy(ctx)
    if exists(ctx, "ecr", "describe-repositories", "--repository-names", REPOSITORY):
        deploy_runtime.aws(ctx, "ecr", "delete-repository", "--repository-name", REPOSITORY, "--force")
    if exists(ctx, "iam", "get-role", "--role-name", ROLE):
        deploy_runtime.aws(ctx, "iam", "delete-role-policy", "--role-name", ROLE, "--policy-name", "agent-runtime")
        deploy_runtime.aws(ctx, "iam", "delete-role", "--role-name", ROLE)
    record = ctx.directory / "agent-runtime.json"
    record.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["up", "invoke", "down"])
    parser.add_argument("question", nargs="?", default=DEFAULT_QUESTION)
    parser.add_argument("--session", help="Reuse a session id (33 characters or more)")
    options = parser.parse_args()
    region = os.environ.get("AWS_REGION", "us-east-1")
    identity = subprocess.run(["aws", "sts", "get-caller-identity", "--output", "json"],
                              capture_output=True, text=True, check=True)
    ctx = Context(region=region, account=json.loads(identity.stdout)["Account"])
    if options.command == "up":
        up(ctx)
        session = invoke(ctx, options.question)
        invoke(ctx, options.question, session)
    elif options.command == "invoke":
        invoke(ctx, options.question, options.session)
    else:
        down(ctx)


if __name__ == "__main__":
    main()
