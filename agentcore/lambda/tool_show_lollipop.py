"""show_lollipop: reports where one gene's mutations fall. The browser draws the Lollipop plot."""
import logging
import re

from cohort_filter import label
from results import failure, ok, outcome
from virtual_lab_client import ClientError

logger = logging.getLogger(__name__)

GENE_SHAPED = re.compile(r"^[A-Za-z][A-Za-z0-9-]{1,14}$")
TOP_VARIANTS = 3


def show_lollipop(args, client):
    requested = args.get("gene")
    if not isinstance(requested, str) or not requested.strip():
        return failure("invalid_input", "gene must be the name of a gene, such as KRAS.")
    requested = requested.strip()
    cohort_filter = args.get("cohortFilter") or None
    try:
        gene_info = client.lookup_gene(requested)
        if gene_info is None:
            if not GENE_SHAPED.match(requested):
                return outcome("unknown_gene",
                               f"'{requested}' doesn't look like a gene symbol. Please check the name.")
            covered = [gene for gene, _ in client.top_genes(None)]
            return outcome("no_data_for_gene",
                           f"{requested} isn't in this dataset. Genes with mutation data here: "
                           f"{', '.join(covered)}.", coveredGenes=covered)
        name = gene_info["name"]
        case_count = client.case_count(cohort_filter)
        track = client.lollipop_track(gene_info, cohort_filter)
    except ClientError as error:
        logger.error("Virtual Lab call failed at %s", error.step)
        return failure(error.step, str(error))
    except (KeyError, TypeError):
        logger.error("Gene lookup had no name")
        return failure("unhealthy", "The gene lookup had no name.")
    cohort = {"label": label(cohort_filter), "caseCount": case_count}
    samples = track["sampleTotalNumber"]
    if samples == 0:
        return outcome("none_in_cohort",
                       f"0 of {case_count} cases in this cohort have a {name} mutation.",
                       gene=name, cohort=cohort)
    variants = track["skewer"]
    ranked = sorted(variants, key=lambda v: v.get("occurrence") or 0, reverse=True)[:TOP_VARIANTS]
    top = [{"change": v.get("mname"), "count": v.get("occurrence") or 0} for v in ranked]
    listing = ", ".join(f"{v['change']} ({v['count']} samples)" for v in top)
    return ok(f"{samples} samples in this cohort of {case_count} cases have a {name} mutation, "
              f"across {len(variants)} variants. Most frequent: {listing}.",
              gene=name, sampleCount=samples, variantCount=len(variants), topVariants=top,
              cohort=cohort, plot={"type": "lollipop", "gene": name})
