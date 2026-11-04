locals {
  neptune_port       = 8182
  neptune_uri        = "bolt://${aws_neptune_cluster.graph.endpoint}:${local.neptune_port}"
  neptune_data_arn   = "arn:aws:neptune-db:${var.region}:${var.sandbox_account_id}:${aws_neptune_cluster.graph.cluster_resource_id}/*"
  log_retention_days = 7
  lambda_trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

# kg-graph: serves the tools. Read only, enforced by Neptune because the cluster requires IAM login.
resource "aws_security_group" "graph" {
  name        = "${var.name}-graph"
  description = "kg-graph Lambda: outbound to Neptune only"
  vpc_id      = aws_vpc.kg.id
}

resource "aws_vpc_security_group_egress_rule" "graph_to_neptune" {
  security_group_id            = aws_security_group.graph.id
  referenced_security_group_id = aws_security_group.neptune.id
  ip_protocol                  = "tcp"
  from_port                    = local.neptune_port
  to_port                      = local.neptune_port
}

resource "aws_iam_role" "graph" {
  name               = "${var.name}-graph"
  assume_role_policy = local.lambda_trust
}

resource "aws_iam_role_policy_attachment" "graph_vpc" {
  role       = aws_iam_role.graph.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "graph_neptune" {
  name = "neptune-read"
  role = aws_iam_role.graph.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "neptune-db:ReadDataViaQuery"
      Resource = local.neptune_data_arn
    }]
  })
}

resource "aws_cloudwatch_log_group" "graph" {
  name              = "/aws/lambda/${var.name}-graph"
  retention_in_days = local.log_retention_days
}

resource "aws_lambda_function" "graph" {
  function_name    = "${var.name}-graph"
  role             = aws_iam_role.graph.arn
  handler          = "handler.handler"
  runtime          = "python3.12"
  architectures    = ["x86_64"]
  timeout          = 60
  memory_size      = 256
  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.graph.id]
  }

  environment {
    variables = {
      NEPTUNE_URI      = local.neptune_uri
      NEPTUNE_IAM_AUTH = "true"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.graph,
    aws_iam_role_policy.graph_neptune,
    aws_iam_role_policy_attachment.graph_vpc,
    aws_neptune_cluster_instance.graph,
  ]
}

# kg-ingest: the only role that can write to the graph or read the raw files.
resource "aws_security_group" "ingest" {
  name        = "${var.name}-ingest"
  description = "kg-ingest Lambda: outbound to Neptune and S3 only"
  vpc_id      = aws_vpc.kg.id
}

resource "aws_vpc_security_group_egress_rule" "ingest_to_neptune" {
  security_group_id            = aws_security_group.ingest.id
  referenced_security_group_id = aws_security_group.neptune.id
  ip_protocol                  = "tcp"
  from_port                    = local.neptune_port
  to_port                      = local.neptune_port
}

resource "aws_vpc_security_group_egress_rule" "ingest_to_s3" {
  security_group_id = aws_security_group.ingest.id
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_iam_role" "ingest" {
  name               = "${var.name}-ingest"
  assume_role_policy = local.lambda_trust
}

resource "aws_iam_role_policy_attachment" "ingest_vpc" {
  role       = aws_iam_role.ingest.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "ingest" {
  name = "ingest"
  role = aws_iam_role.ingest.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.ingest.arn}/raw/*"
      },
      {
        # MERGE needs read and write. SET always needs delete too, because it may replace a value.
        Effect   = "Allow"
        Action   = ["neptune-db:ReadDataViaQuery", "neptune-db:WriteDataViaQuery", "neptune-db:DeleteDataViaQuery"]
        Resource = local.neptune_data_arn
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "ingest" {
  name              = "/aws/lambda/${var.name}-ingest"
  retention_in_days = local.log_retention_days
}

resource "aws_lambda_function" "ingest" {
  function_name    = "${var.name}-ingest"
  role             = aws_iam_role.ingest.arn
  handler          = "load_neo4j.lambda_handler"
  runtime          = "python3.12"
  architectures    = ["x86_64"]
  timeout          = 300
  memory_size      = 256
  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.ingest.id]
  }

  environment {
    variables = {
      INGEST_BUCKET    = aws_s3_bucket.ingest.id
      NEPTUNE_URI      = local.neptune_uri
      NEPTUNE_IAM_AUTH = "true"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.ingest,
    aws_iam_role_policy.ingest,
    aws_iam_role_policy_attachment.ingest_vpc,
    aws_neptune_cluster_instance.graph,
    aws_vpc_security_group_egress_rule.ingest_to_s3,
  ]
}
