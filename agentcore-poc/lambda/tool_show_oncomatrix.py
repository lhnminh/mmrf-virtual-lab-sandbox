"""show_oncomatrix: ranks the most frequently mutated genes. The browser draws the chart."""
import logging

from cohort_filter import label
from results import failure, ok, outcome
from virtual_lab_client import ClientError

logger = logging.getLogger(__name__)

DEFAULT_GENES = 50


def _read_max_genes(args):
    """Returns (value or None, error result or None)."""
    if "maxGenes" not in args:
        return None, None
    value = args["maxGenes"]
    if type(value) is not int or value < 1:
        return None, failure("invalid_input", "maxGenes must be a whole number of 1 or more.")
    return value, None


def show_oncomatrix(args, client):
    max_genes, problem = _read_max_genes(args)
    if problem:
        return problem
    cohort_filter = args.get("cohortFilter") or None
    try:
        case_count = client.case_count(cohort_filter)
        ranking = client.top_genes(cohort_filter, max(DEFAULT_GENES, max_genes or 0))
        samples = set()
        for gene, _ in ranking:
            gene_info = client.lookup_gene(gene)
            if gene_info is None:
                raise ClientError("unhealthy", f"The gene lookup had no match for {gene}.")
            samples |= client.sample_ids(gene_info, cohort_filter)
    except ClientError as error:
        logger.error("Virtual Lab call failed at %s", error.step)
        return failure(error.step, str(error))
    cohort = {"label": label(cohort_filter), "caseCount": case_count}
    if not ranking:
        return outcome("no_data", f"None of the {case_count} cases in this cohort has mutation data.",
                       caseCount=case_count, cohort=cohort)
    shown = ranking[:max_genes] if max_genes else ranking
    genes = [{"gene": gene, "count": count} for gene, count in shown]
    plot = {"type": "oncomatrix"}
    if max_genes:
        plot["maxGenes"] = max_genes
    listing = ", ".join(f"{g['gene']} ({g['count']} samples)" for g in genes)
    return ok(f"{case_count} cases, {len(samples)} samples with mutation data. "
              f"{listing} are the most frequently mutated.",
              genes=genes, caseCount=case_count, sampleCount=len(samples), cohort=cohort, plot=plot)
