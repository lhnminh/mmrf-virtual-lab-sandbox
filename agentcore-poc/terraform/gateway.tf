locals {
  tool_schema_key = "tools-${filemd5("${path.module}/../lambda/tools.json")}.json"
}

# The tool schema lives in S3 as AWS's full schema format, so tools can have nested inputs.
resource "aws_s3_object" "tool_schema" {
  bucket = aws_s3_bucket.agent_code.id
  # The hash in the key makes a changed schema update the target.
  key          = local.tool_schema_key
  source       = "${path.module}/../lambda/tools.json"
  source_hash  = filemd5("${path.module}/../lambda/tools.json")
  content_type = "application/json"
}

resource "aws_iam_role" "gateway" {
  name               = "${local.hyphen_name}-gateway"
  assume_role_policy = local.agentcore_trust
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
        Resource = aws_lambda_function.tools.arn
      },
      {
        Sid      = "ReadToolSchema"
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.agent_code.arn}/${local.tool_schema_key}"
      },
    ]
  })
}

resource "aws_bedrockagentcore_gateway" "tools" {
  name            = local.hyphen_name
  role_arn        = aws_iam_role.gateway.arn
  authorizer_type = "AWS_IAM"
  protocol_type   = "MCP"
}

resource "aws_bedrockagentcore_gateway_target" "virtual_lab" {
  # Tools appear to the agent as virtual-lab___<tool>.
  name               = "virtual-lab"
  gateway_identifier = aws_bedrockagentcore_gateway.tools.gateway_id

  credential_provider_configuration {
    gateway_iam_role {}
  }

  target_configuration {
    mcp {
      lambda {
        lambda_arn = aws_lambda_function.tools.arn
        tool_schema {
          s3 {
            uri                     = "s3://${aws_s3_bucket.agent_code.bucket}/${local.tool_schema_key}"
            bucket_owner_account_id = var.sandbox_account_id
          }
        }
      }
    }
  }

  depends_on = [aws_iam_role_policy.gateway]
}
