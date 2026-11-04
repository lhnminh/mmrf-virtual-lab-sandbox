"""Offline launcher regressions. No subprocess or AWS endpoint is contacted."""
import argparse
import importlib.util
import json
import os
import subprocess
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import Mock, patch


def module(name):
    path = Path(__file__).resolve().parents[1] / "scripts" / (name + ".py")
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


launcher = module("aws_sandbox")
connection = module("sandbox_connection")
CONFIG = {"profile": "unit-test", "account_id": "123456789012", "region": "us-east-1",
          "role_arn": "arn:aws:iam::123456789012:role/unit-test", "name": "mmrf-synthetic",
          "operator_cidr": "192.0.2.1/32", "vpc_cidr": "10.86.0.0/16", "kubernetes_version": "1.35"}


def json_response(value):
    """Return a context-managed HTTP response without performing I/O."""
    response = Mock()
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    response.read.return_value = json.dumps(value).encode()
    return response


class LauncherTests(unittest.TestCase):
    def test_live_acceptance_refuses_anonymous_application_access(self):
        opener = Mock()
        credentials = {"origin": "https://unitfixture.cloudfront.net", "username": "sandbox", "password": "unit-test-only"}
        with patch.object(launcher.urllib.request, "build_opener", return_value=opener):
            with self.assertRaisesRegex(ValueError, "reachable without team authentication"):
                launcher.check_site(credentials, attempts=1)
        self.assertEqual(opener.open.call_count, 1)

    def test_live_acceptance_requires_expected_authenticated_fixture(self):
        projects = [{"project_id": name, "disease_type": ["Synthetic"], "primary_site": ["Synthetic"],
                     "summary": {"case_count": 500, "data_categories": [{"data_category": "Sequencing"}]}}
                    for name in ["SYNTHETIC-MM", "SYNTHETIC-RNA"]]
        credentials = {"origin": "https://unitfixture.cloudfront.net", "username": "sandbox", "password": "unit-test-only"}
        risk = lambda category: {"cgs_risk_key_criteria": {"cgs_risk_category": category}}
        fixtures = [{"case_id": "SYNTH-CASE-0001", **risk("High risk")}, {"case_id": "SYNTH-CASE-0002", **risk("Standard risk")}]
        for served, passes in ((["SYNTH-CASE-0001"], True), (["SYNTH-CASE-0002"], False)):
            with self.subTest(served=served), tempfile.TemporaryDirectory() as root:
                (Path(root) / "generated").mkdir()
                (Path(root) / "generated/cases.json").write_text(json.dumps(fixtures))
                opener = Mock()
                opener.open.side_effect = [urllib.error.HTTPError("https://unitfixture.cloudfront.net/sandbox/status", 401, "Unauthorized", {}, None),
                                          json_response({"synthetic": True, "cases": 1000}),
                                          json_response({"data": {"Project_project": projects}}),
                                          json_response({"data": {"Case_case": [{"case_id": c} for c in served]}})]
                with patch.object(launcher, "ROOT", Path(root)), \
                        patch.object(launcher.urllib.request, "build_opener", return_value=opener):
                    if not passes:
                        # Same counts, different cohort: an upgrade that kept old search data.
                        with self.assertRaises(launcher.FixtureMismatch):
                            launcher.check_site(credentials, attempts=1)
                        continue
                    launcher.check_site(credentials, attempts=1)
                request = opener.open.call_args_list[1].args[0]
                self.assertEqual(request.full_url, credentials["origin"] + "/sandbox/status")
                self.assertTrue(request.get_header("Authorization").startswith("Basic "))
                projects_request = opener.open.call_args_list[2].args[0]
                self.assertEqual(projects_request.full_url, credentials["origin"] + "/guppy/graphql")
                self.assertEqual(projects_request.get_header("Authorization"), request.get_header("Authorization"))

    def test_live_acceptance_rejects_missing_or_invalid_project_schema(self):
        """A healthy identity response must not conceal a broken Projects page."""
        for result in [{"errors": [{"message": "String cannot represent value"}], "data": None},
                       {"data": {"Project_project": []}},
                       {"data": {"Project_project": [{"project_id": name, "disease_type": "scalar"}
                                                     for name in ["SYNTHETIC-MM", "SYNTHETIC-RNA"]]}}]:
            with self.subTest(result=result):
                opener = Mock()
                opener.open.side_effect = [urllib.error.HTTPError("https://unitfixture.cloudfront.net/sandbox/status", 401, "Unauthorized", {}, None),
                                          json_response({"synthetic": True, "cases": 1000}), json_response(result)]
                credentials = {"origin": "https://unitfixture.cloudfront.net", "username": "sandbox", "password": "unit-test-only"}
                with patch.object(launcher.urllib.request, "build_opener", return_value=opener):
                    with self.assertRaisesRegex(ValueError, "Projects"):
                        launcher.check_site(credentials, attempts=1)

    def test_live_acceptance_rejects_incorrect_project_counts(self):
        for project_id in ["SYNTHETIC-MM", "SYNTHETIC-RNA"]:
            for count in [None, 0, 499, "500"]:
                with self.subTest(project=project_id, count=count):
                    projects = [{"project_id": name, "disease_type": ["Synthetic"], "primary_site": ["Synthetic"],
                                 "summary": {"case_count": 500, "data_categories": [{"data_category": "Sequencing"}]}}
                                for name in ["SYNTHETIC-MM", "SYNTHETIC-RNA"]]
                    summary = next(p["summary"] for p in projects if p["project_id"] == project_id)
                    if count is None:
                        del summary["case_count"]
                    else:
                        summary["case_count"] = count
                    opener = Mock()
                    opener.open.side_effect = [urllib.error.HTTPError("https://unitfixture.cloudfront.net/sandbox/status", 401, "Unauthorized", {}, None),
                                              json_response({"synthetic": True, "cases": 1000}),
                                              json_response({"data": {"Project_project": projects}})]
                    credentials = {"origin": "https://unitfixture.cloudfront.net", "username": "sandbox", "password": "unit-test-only"}
                    with patch.object(launcher.urllib.request, "build_opener", return_value=opener):
                        with self.assertRaisesRegex(ValueError, "500 synthetic cases"):
                            launcher.check_site(credentials, attempts=1)

    def test_wrong_account_prevents_build_plan_and_apply(self):
        operator = launcher.Operator(CONFIG)
        operator.aws = Mock(return_value={"Account": "999999999999", "Arn": "test"})
        operator.build = Mock()
        operator.tf = Mock()
        with self.assertRaisesRegex(ValueError, "configured sandbox account"):
            operator.deploy(yes=True)
        operator.build.assert_not_called()
        operator.tf.assert_not_called()

    def test_profile_environment_cannot_be_overridden_by_ambient_credentials(self):
        with patch.dict(os.environ, {"AWS_ACCESS_KEY_ID": "unit-test", "AWS_SECRET_ACCESS_KEY": "unit-test",
                                    "AWS_ENDPOINT_URL": "https://unexpected.invalid", "TF_VAR_sandbox_account_id": "other"}):
            env = launcher.environment(CONFIG)
        self.assertEqual(env["AWS_PROFILE"], "unit-test")
        for key in ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL", "TF_VAR_sandbox_account_id"]:
            self.assertNotIn(key, env)

    def test_named_role_is_required(self):
        operator = launcher.Operator(CONFIG)
        operator.aws = Mock(return_value={"Account": CONFIG["account_id"], "Arn": "arn:aws:sts::123456789012:assumed-role/OtherRole/session"})
        with self.assertRaisesRegex(ValueError, "configured operator IAM role"):
            operator.identity()

    def test_only_rebuilds_named_services_and_keeps_other_image_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            operator = launcher.Operator(CONFIG)
            operator.directory = Path(directory)
            old = {name: "sha256:old-" + name for name in launcher.SERVICES}
            (operator.directory / "build.json").write_text(json.dumps({"tag": "build-old", "images": old}))
            built = []
            def run(args, capture=False, **_):
                args = [str(arg) for arg in args]
                if "build" in args and args[0] == "docker":
                    built.append(args[-1])
                if "{{.Architecture}}" in args:
                    return "amd64\n"
                if "{{.Id}}" in args:
                    return "sha256:new\n"
                return ""
            operator.run = run
            operator.build(["identity"])
            self.assertEqual(built, ["identity"])
            images = json.loads((operator.directory / "build.json").read_text())["images"]
            self.assertEqual(images["identity"], "sha256:new")
            self.assertEqual(images["seed"], old["seed"])

    def test_only_needs_a_full_build_first(self):
        with tempfile.TemporaryDirectory() as directory:
            operator = launcher.Operator(CONFIG)
            operator.directory = Path(directory)
            (operator.directory / "build.json").write_text(json.dumps({"tag": "x", "images": {"identity": "sha"}}))
            with self.assertRaisesRegex(ValueError, "full build"):
                operator.build(["identity"])

    def test_parse_services_rejects_unknown_names(self):
        self.assertEqual(launcher.parse_services("identity, frontend"), ["identity", "frontend"])
        with self.assertRaises(argparse.ArgumentTypeError):
            launcher.parse_services("identity,nope")

    def test_config_only_reuses_deployed_images_without_terraform_or_build(self):
        with tempfile.TemporaryDirectory() as directory:
            operator = launcher.Operator(CONFIG)
            operator.directory = Path(directory)
            (operator.directory / "values.json").write_text(json.dumps({"images": {"identity": "repo@sha256:1"}}))
            operator.identity = Mock()
            operator.outputs = Mock(return_value={"https_url": "x"})
            operator.install = Mock()
            operator.tf = Mock()
            operator.build = Mock()
            operator.deploy_config()
            operator.install.assert_called_once_with({"https_url": "x"}, {"identity": "repo@sha256:1"})
            operator.tf.assert_not_called()
            operator.build.assert_not_called()

    def install_with(self, outputs, aws=None):
        with tempfile.TemporaryDirectory() as directory:
            operator = launcher.Operator(CONFIG)
            operator.directory = Path(directory)
            for name in ("connect_cluster", "kube", "run", "status"):
                setattr(operator, name, Mock())
            operator.aws = aws or Mock(return_value={"Reservations": []})
            origin = {"https_url": "https://d111111abcdef8.cloudfront.net", "origin_cidrs": ["10.0.0.0/24"]}
            operator.install({**origin, **outputs}, {"identity": "repo@sha256:1"})
            return json.loads((operator.directory / "values.json").read_text())

    def test_chat_uses_the_runtime_terraform_created(self):
        arn = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/agent-abc"
        values = self.install_with({"agent_runtime_arn": arn})
        self.assertEqual(values["agentcore"], {"runtimeArn": arn})

    def test_no_runtime_leaves_chat_unconnected(self):
        aws = Mock()
        self.assertNotIn("agentcore", self.install_with({"agent_runtime_arn": None}, aws))
        aws.assert_not_called()

    def test_runtime_lets_pods_reach_credentials_on_this_clusters_nodes_only(self):
        def instance(name, hop):
            return {"InstanceId": name, "MetadataOptions": {"HttpPutResponseHopLimit": hop}}
        aws = Mock(return_value={"Reservations": [{"Instances": [instance("i-low", 1), instance("i-set", 2)]}]})
        self.install_with({"agent_runtime_arn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/a"}, aws)
        lookup = aws.call_args_list[0].args
        self.assertEqual(lookup[:2], ("ec2", "describe-instances"))
        self.assertIn("Name=tag:eks:cluster-name,Values=" + CONFIG["name"], lookup)
        changes = [call.args for call in aws.call_args_list[1:]]
        self.assertEqual(changes, [("ec2", "modify-instance-metadata-options", "--instance-id", "i-low",
                                    "--http-put-response-hop-limit", "2", "--http-tokens", "required")])

    def test_secrets_are_private_and_origin_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "access.json"
            launcher.private_json(path, {"origin": "https://unitfixture.cloudfront.net", "username": "sandbox", "password": "unit-test-only"})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            headers, opener = connection.connection("https://unitfixture.cloudfront.net", path)
            self.assertIn("Authorization", headers)
            with self.assertRaises(ValueError):
                connection.connection("https://anotherfixture.cloudfront.net", path)
            handler = next(h for h in opener.handlers if type(h).__name__ == "SameOriginRedirect")
            with self.assertRaises(ValueError):
                handler.redirect_request(None, None, 302, "Found", {}, "https://unexpected.invalid/file")

    def test_smoke_tests_cannot_target_production_or_unbound_hosted_sites(self):
        for origin in ["https://virtuallab.themmrf.org", "https://fixture.cloudfront.net", "https://fixture.cloudfront.net.evil.invalid"]:
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                connection.connection(origin)

    def test_empty_ecr_deletes_parent_manifest_before_child(self):
        operator = launcher.Operator(CONFIG)
        operator.aws = Mock(side_effect=[
            {"imageDetails": [{"imageDigest": "child", "imageManifestMediaType": "application/vnd.oci.image.manifest.v1+json"},
                              {"imageDigest": "parent", "imageManifestMediaType": "application/vnd.oci.image.index.v1+json"}]},
            {"failures": []}, {"failures": []}, {"imageDetails": []},
        ])
        operator.empty_repository("frontend")
        self.assertEqual(operator.aws.call_args_list[1].args[-1], "imageDigest=parent")
        self.assertEqual(operator.aws.call_args_list[2].args[-1], "imageDigest=child")

    def test_destroy_refuses_repository_outside_expected_state_namespace(self):
        operator = launcher.Operator(CONFIG)
        operator.identity = Mock()
        operator.init_terraform = Mock()
        operator.empty_repository = Mock()
        state = {"values": {"root_module": {"resources": [{"type": "aws_ecr_repository", "name": "service",
                  "values": {"name": "production/frontend", "arn": "arn:aws:ecr:us-east-1:123456789012:repository/production/frontend"}}]}}}
        operator.tf = Mock(side_effect=[None, json.dumps(state)])
        with self.assertRaisesRegex(ValueError, "unexpected repository"):
            operator.destroy(yes=True)
        operator.empty_repository.assert_not_called()
        self.assertFalse(any(call.args[0] == "apply" for call in operator.tf.call_args_list))

    def test_lock_ignores_leftover_file_and_refuses_held_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            # A file left by an interrupted run holds no OS lock.
            (Path(directory) / "operator.lock").write_text("12345")
            with launcher.lock(Path(directory)):
                with self.assertRaisesRegex(ValueError, "Another launcher command is running"):
                    with launcher.lock(Path(directory)):
                        pass
            with launcher.lock(Path(directory)):
                pass

    def test_agent_secret_is_sent_by_stdin_not_arguments(self):
        operator = launcher.Operator(CONFIG)
        calls = []
        operator.run = lambda args, **kwargs: calls.append((args, kwargs))
        with tempfile.TemporaryDirectory() as directory:
            operator.directory = Path(directory)
            (operator.directory / "access.json").write_text(json.dumps(
                {"origin": "https://x.cloudfront.net", "username": "sandbox", "password": "not-in-arguments"}))
            operator.fill_agent_secret({"agentcore_access_secret_arn": "arn:secret"})
        args, kwargs = calls[0]
        self.assertNotIn("not-in-arguments", " ".join(args))
        self.assertEqual(json.loads(kwargs["data"]), {"username": "sandbox", "password": "not-in-arguments"})
        self.assertTrue(kwargs["capture"])

    def test_deploy_applies_exactly_the_saved_plan(self):
        operator = launcher.Operator(CONFIG)
        for name in ["preflight", "build", "init_terraform", "outputs", "publish", "install"]:
            setattr(operator, name, Mock())
        operator.tf = Mock()
        operator.deploy(yes=True)
        self.assertEqual(operator.tf.call_args_list[0].args, ("plan", "-input=false", "-out=sandbox.tfplan"))
        self.assertEqual(operator.tf.call_args_list[1].args, ("apply", "-input=false", "sandbox.tfplan"))
        operator.build.assert_called_once_with(None)

    def test_build_failure_stops_deploy_before_publishing(self):
        operator = launcher.Operator(CONFIG)
        for name in ["preflight", "init_terraform", "outputs", "publish", "install"]:
            setattr(operator, name, Mock())
        operator.tf = Mock()
        operator.build = Mock(side_effect=subprocess.CalledProcessError(1, "docker"))
        with self.assertRaises(subprocess.CalledProcessError):
            operator.deploy(yes=True)
        operator.tf.assert_any_call("apply", "-input=false", "sandbox.tfplan")
        operator.publish.assert_not_called()


GRAPH_CONFIG = {**CONFIG, "enable_knowledge_graph": True}
GRAPH_OUTPUTS = {"knowledge_graph_ingest_bucket": "kg-bucket", "knowledge_graph_ingest_function": "kg-ingest"}


class KnowledgeGraphTests(unittest.TestCase):
    def deploy_with_mocks(self, config):
        operator = launcher.Operator(config)
        order = Mock()
        for name in ["preflight", "build", "init_terraform", "publish", "install", "build_knowledge_graph", "load_graph"]:
            mock = Mock()
            setattr(operator, name, mock)
            order.attach_mock(mock, name)
        operator.tf = Mock()
        order.attach_mock(operator.tf, "tf")
        operator.outputs = Mock(return_value=GRAPH_OUTPUTS)
        return operator, order

    def tfvars_for(self, config):
        operator = launcher.Operator(config)
        operator.tf = Mock(return_value="default\n")
        with patch.object(launcher, "private_json") as written:
            operator.init_terraform()
        return written.call_args.args[1]

    def loader(self, invoke_result=None, response=None, fail_on=None):
        """An operator whose commands are recorded, with the invoke result and outfile faked."""
        operator = launcher.Operator(GRAPH_CONFIG)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        operator.directory = Path(directory.name)
        operator.identity = Mock()
        operator.outputs = Mock(return_value=GRAPH_OUTPUTS)
        calls = []

        def run(args, **kwargs):
            line = [str(arg) for arg in args]
            calls.append(line)
            if fail_on and any(fail_on in arg for arg in line):
                raise subprocess.CalledProcessError(1, line)
            if "invoke" in line:
                Path(line[-1]).write_text(json.dumps(response or {"nodes": 74, "relationships": 87}))
                return json.dumps(invoke_result or {"StatusCode": 200})
            return ""

        operator.run = run
        return operator, calls

    def test_knowledge_graph_flag_reaches_the_tfvars(self):
        self.assertIs(self.tfvars_for(GRAPH_CONFIG)["enable_knowledge_graph"], True)

    def test_config_without_the_flag_means_off(self):
        self.assertIs(self.tfvars_for(CONFIG)["enable_knowledge_graph"], False)
        operator, _ = self.deploy_with_mocks(CONFIG)
        operator.deploy(yes=True)
        operator.build_knowledge_graph.assert_not_called()
        operator.load_graph.assert_not_called()

    def test_deploy_builds_the_package_before_planning(self):
        operator, order = self.deploy_with_mocks(GRAPH_CONFIG)
        operator.deploy(yes=True)
        names = [call[0] for call in order.mock_calls]
        self.assertLess(names.index("build_knowledge_graph"), names.index("tf"))

    def test_deploy_loads_the_graph_after_install(self):
        operator, order = self.deploy_with_mocks(GRAPH_CONFIG)
        operator.deploy(yes=True)
        names = [call[0] for call in order.mock_calls]
        self.assertLess(names.index("install"), names.index("load_graph"))
        operator.load_graph.assert_called_once_with(GRAPH_OUTPUTS)

    def test_load_failure_tells_the_operator_how_to_rerun(self):
        for failure in (ValueError("no"), subprocess.CalledProcessError(1, "x")):
            with self.subTest(failure=failure):
                operator, _ = self.deploy_with_mocks(GRAPH_CONFIG)
                operator.load_graph.side_effect = failure
                with self.assertRaisesRegex(ValueError, "load-graph"):
                    operator.deploy(yes=True)

    def test_load_graph_steps_run_in_order(self):
        operator, calls = self.loader()
        operator.load_graph(GRAPH_OUTPUTS)
        steps = [" ".join(call) for call in calls]
        self.assertIn("fetch_monarch.py", steps[0])
        self.assertIn("fetch_dismech.py --revision b1ca0b232b815a21b4ba95a62828c9979e9a49e7", steps[1])
        for step, name in zip(steps[2:5], ("monarch_mm.json", "dismech_mm.yaml", "dismech_mm.yaml.provenance.json")):
            self.assertIn("s3 cp", step)
            self.assertIn(name + " s3://kg-bucket/raw/" + name, step)
        self.assertIn("lambda invoke --function-name kg-ingest", steps[5])
        self.assertEqual(len(steps), 6)

    def test_fetch_failure_uploads_nothing(self):
        operator, calls = self.loader(fail_on="fetch_dismech.py")
        with self.assertRaises(subprocess.CalledProcessError):
            operator.load_graph(GRAPH_OUTPUTS)
        self.assertFalse([call for call in calls if "s3" in call or "lambda" in call])

    def test_lambda_function_error_fails_the_load(self):
        operator, _ = self.loader(invoke_result={"StatusCode": 200, "FunctionError": "Unhandled"},
                                  response={"errorMessage": "denied"})
        with self.assertRaisesRegex(ValueError, "denied"):
            operator.load_graph(GRAPH_OUTPUTS)

    def test_load_graph_reports_counts_and_versions(self):
        response = {"nodes": 74, "relationships": 87, "monarch_version": "m", "dismech_version": "d"}
        operator, _ = self.loader(response=response)
        self.assertEqual(operator.load_graph(GRAPH_OUTPUTS), response)

    def test_load_graph_alone_checks_the_account_and_reads_outputs(self):
        operator, _ = self.loader()
        operator.load_graph()
        operator.identity.assert_called_once()
        operator.outputs.assert_called_once()

    def test_load_graph_needs_the_flag(self):
        operator = launcher.Operator(CONFIG)
        with self.assertRaisesRegex(ValueError, "enable_knowledge_graph"):
            operator.load_graph(GRAPH_OUTPUTS)

    def test_destroy_builds_the_missing_package_first(self):
        operator = launcher.Operator(GRAPH_CONFIG)
        order = Mock()
        for name in ["identity", "init_terraform", "build_knowledge_graph"]:
            mock = Mock()
            setattr(operator, name, mock)
            order.attach_mock(mock, name)
        operator.tf = Mock(side_effect=lambda *args, **kwargs: "{}" if args[0] == "show" else "")
        with patch.object(launcher, "KG_PACKAGE", Path("/nonexistent/lambda.zip")):
            operator.destroy(yes=True)
        names = [call[0] for call in order.mock_calls]
        self.assertLess(names.index("build_knowledge_graph"), names.index("init_terraform"))

    def test_destroy_keeps_an_existing_package(self):
        operator = launcher.Operator(GRAPH_CONFIG)
        for name in ["identity", "init_terraform", "build_knowledge_graph"]:
            setattr(operator, name, Mock())
        operator.tf = Mock(side_effect=lambda *args, **kwargs: "{}" if args[0] == "show" else "")
        with tempfile.NamedTemporaryFile() as package, patch.object(launcher, "KG_PACKAGE", Path(package.name)):
            operator.destroy(yes=True)
        operator.build_knowledge_graph.assert_not_called()
