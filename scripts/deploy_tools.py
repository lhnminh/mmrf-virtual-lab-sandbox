"""Package and update the AgentCore tool Lambda after Terraform creates it."""
import json
from pathlib import Path
import sys
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
ZIP_PATH = ROOT / "generated/aws/agentcore-tools.zip"


def prepare():
    ZIP_PATH.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(ZIP_PATH, "w", ZIP_DEFLATED) as archive:
        for directory in ("lambda", "src"):
            for path in sorted((ROOT / "agent" / directory).rglob("*.mjs")):
                archive.write(path, path.relative_to(ROOT / "agent"))
    return ZIP_PATH


def deploy(operator, outputs):
    name = outputs.get("agentcore_tools_lambda_name")
    if not name:
        return
    origin = outputs.get("https_url")
    if not origin:
        raise ValueError("AgentCore tools require the sandbox HTTPS URL")
    access = json.loads((ROOT / "generated/aws/access.json").read_text())
    archive = prepare()
    base = ["aws", "lambda"]
    common = ["--profile", operator.config["profile"], "--region", operator.config["region"]]
    operator.run(base + ["update-function-code", "--function-name", name,
                         "--zip-file", "fileb://" + str(archive)] + common, quiet=True, capture=True)
    operator.run(base + ["wait", "function-updated", "--function-name", name] + common, quiet=True)
    configuration = {
        "FunctionName": name,
        "Environment": {"Variables": {
            "VIRTUAL_LAB_ORIGIN": origin,
            "SANDBOX_ACCESS_USERNAME": access["username"],
            "SANDBOX_ACCESS_PASSWORD": access["password"],
        }},
    }
    operator.run(base + ["update-function-configuration", "--cli-input-json", "file:///dev/stdin"] + common,
                 data=json.dumps(configuration), quiet=True, capture=True)
    operator.run(base + ["wait", "function-updated", "--function-name", name] + common, quiet=True)
    print("AgentCore tool Lambda code and sandbox settings updated")


if __name__ == "__main__":
    if sys.argv[1:] != ["prepare"]:
        raise SystemExit("usage: python3 scripts/deploy_tools.py prepare")
    print(prepare())
