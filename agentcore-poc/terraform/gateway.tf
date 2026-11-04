locals {
  tools = jsondecode(file("${path.module}/../lambda/tools.json"))
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
    Statement = [{
      Sid      = "InvokeTools"
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.tools.arn
    }]
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
          dynamic "inline_payload" {
            for_each = local.tools
            content {
              name        = inline_payload.value.name
              description = inline_payload.value.description
              input_schema {
                type = "object"
                # Flat inputs only. Nested input needs these blocks extended.
                dynamic "property" {
                  for_each = inline_payload.value.properties
                  content {
                    name        = property.value.name
                    type        = property.value.type
                    description = property.value.description
                    required    = property.value.required
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  depends_on = [aws_iam_role_policy.gateway]
}
