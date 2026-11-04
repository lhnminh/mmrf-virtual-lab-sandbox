"""Tool results: small dicts the agent reads. Only status "error" is a failed step."""


def outcome(status, summary, **fields):
    return {"status": status, "summary": summary, **fields}


def ok(summary, **fields):
    return outcome("ok", summary, **fields)


def failure(step, summary):
    return outcome("error", summary, step=step)
