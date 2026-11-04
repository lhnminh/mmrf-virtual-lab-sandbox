mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:us-west-2:123456789012:function:mock" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-west-2:123456789012:log-group:mock" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::mock", bucket = "mock" }
  }
}

override_data {
  target = data.aws_availability_zones.available
  values = { names = ["us-west-2a", "us-west-2b"] }
}

variables {
  sandbox_account_id = "123456789012"
  region             = "us-west-2"
  name               = "mmrf-synthetic-kg"
  lambda_zip_path    = "../agentcore/tests/fixtures/agent.zip"
  source_dir         = "../../../knowledge-graph"
}

run "network_has_no_internet_path" {
  command = plan

  assert {
    condition     = aws_vpc.kg.cidr_block == "10.90.0.0/16"
    error_message = "The graph VPC must be 10.90.0.0/16."
  }
  assert {
    condition     = length(aws_subnet.private) == 2
    error_message = "Neptune needs subnets in two Availability Zones."
  }
  assert {
    condition     = aws_vpc_endpoint.s3.vpc_endpoint_type == "Gateway"
    error_message = "S3 must be reached through the free gateway endpoint."
  }
}

run "neptune_matches_the_spec" {
  command = plan

  assert {
    condition     = aws_neptune_cluster.graph.engine_version == "1.4.5.0"
    error_message = "Use engine 1.4.5.0."
  }
  assert {
    condition     = aws_neptune_cluster.graph.storage_encrypted
    error_message = "Storage must be encrypted."
  }
  assert {
    condition     = aws_neptune_cluster.graph.iam_database_authentication_enabled
    error_message = "IAM login makes Neptune enforce the read-only role."
  }
  assert {
    condition = (
      one(aws_neptune_cluster.graph.serverless_v2_scaling_configuration).min_capacity == 1 &&
      one(aws_neptune_cluster.graph.serverless_v2_scaling_configuration).max_capacity == 8
    )
    error_message = "Capacity must be 1 to 8 units."
  }
  assert {
    condition     = aws_neptune_cluster_instance.graph.instance_class == "db.serverless"
    error_message = "The instance must be serverless."
  }
}

run "graph_role_is_read_only" {
  command = apply

  assert {
    condition     = jsondecode(aws_iam_role_policy.graph_neptune.policy).Statement[0].Action == "neptune-db:ReadDataViaQuery"
    error_message = "kg-graph may only read."
  }
}

run "ingest_role_reads_s3_and_writes_neptune" {
  command = apply

  assert {
    condition     = contains(jsondecode(aws_iam_role_policy.ingest.policy).Statement[1].Action, "neptune-db:WriteDataViaQuery")
    error_message = "kg-ingest must be able to write."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.ingest.policy).Statement[0].Action == "s3:GetObject"
    error_message = "kg-ingest must be able to read the raw files."
  }
  assert {
    condition     = endswith(jsondecode(aws_iam_role_policy.ingest.policy).Statement[0].Resource, "/raw/*")
    error_message = "kg-ingest reads only the raw/ prefix."
  }
}

run "gateway_uses_iam_and_target_is_kg_graph" {
  command = plan

  assert {
    condition     = aws_bedrockagentcore_gateway.graph.authorizer_type == "AWS_IAM"
    error_message = "Gateway must use IAM."
  }
  assert {
    condition     = aws_bedrockagentcore_gateway.graph.protocol_type == "MCP"
    error_message = "Gateway must speak MCP."
  }
  assert {
    condition     = aws_bedrockagentcore_gateway_target.kg_graph.name == "kg-graph"
    error_message = "Tools must appear as kg-graph___<tool>."
  }
}

run "bucket_is_private" {
  command = plan

  assert {
    condition = (
      aws_s3_bucket_public_access_block.ingest.block_public_acls &&
      aws_s3_bucket_public_access_block.ingest.block_public_policy &&
      aws_s3_bucket_public_access_block.ingest.ignore_public_acls &&
      aws_s3_bucket_public_access_block.ingest.restrict_public_buckets
    )
    error_message = "The ingest bucket must block all public access."
  }
}

run "name_must_fit_the_gateway_trust" {
  command = plan

  variables {
    name = "Bad_Name"
  }

  expect_failures = [var.name]
}
