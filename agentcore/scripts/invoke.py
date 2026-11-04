#!/usr/bin/env python3
"""Send one AG-UI run to the deployed agent and print each event with its arrival time.

Run from agentcore/agent: uv run python ../scripts/invoke.py "Is the Virtual Lab healthy?"
"""
import argparse
import hashlib
import json
import os
import subprocess
import time
import uuid
from pathlib import Path

TERRAFORM_DIR = Path(__file__).resolve().parents[2] / "terraform"
COHORT_KEYS = ("filter", "label", "caseCount", "revision", "changedOutsideChat")


def load_cohort(path: str) -> dict:
    """The cohort a browser would send as state.cohort. The filter key may be null, for all cases."""
    cohort = json.loads(Path(path).read_text())
    if not isinstance(cohort, dict) or "filter" not in cohort:
        raise ValueError("The cohort file needs a filter key.")
    return {key: cohort[key] for key in COHORT_KEYS if key in cohort}


def build_run_input(prompt: str, thread_id: str, history: list[dict], cohort: dict | None = None) -> dict:
    messages = [{"id": str(uuid.uuid4()), **turn} for turn in history]
    messages.append({"id": str(uuid.uuid4()), "role": "user", "content": prompt})
    return {
        "threadId": thread_id,
        "runId": str(uuid.uuid4()),
        "state": {"cohort": cohort} if cohort is not None else {},
        "messages": messages,
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


def parse_sse_line(line: str) -> dict | None:
    return json.loads(line[len("data: "):]) if line.startswith("data: ") else None


def session_id(thread_id: str) -> str:
    """Must match runtimeSessionId in the frontend's dev route."""
    return hashlib.sha256(thread_id.encode()).hexdigest()


def terraform_output(name: str) -> str:
    return subprocess.run(
        ["terraform", "output", "-raw", name],
        cwd=TERRAFORM_DIR, check=True, capture_output=True, text=True,
    ).stdout


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt")
    parser.add_argument("--thread", default=str(uuid.uuid4()))
    parser.add_argument("--save", help="write the raw SSE stream to this path")
    parser.add_argument("--cohort-file", help="JSON to send as state.cohort: filter, label, caseCount, "
                                              "revision, changedOutsideChat")
    args = parser.parse_args()
    cohort = load_cohort(args.cohort_file) if args.cohort_file else None

    import boto3  # Imported here so the helpers above need no AWS packages.

    arn = terraform_output("agent_runtime_arn")
    session = boto3.Session(profile_name=os.environ.get("AWS_PROFILE", "workshop"), region_name=arn.split(":")[3])
    started = time.monotonic()
    response = session.client("bedrock-agentcore").invoke_agent_runtime(
        agentRuntimeArn=arn,
        runtimeSessionId=session_id(args.thread),
        payload=json.dumps(build_run_input(args.prompt, args.thread, [], cohort)).encode(),
        contentType="application/json",
        accept="text/event-stream",
    )

    saved, answer = [], []
    # One byte at a time: larger reads wait to fill, which would hide when events really arrive.
    for raw in response["response"].iter_lines(chunk_size=1):
        line = raw.decode()
        saved.append(line)
        event = parse_sse_line(line)
        if event is None:
            continue
        print(f"+{int((time.monotonic() - started) * 1000)}ms {event.get('type')}", flush=True)
        if event.get("type") == "TEXT_MESSAGE_CONTENT":
            answer.append(event.get("delta", ""))
    print("\n" + "".join(answer))

    if args.save:
        Path(args.save).write_text("\n".join(saved) + "\n")


if __name__ == "__main__":
    main()
