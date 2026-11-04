"""Offline tests for the infra-1 deploy hook. No subprocess or AWS endpoint is contacted."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

PATH = Path(__file__).resolve().parents[1] / "scripts" / "deploy_runtime.py"
SPEC = importlib.util.spec_from_file_location("deploy_runtime", PATH)
deploy_runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy_runtime)

ARN = "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/mmrf_agent-abcde12345"
PASSWORD = "team-password-that-must-not-be-printed"


class FakeContext:
    def __init__(self, directory, repository="111122223333.dkr.ecr.us-east-1.amazonaws.com/mmrf/agent-runtime",
                 existing=(), statuses=()):
        self.outputs = {"agent_runtime_repository_url": repository, "agent_runtime_name": "mmrf_agent",
                        "agent_runtime_role_arn": "arn:aws:iam::111122223333:role/mmrf-agent-runtime"}
        self.profile, self.region, self.directory = "sandbox", "us-east-1", Path(directory)
        self.access = {"origin": "https://abc.cloudfront.net", "username": "sandbox", "password": PASSWORD}
        self.existing, self.statuses = list(existing), list(statuses)
        self.commands, self.requests = [], []

    def run(self, args, capture=False, data=None, quiet=False):
        args = [str(arg) for arg in args]
        self.commands.append(args)
        if args[:2] == ["aws", "ecr"]:
            return "token"
        if args[0] == "docker":
            return ""
        operation = args[2]
        if "--cli-input-json" in args:
            path = args[args.index("--cli-input-json") + 1].removeprefix("file://")
            self.requests.append((operation, json.loads(Path(path).read_text())))
            return json.dumps({"agentRuntimeArn": ARN, "agentRuntimeId": "mmrf_agent-abcde12345",
                               "agentRuntimeVersion": "2"})
        if operation == "list-agent-runtimes":
            return json.dumps({"agentRuntimes": self.existing})
        if operation == "get-agent-runtime":
            return json.dumps({"status": self.statuses.pop(0) if self.statuses else "READY"})
        return ""


class DeployRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def test_skips_when_agentcore_is_off(self):
        ctx = FakeContext(self.temp.name, repository=None)
        self.assertIsNone(deploy_runtime.deploy(ctx))
        self.assertEqual(ctx.commands, [])

    def test_first_deploy_creates_then_enables_mmdsv2(self):
        ctx = FakeContext(self.temp.name)
        record = deploy_runtime.deploy(ctx)
        self.assertEqual([operation for operation, _ in ctx.requests],
                         ["create-agent-runtime", "update-agent-runtime"])
        created, updated = ctx.requests[0][1], ctx.requests[1][1]
        self.assertEqual(created["agentRuntimeName"], "mmrf_agent")
        self.assertNotIn("metadataConfiguration", created)
        self.assertEqual(updated["metadataConfiguration"], {"requireMMDSV2": True})
        self.assertEqual(updated["environmentVariables"], created["environmentVariables"])
        self.assertEqual(created["environmentVariables"]["AGENT_PORT"], "8080")
        self.assertEqual(created["networkConfiguration"], {"networkMode": "PUBLIC"})
        saved = json.loads((ctx.directory / "agent-runtime.json").read_text())
        self.assertEqual(saved, record)
        self.assertEqual(saved["agentRuntimeArn"], ARN)

    def test_rerun_updates_with_a_new_image(self):
        ctx = FakeContext(self.temp.name, existing=[
            {"agentRuntimeName": "other", "agentRuntimeId": "other-0000000000"},
            {"agentRuntimeName": "mmrf_agent", "agentRuntimeId": "mmrf_agent-abcde12345"},
        ])
        deploy_runtime.deploy(ctx)
        self.assertEqual([operation for operation, _ in ctx.requests], ["update-agent-runtime"])
        self.assertEqual(ctx.requests[0][1]["agentRuntimeId"], "mmrf_agent-abcde12345")
        image = ctx.requests[0][1]["agentRuntimeArtifact"]["containerConfiguration"]["containerUri"]
        self.assertTrue(image.startswith(ctx.outputs["agent_runtime_repository_url"] + ":"))

    def test_image_is_arm64_from_the_agent_dockerfile(self):
        ctx = FakeContext(self.temp.name)
        deploy_runtime.deploy(ctx)
        build = next(args for args in ctx.commands if args[:3] == ["docker", "buildx", "build"])
        self.assertIn("linux/arm64", build)
        self.assertIn("docker/agent.Dockerfile", build)
        self.assertIn("--push", build)

    def test_password_is_never_a_command_argument(self):
        ctx = FakeContext(self.temp.name)
        deploy_runtime.deploy(ctx)
        self.assertFalse(any(PASSWORD in arg for args in ctx.commands for arg in args))
        self.assertEqual(ctx.requests[0][1]["environmentVariables"]["SANDBOX_ACCESS_PASSWORD"], PASSWORD)

    def test_observability_defaults_allow_explicit_overrides(self):
        ctx = FakeContext(self.temp.name)
        environment = deploy_runtime.runtime_environment(ctx)
        self.assertEqual(environment["AGENT_OBSERVABILITY_ENABLED"], "true")
        self.assertEqual(environment["OTEL_SERVICE_NAME"], "mmrf-orchestrator-agent")
        self.assertEqual(environment["OTEL_AWS_APPLICATION_SIGNALS_ENABLED"], "false")
        ctx.extra_env = {"AGENT_OBSERVABILITY_ENABLED": "false", "OTEL_SERVICE_NAME": "custom-agent"}
        environment = deploy_runtime.runtime_environment(ctx)
        self.assertEqual(environment["AGENT_OBSERVABILITY_ENABLED"], "false")
        self.assertEqual(environment["OTEL_SERVICE_NAME"], "custom-agent")

    def test_failed_runtime_stops_the_deploy(self):
        ctx = FakeContext(self.temp.name, statuses=["CREATING", "CREATE_FAILED"])
        with self.assertRaisesRegex(ValueError, "CREATE_FAILED"):
            deploy_runtime.apply_runtime(ctx, "mmrf_agent", {}, sleep=lambda _: None)

    def test_destroy_deletes_only_the_named_runtime(self):
        ctx = FakeContext(self.temp.name, existing=[
            {"agentRuntimeName": "other", "agentRuntimeId": "other-0000000000"},
            {"agentRuntimeName": "mmrf_agent", "agentRuntimeId": "mmrf_agent-abcde12345"},
        ])
        deploy_runtime.destroy(ctx)
        deletes = [args for args in ctx.commands if "delete-agent-runtime" in args]
        self.assertEqual(len(deletes), 1)
        self.assertIn("mmrf_agent-abcde12345", deletes[0])


if __name__ == "__main__":
    unittest.main()
