locals {
  agentcore_tool_schemas = jsondecode(file("${path.module}/agentcore-tool-schemas.json"))
}

resource "aws_iam_role" "agentcore_tools_lambda" {
  count = var.enable_agentcore ? 1 : 0
  name  = "${var.name}-agentcore-tools"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "agentcore_tools_logs" {
  count      = var.enable_agentcore ? 1 : 0
  role       = aws_iam_role.agentcore_tools_lambda[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "agentcore_tools" {
  count         = var.enable_agentcore ? 1 : 0
  function_name = "${var.name}-agentcore-tools"
  filename      = "${path.module}/../generated/aws/agentcore-tools.zip"
  handler       = "lambda/handler.handler"
  runtime       = "nodejs22.x"
  role          = aws_iam_role.agentcore_tools_lambda[0].arn
  timeout       = 180
  memory_size   = 1024
  environment {
    variables = { VIRTUAL_LAB_ORIGIN = "https://example.invalid" }
  }
  depends_on = [aws_iam_role_policy_attachment.agentcore_tools_logs]
  lifecycle {
    ignore_changes = [environment, filename]
  }
}

resource "aws_iam_role" "agentcore_gateway" {
  count = var.enable_agentcore ? 1 : 0
  name  = "${var.name}-agentcore-gateway"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "bedrock-agentcore.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.sandbox_account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:bedrock-agentcore:${var.region}:${var.sandbox_account_id}:gateway/*" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "agentcore_gateway_lambda" {
  count = var.enable_agentcore ? 1 : 0
  role  = aws_iam_role.agentcore_gateway[0].id
  name  = "invoke-tools"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.agentcore_tools[0].arn
    }]
  })
}

resource "aws_bedrockagentcore_gateway" "virtual_lab" {
  count           = var.enable_agentcore ? 1 : 0
  name            = "${var.name}-virtual-lab"
  role_arn        = aws_iam_role.agentcore_gateway[0].arn
  authorizer_type = "AWS_IAM"
  protocol_type   = "MCP"
}

resource "aws_bedrockagentcore_gateway_target" "virtual_lab" {
  count              = var.enable_agentcore ? 1 : 0
  name               = "virtual-lab"
  gateway_identifier = aws_bedrockagentcore_gateway.virtual_lab[0].gateway_id
  credential_provider_configuration {
    gateway_iam_role {}
  }
  target_configuration {
    mcp {
      lambda {
        lambda_arn = aws_lambda_function.agentcore_tools[0].arn
        tool_schema {
          dynamic "inline_payload" {
            for_each = local.agentcore_tool_schemas
            content {
              name        = inline_payload.value.name
              description = inline_payload.value.description
              input_schema {
                type = "object"
                dynamic "property" {
                  for_each = inline_payload.value.inputSchema.properties
                  content {
                    name        = property.key
                    type        = property.value.type
                    description = try(property.value.description, null)
                    required    = contains(inline_payload.value.inputSchema.required, property.key)
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  depends_on = [aws_iam_role_policy.agentcore_gateway_lambda]
}

output "agentcore_gateway_url" {
  value = var.enable_agentcore ? aws_bedrockagentcore_gateway.virtual_lab[0].gateway_url : null
}
output "agentcore_gateway_arn" {
  value = var.enable_agentcore ? aws_bedrockagentcore_gateway.virtual_lab[0].gateway_arn : null
}
output "agentcore_tools_lambda_name" {
  value = var.enable_agentcore ? aws_lambda_function.agentcore_tools[0].function_name : null
}
