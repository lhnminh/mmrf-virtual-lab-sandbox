"""Health tool tests, with fake HTTP and Secrets Manager clients."""
import json
import logging
import pathlib
import socket
import sys
import unittest
import urllib.error
from types import SimpleNamespace

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lambda"))
import handler as tool  # noqa: E402

PASSWORD = "s3cret-password-value-1234567890"
LOGIN = {"username": "team", "password": PASSWORD}
HEALTHY = json.dumps({"status": "OK", "synthetic": True, "cases": 1000})


def http_error(code):
    return urllib.error.HTTPError("https://x", code, f"Authorization: Basic {PASSWORD}", {}, None)


def returning(body):
    return lambda login: body


def raising(error):
    def fail(*_args, **_kwargs):
        raise error
    return fail


def check(fetch_status=returning(HEALTHY), read_login=lambda: LOGIN):
    return tool.check_virtual_lab_health({}, fetch_status=fetch_status, read_login=read_login)


def context_for(name):
    return SimpleNamespace(client_context=SimpleNamespace(custom={"bedrockAgentCoreToolName": name}))


class Routing(unittest.TestCase):
    def test_routes_after_removing_prefix(self):
        seen = []
        original = tool.TOOLS["check_virtual_lab_health"]
        tool.TOOLS["check_virtual_lab_health"] = lambda args: seen.append(args) or {"ok": True}
        self.addCleanup(tool.TOOLS.__setitem__, "check_virtual_lab_health", original)
        result = tool.handler({"a": 1}, context_for("virtual-lab___check_virtual_lab_health"))
        self.assertEqual(result, {"ok": True})
        self.assertEqual(seen, [{"a": 1}])

    def test_unknown_tool(self):
        result = tool.handler({}, context_for("virtual-lab___nope"))
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "unknown_tool")


class Health(unittest.TestCase):
    def test_healthy(self):
        result = check()
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "OK")
        self.assertIs(result["synthetic"], True)
        self.assertEqual(result["cases"], 1000)
        self.assertIsInstance(result["latency_ms"], int)
        self.assertEqual(result["summary"], "Virtual Lab is healthy: 1000 synthetic cases.")

    def test_401_is_auth_failed(self):
        self.assertEqual(check(fetch_status=raising(http_error(401)))["error"], "auth_failed")

    def test_5xx_timeout_and_connection_are_unreachable(self):
        for error in (http_error(503), http_error(404), socket.timeout("slow"),
                      TimeoutError("slow"), urllib.error.URLError("refused")):
            with self.subTest(error=type(error).__name__):
                self.assertEqual(check(fetch_status=raising(error))["error"], "unreachable")

    def test_bad_body_is_unhealthy(self):
        bodies = ["not json", "[]", "null",
                  json.dumps({"status": "DOWN", "synthetic": True, "cases": 1000}),
                  json.dumps({"status": "OK", "synthetic": False, "cases": 1000}),
                  json.dumps({"status": "OK", "synthetic": True, "cases": "1000"}),
                  json.dumps({"status": "OK", "synthetic": True, "cases": True}),
                  json.dumps({"status": "OK", "synthetic": True})]
        for body in bodies:
            with self.subTest(body=body):
                self.assertEqual(check(fetch_status=returning(body))["error"], "unhealthy")

    def test_unfilled_secret_is_config_error(self):
        result = check(read_login=raising(tool.ConfigError("no value")))
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "config_error")

    def test_invalid_secret_is_config_error(self):
        for value in ("not json", json.dumps({"username": "team"}), json.dumps(["x"])):
            with self.subTest(value=value):
                result = check(read_login=lambda value=value: tool.parse_login(value))
                self.assertEqual(result["error"], "config_error")

    def test_password_never_appears(self):
        with self.assertLogs(level=logging.DEBUG) as logs:
            logging.getLogger().debug("capture starts")
            results = [check(),
                       check(fetch_status=raising(http_error(401))),
                       check(fetch_status=raising(http_error(500))),
                       check(fetch_status=returning(f'{{"status":"{PASSWORD}"}}')),
                       check(read_login=lambda: tool.parse_login(json.dumps({"password": PASSWORD})))]
        everything = json.dumps(results) + "\n".join(logs.output)
        self.assertNotIn(PASSWORD, everything)


class ReadLogin(unittest.TestCase):
    def setUp(self):
        tool._login_cache = None
        self.addCleanup(setattr, tool, "_login_cache", None)

    def test_no_value_from_secrets_manager_is_config_error(self):
        class NoValue(Exception):
            pass

        client = SimpleNamespace(get_secret_value=raising(NoValue("no secret value")))
        with self.assertRaises(tool.ConfigError):
            tool.read_login(client=client, secret_arn="arn:x")

    def test_login_is_cached_per_instance(self):
        calls = []
        client = SimpleNamespace(
            get_secret_value=lambda **kw: calls.append(kw) or {"SecretString": json.dumps(LOGIN)})
        self.assertEqual(tool.read_login(client=client, secret_arn="arn:x"), LOGIN)
        self.assertEqual(tool.read_login(client=client, secret_arn="arn:x"), LOGIN)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
