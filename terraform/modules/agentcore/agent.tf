locals {
  hyphen_name        = replace(lower(var.name), "_", "-")
  log_retention_days = 7
  # An inference profile ID is a foundation model ID with a routing prefix.
  foundation_model_id = replace(var.model_id, "/^(us|eu|apac|global)\\./", "")
  # The trust the AWS Runtime docs give: this account, in this region.
  runtime_trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "bedrock-agentcore.amazonaws.com" }
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.sandbox_account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:bedrock-agentcore:${var.region}:${var.sandbox_account_id}:*" }
      }
    }]
  })
  # Narrower, because Gateway ARNs start with the gateway's name.
  gateway_trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "bedrock-agentcore.amazonaws.com" }
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.sandbox_account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:bedrock-agentcore:${var.region}:${var.sandbox_account_id}:gateway/${local.hyphen_name}-*" }
      }
    }]
  })
}

resource "aws_s3_bucket" "agent_code" {
  bucket        = "${local.hyphen_name}-code-${var.sandbox_account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "agent_code" {
  bucket                  = aws_s3_bucket.agent_code.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_object" "agent_code" {
  bucket = aws_s3_bucket.agent_code.id
  # The hash in the key makes a new zip update the Runtime.
  key         = "agent-${filemd5(var.agent_zip_path)}.zip"
  source      = var.agent_zip_path
  source_hash = filemd5(var.agent_zip_path)
}

resource "aws_iam_role" "runtime" {
  name               = "${local.hyphen_name}-runtime"
  assume_role_policy = local.runtime_trust
}

resource "aws_iam_role_policy" "runtime" {
  name = "runtime"
  role = aws_iam_role.runtime.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "InvokeModel"
        Effect = "Allow"
        Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = [
          "arn:aws:bedrock:${var.region}:${var.sandbox_account_id}:inference-profile/${var.model_id}",
          "arn:aws:bedrock:*::foundation-model/${local.foundation_model_id}",
        ]
      },
      {
        Sid      = "InvokeGateway"
        Effect   = "Allow"
        Action   = "bedrock-agentcore:InvokeGateway"
        Resource = aws_bedrockagentcore_gateway.tools.gateway_arn
      },
      {
        Sid      = "ReadCode"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource = "${aws_s3_bucket.agent_code.arn}/*"
      },
      {
        Sid    = "WriteLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
          "logs:PutLogEvents",
        ]
        Resource = "arn:aws:logs:${var.region}:${var.sandbox_account_id}:log-group:/aws/bedrock-agentcore/runtimes/*"
      },
    ]
  })
}

# Terraform owns this group so destroy removes it. The Runtime's role can't create groups,
# so nothing it writes can outlive the stack.
resource "aws_cloudwatch_log_group" "runtime" {
  name              = "/aws/bedrock-agentcore/runtimes/${aws_bedrockagentcore_agent_runtime.agent.agent_runtime_id}-DEFAULT"
  retention_in_days = local.log_retention_days
}

resource "aws_bedrockagentcore_agent_runtime" "agent" {
  agent_runtime_name = var.name
  role_arn           = aws_iam_role.runtime.arn

  agent_runtime_artifact {
    code_configuration {
      entry_point = ["main.py"]
      runtime     = "PYTHON_3_13"
      code {
        s3 {
          bucket = aws_s3_bucket.agent_code.id
          prefix = aws_s3_object.agent_code.key
        }
      }
    }
  }

  network_configuration {
    network_mode = "PUBLIC"
  }

  protocol_configuration {
    server_protocol = "AGUI"
  }

  environment_variables = merge(
    {
      AGENT_REGION            = var.region
      GATEWAY_URL             = aws_bedrockagentcore_gateway.tools.gateway_url
      MODEL_ID                = var.model_id
      GATEWAY_TIMEOUT_SECONDS = tostring(var.tool_timeout_seconds)
      MAX_OUTPUT_TOKENS       = tostring(var.max_output_tokens)
    },
    var.knowledge_gateway_url == null ? {} : { KG_GATEWAY_URL = var.knowledge_gateway_url },
  )

  # The role's permissions must exist before Runtime validates it.
  depends_on = [aws_iam_role_policy.runtime]
}
