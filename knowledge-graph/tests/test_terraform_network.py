"""The graph's VPC must have no way out. A plan can't show this, because it would mean an absent resource."""

from pathlib import Path

MODULE = Path(__file__).resolve().parents[2] / "terraform/modules/knowledge-graph"
FORBIDDEN = ("aws_internet_gateway", "aws_egress_only_internet_gateway", "aws_nat_gateway", "aws_route\"",
             "aws_vpc_peering_connection", "publicly_accessible")


def test_module_creates_no_path_to_the_internet():
    source = "\n".join(path.read_text() for path in MODULE.glob("*.tf"))
    assert [word for word in FORBIDDEN if word in source] == []
