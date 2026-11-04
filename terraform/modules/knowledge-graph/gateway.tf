locals {
  tools_file      = "${var.source_dir}/tools.json"
  tool_schema_key = "schemas/tools-${filemd5(local.tools_file)}.json"
}

resource "aws_s3_object" "tool_schema" {
  bucket = aws_s3_bucket.ingest.id
  # The hash in the key makes a changed schema update the target.
  key          = local.tool_schema_key
  source       = local.tools_file
  source_hash  = filemd5(local.tools_file)
  content_type = "application/json"
}

resource "aws_iam_role" "gateway" {
  name = "${var.name}-gateway"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "bedrock-agentcore.amazonaws.com" }
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.sandbox_account_id }
        # Gateway ARNs start with the gateway's name.
        ArnLike = { "aws:SourceArn" = "arn:aws:bedrock-agentcore:${var.region}:${var.sandbox_account_id}:gateway/${var.name}-*" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "gateway" {
  name = "gateway"
  role = aws_iam_role.gateway.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "InvokeTools"
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = aws_lambda_function.graph.arn
      },
      {
        Sid      = "ReadToolSchema"
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.ingest.arn}/${local.tool_schema_key}"
      },
    ]
  })
}

resource "aws_bedrockagentcore_gateway" "graph" {
  name            = var.name
  role_arn        = aws_iam_role.gateway.arn
  authorizer_type = "AWS_IAM"
  protocol_type   = "MCP"
}

resource "aws_bedrockagentcore_gateway_target" "kg_graph" {
  # Tools appear to the agent as kg-graph___<tool>.
  name               = "kg-graph"
  gateway_identifier = aws_bedrockagentcore_gateway.graph.gateway_id

  credential_provider_configuration {
    gateway_iam_role {}
  }

  target_configuration {
    mcp {
      lambda {
        lambda_arn = aws_lambda_function.graph.arn
        tool_schema {
          s3 {
            uri                     = "s3://${aws_s3_bucket.ingest.bucket}/${local.tool_schema_key}"
            bucket_owner_account_id = var.sandbox_account_id
          }
        }
      }
    }
  }

  depends_on = [aws_iam_role_policy.gateway, aws_s3_object.tool_schema]
}
