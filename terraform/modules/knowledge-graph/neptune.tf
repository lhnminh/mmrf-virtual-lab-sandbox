resource "aws_neptune_subnet_group" "graph" {
  name       = "${var.name}-subnets"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_security_group" "neptune" {
  name        = "${var.name}-neptune"
  description = "Neptune: Bolt from the graph Lambdas only"
  vpc_id      = aws_vpc.kg.id
}

resource "aws_vpc_security_group_ingress_rule" "neptune_from_graph" {
  security_group_id            = aws_security_group.neptune.id
  referenced_security_group_id = aws_security_group.graph.id
  description                  = "kg-graph Lambda"
  ip_protocol                  = "tcp"
  from_port                    = local.neptune_port
  to_port                      = local.neptune_port
}

resource "aws_vpc_security_group_ingress_rule" "neptune_from_ingest" {
  security_group_id            = aws_security_group.neptune.id
  referenced_security_group_id = aws_security_group.ingest.id
  description                  = "kg-ingest Lambda"
  ip_protocol                  = "tcp"
  from_port                    = local.neptune_port
  to_port                      = local.neptune_port
}

# The graph can be rebuilt with load-graph, so destroying it keeps no snapshot.
resource "aws_neptune_cluster" "graph" {
  cluster_identifier                  = "${var.name}-cluster"
  engine                              = "neptune"
  engine_version                      = "1.4.5.0"
  neptune_subnet_group_name           = aws_neptune_subnet_group.graph.name
  vpc_security_group_ids              = [aws_security_group.neptune.id]
  storage_encrypted                   = true
  iam_database_authentication_enabled = true
  skip_final_snapshot                 = true
  deletion_protection                 = false
  apply_immediately                   = true

  serverless_v2_scaling_configuration {
    min_capacity = 1
    max_capacity = 8
  }
}

resource "aws_neptune_cluster_instance" "graph" {
  cluster_identifier = aws_neptune_cluster.graph.id
  instance_class     = "db.serverless"
  engine             = "neptune"
  apply_immediately  = true
}
