"""show_survival: reports survival numbers for the cohort. The browser draws the real chart."""
import logging

from cohort_filter import label
from results import failure, ok, outcome
from virtual_lab_client import ClientError

logger = logging.getLogger(__name__)

# (dataset field, label, spellings). Other fields are left out on purpose; see the design doc.
COMPARISONS = (
    ("cgs_risk_category", "CGS risk", ("cgs risk", "cgs risk category", "cgs", "risk", "risk category")),
    ("kras_status", "KRAS status", ("kras status", "kras", "kras mutation status")),
    ("gender", "Sex", ("sex", "gender")),
    ("race", "Race", ("race",)),
)
AVAILABLE = [name for _, name, _ in COMPARISONS]
TOO_SMALL = "shows 0 on the chart, meaning too small to calculate exactly"
MEDIANS = "Medians are calculated from the curve."


def _comparison(asked):
    wanted = asked.strip().lower()
    for field, name, spellings in COMPARISONS:
        if wanted in spellings:
            return field, name
    return None


def _count(number, singular, plural):
    return f"{number} {singular if number == 1 else plural}"


def _groups(reply, unit):
    """Each group's numbers, in the order the service returned them."""
    keys = reply["keys"]
    series, time, survival = keys.index("seriesId"), keys.index("time"), keys.index("survival")
    events, censored, at_risk = keys.index("nevent"), keys.index("ncensor"), keys.index("nrisk")
    groups = {}
    for row in reply["case"]:
        group = groups.setdefault(row[series], {"name": row[series], "cases": int(row[at_risk]),
                                                "deaths": 0, "censored": 0, "median": None})
        group["deaths"] += int(row[events])
        group["censored"] += int(row[censored])
        if group["median"] is None and float(row[survival]) <= 0.5:
            group["median"] = f"{float(row[time]):.2f} {unit}"
    return list(groups.values())


def _outcomes(group):
    median = group["median"] or "not reached"
    return f"{_count(group['deaths'], 'death', 'deaths')}, {group['censored']} censored, median {median}"


def _is_zero(pvalue):
    try:
        return float(pvalue) == 0
    except (TypeError, ValueError):
        return False


def _p_values(reply):
    pairs = (reply.get("tests") or {}).get("") or []
    if not pairs:
        return "The service gave no log-rank P-value."
    if len(pairs) == 1:
        value = pairs[0]["pvalue"]
        return f"Log-rank P-value {TOO_SMALL}." if _is_zero(value) else f"Log-rank P-value: {value}."
    listed = [f"{pair['series1']} vs {pair['series2']} " + (TOO_SMALL if _is_zero(pair["pvalue"]) else str(pair["pvalue"]))
              for pair in pairs]
    return f"Log-rank P-values: {', '.join(listed)}."


def _summary(groups, comparison_name, reply):
    total = sum(group["cases"] for group in groups)
    head = f"{_count(total, 'case', 'cases')}, overall survival"
    if comparison_name is None:
        return f"{head}. {_outcomes(groups[0])}. {MEDIANS}", total
    if len(groups) == 1:
        group = groups[0]
        return (f"Comparing by {comparison_name} leaves one group in this cohort: {group['name']}. "
                f"{head}. {_outcomes(group)}. {MEDIANS}"), total
    parts = " ".join(f"{group['name']}: {_count(group['cases'], 'case', 'cases')}, {_outcomes(group)}." for group in groups)
    return f"{head}, compared by {comparison_name}. {parts} {_p_values(reply)} {MEDIANS}", total


def show_survival(args, client):
    asked = args.get("compareBy")
    if asked is not None and not isinstance(asked, str):
        return failure("invalid_input", "compareBy must be text, such as CGS risk.")
    comparison = None
    if asked and asked.strip():
        comparison = _comparison(asked)
        if comparison is None:
            return outcome("unsupported_comparison",
                           f"There's no survival comparison by '{asked.strip()}' yet. "
                           f"Available: {', '.join(AVAILABLE)}.", available=AVAILABLE)
    field, comparison_name = comparison or (None, None)
    cohort_filter = args.get("cohortFilter") or None

    try:
        term = client.survival_term()
        compare_term = None
        if field:
            compare_term = client.comparison_term(field)
            if compare_term is None:
                return failure("unhealthy", f"The dataset doesn't list {comparison_name}.")
        reply = client.survival(term, compare_term, cohort_filter)
        case_count = client.case_count(cohort_filter)
        groups = _groups(reply, term.get("unit") or "years")
        cohort = {"label": label(cohort_filter), "caseCount": case_count}
        if not groups:
            return outcome("no_cases", "This cohort has no cases, so there's no survival curve.", cohort=cohort)
        summary, total = _summary(groups, comparison_name, reply)
        plot = {"type": "survival", "term": term["id"]}
    except ClientError as error:
        logger.error("Virtual Lab call failed at %s", error.step)
        return failure(error.step, str(error))
    except (KeyError, TypeError, ValueError, IndexError, AttributeError):
        logger.error("The survival reply couldn't be read")
        return failure("unhealthy", "The survival reply couldn't be read.")

    if total != case_count:
        summary += f" The chart counts {total} cases, and the cohort has {case_count}."
    if comparison_name is None:
        return ok(summary, cohort=cohort, plot=plot)
    fields = {"cohort": cohort, "groups": [group["name"] for group in groups], "comparedBy": comparison_name,
              "plot": {**plot, "compareBy": field}}
    return outcome("one_group", summary, **fields) if len(groups) == 1 else ok(summary, **fields)
