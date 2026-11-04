"""Virtual Lab tools behind AgentCore Gateway. Tools report results and don't interpret them."""
import base64
import json
import logging
import os
import time
import urllib.error
import urllib.request

from results import failure, ok
from tool_show_gene_clustering import show_gene_clustering
from tool_show_lollipop import show_lollipop
from tool_show_oncomatrix import show_oncomatrix
from tool_show_survival import show_survival
from tool_update_cohort import update_cohort
from virtual_lab_client import VirtualLabClient

logger = logging.getLogger(__name__)

HTTP_TIMEOUT_SECONDS = 20
_login_cache = None


class ConfigError(Exception):
    """The Lambda's secret or environment can't be used. Holds no secret values."""


def parse_login(secret_string):
    try:
        login = json.loads(secret_string)
    except (TypeError, ValueError):
        raise ConfigError("The access secret isn't valid JSON.") from None
    if not (isinstance(login, dict) and login.get("username") and login.get("password")):
        raise ConfigError("The access secret needs a username and a password.")
    return {"username": login["username"], "password": login["password"]}


def read_login(client=None, secret_arn=None):
    """Read the team login once per Lambda instance. Rotating it needs a new instance."""
    global _login_cache
    if _login_cache is None:
        try:
            if client is None:
                import boto3
                client = boto3.client("secretsmanager")
            value = client.get_secret_value(SecretId=secret_arn or os.environ["ACCESS_SECRET_ARN"])
        except Exception:  # A secret Terraform created but nobody filled lands here.
            raise ConfigError("The access secret couldn't be read. Has it been filled?") from None
        _login_cache = parse_login(value.get("SecretString"))
    return _login_cache


def fetch_status(login):
    token = base64.b64encode(f"{login['username']}:{login['password']}".encode()).decode()
    request = urllib.request.Request(
        f"{os.environ['SANDBOX_ORIGIN']}/sandbox/status",
        headers={"Authorization": f"Basic {token}"},
    )
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
        return response.read().decode()


def _is_healthy(body):
    return (
        isinstance(body, dict)
        and body.get("status") == "OK"
        and body.get("synthetic") is True
        and type(body.get("cases")) is int
    )


def check_virtual_lab_health(args, *, fetch_status=fetch_status, read_login=read_login):
    """Call /sandbox/status, not /_status: the access pod answers that without a login,
    so it wouldn't prove the route to identity or the login later tools need."""
    try:
        login = read_login()
    except ConfigError as error:
        logger.error("Config error: %s", error)
        return failure("config_error", "The Virtual Lab login isn't configured.")

    started = time.monotonic()
    try:
        raw = fetch_status(login)
    except urllib.error.HTTPError as error:
        logger.error("Virtual Lab returned HTTP %s", error.code)
        if error.code == 401:
            return failure("auth_failed", "The Virtual Lab refused the login.")
        return failure("unreachable", f"The Virtual Lab returned HTTP {error.code}.")
    except OSError as error:  # URLError, socket errors and timeouts are all OSErrors.
        logger.error("Virtual Lab unreachable: %s", type(error).__name__)
        return failure("unreachable", "The Virtual Lab couldn't be reached.")
    latency_ms = int((time.monotonic() - started) * 1000)

    try:
        body = json.loads(raw)
    except ValueError:
        body = None
    if not _is_healthy(body):
        return failure("unhealthy", "The Virtual Lab status response wasn't healthy.")
    return ok(f"Virtual Lab is healthy: {body['cases']} synthetic cases.",
              cases=body["cases"], latency_ms=latency_ms)


TOOLS = {"check_virtual_lab_health": check_virtual_lab_health}
CLIENT_TOOLS = {"update_cohort": update_cohort, "show_oncomatrix": show_oncomatrix,
                "show_lollipop": show_lollipop, "show_survival": show_survival,
                "show_gene_clustering": show_gene_clustering}  # These take (args, client).


def handler(event, context):
    full_name = context.client_context.custom["bedrockAgentCoreToolName"]
    name = full_name.split("___", 1)[-1]
    client_tool = CLIENT_TOOLS.get(name)
    if client_tool is not None:
        try:
            client = VirtualLabClient(os.environ["SANDBOX_ORIGIN"], read_login())
        except (ConfigError, KeyError):
            return failure("config_error", "The Virtual Lab login isn't configured.")
        return client_tool(event, client)
    tool = TOOLS.get(name)
    if tool is None:
        return failure("unknown_tool", f"There is no tool named {name}.")
    return tool(event)
