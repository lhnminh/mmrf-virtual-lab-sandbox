# infra-1: what the agent on AgentCore Runtime needs from Terraform.
#
# The Runtime itself is created by scripts/deploy_runtime.py, not here. The
# provider can't set requireMMDSV2, which invocations need, and Terraform state
# must not hold the team password. See docs/plans/infra-1-agentcore-runtime.md.

locals {
  # Runtime names allow letters, digits and underscores only.
  agent_runtime_name = replace("${var.name}_agent", "-", "_")
}

# ARM64 agent image. The other repositories hold amd64 EKS images.
resource "aws_ecr_repository" "agent_runtime" {
  count                = var.enable_agentcore ? 1 : 0
  name                 = "${var.name}/agent-runtime"
  image_tag_mutability = "IMMUTABLE"
  # aws_sandbox.py destroy empties only the service repositories.
  force_delete = true
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_iam_role" "agent_runtime" {
  count = var.enable_agentcore ? 1 : 0
  name  = "${var.name}-agent-runtime"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "bedrock-agentcore.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.sandbox_account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:bedrock-agentcore:${var.region}:${var.sandbox_account_id}:*" }
      }
    }]
  })
}

# Follows the AgentCore Runtime execution role in the AWS docs, with image pull
# narrowed to this repository.
resource "aws_iam_role_policy" "agent_runtime" {
  count = var.enable_agentcore ? 1 : 0
  name  = "agent-runtime"
  role  = aws_iam_role.agent_runtime[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ImagePull"
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource = aws_ecr_repository.agent_runtime[0].arn
      },
      {
        Sid      = "ImagePullToken"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid      = "LogGroups"
        Effect   = "Allow"
        Action   = ["logs:DescribeLogStreams", "logs:CreateLogGroup"]
        Resource = "arn:aws:logs:${var.region}:${var.sandbox_account_id}:log-group:/aws/bedrock-agentcore/runtimes/*"
      },
      {
        Sid      = "LogGroupPolicy"
        Effect   = "Allow"
        Action   = "logs:PutResourcePolicy"
        Resource = "arn:aws:logs:${var.region}:${var.sandbox_account_id}:log-group:/aws/bedrock-agentcore/runtimes/${local.agent_runtime_name}-*"
      },
      {
        Sid      = "LogGroupList"
        Effect   = "Allow"
        Action   = "logs:DescribeLogGroups"
        Resource = "arn:aws:logs:${var.region}:${var.sandbox_account_id}:log-group:*"
      },
      {
        Sid      = "LogEvents"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.region}:${var.sandbox_account_id}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*"
      },
      {
        Sid      = "Traces"
        Effect   = "Allow"
        Action   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"]
        Resource = "*"
      },
      {
        Sid       = "Metrics"
        Effect    = "Allow"
        Action    = "cloudwatch:PutMetricData"
        Resource  = "*"
        Condition = { StringEquals = { "cloudwatch:namespace" = "bedrock-agentcore" } }
      },
      {
        Sid    = "WorkloadTokens"
        Effect = "Allow"
        Action = [
          "bedrock-agentcore:GetWorkloadAccessToken",
          "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
          "bedrock-agentcore:GetWorkloadAccessTokenForUserId",
        ]
        Resource = [
          "arn:aws:bedrock-agentcore:${var.region}:${var.sandbox_account_id}:workload-identity-directory/default",
          "arn:aws:bedrock-agentcore:${var.region}:${var.sandbox_account_id}:workload-identity-directory/default/workload-identity/${local.agent_runtime_name}-*",
        ]
      },
      {
        Sid    = "BedrockModelInvocation"
        Effect = "Allow"
        Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/*",
          "arn:aws:bedrock:${var.region}:${var.sandbox_account_id}:*",
        ]
      },
    ]
  })
}

# deploy_runtime.py treats a null repository as "AgentCore is switched off".
output "agent_runtime_name" {
  value = local.agent_runtime_name
}
output "agent_runtime_repository_url" {
  value = one(aws_ecr_repository.agent_runtime[*].repository_url)
}
output "agent_runtime_role_arn" {
  value = one(aws_iam_role.agent_runtime[*].arn)
}
