#!/usr/bin/env python3
"""Copy the launcher's Virtual Lab login into the tool's secret. Prints neither value.

Run from agentcore-poc/agent: uv run python ../scripts/set_access_secret.py --access-file PATH
"""
import argparse
import json
import os
import subprocess
from pathlib import Path

TERRAFORM_DIR = Path(__file__).resolve().parents[1] / "terraform"


def load_login(path: str) -> dict:
    """Errors name the problem only, so they can't echo the file's contents."""
    try:
        login = json.loads(Path(path).read_text())
    except ValueError:
        raise ValueError("The access file isn't valid JSON.") from None
    if not (isinstance(login, dict) and login.get("username") and login.get("password")):
        raise ValueError("The access file needs a username and a password.")
    return {"username": login["username"], "password": login["password"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--access-file", required=True)
    args = parser.parse_args()

    login = load_login(args.access_file)
    secret_arn = subprocess.run(
        ["terraform", "output", "-raw", "access_secret_arn"],
        cwd=TERRAFORM_DIR, check=True, capture_output=True, text=True,
    ).stdout

    import boto3

    session = boto3.Session(profile_name=os.environ.get("AWS_PROFILE", "workshop"), region_name=secret_arn.split(":")[3])
    session.client("secretsmanager").put_secret_value(SecretId=secret_arn, SecretString=json.dumps(login))
    print("Secret updated.")


if __name__ == "__main__":
    main()
