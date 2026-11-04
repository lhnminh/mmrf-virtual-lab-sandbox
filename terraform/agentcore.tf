# The agent, its tool Gateway and tool Lambda. Tools call the Virtual Lab through CloudFront.
module "agentcore" {
  count  = var.enable_agentcore ? 1 : 0
  source = "./modules/agentcore"

  sandbox_account_id = var.sandbox_account_id
  region             = var.region
  # Runtime names allow letters, digits and underscores only.
  name           = "${replace(var.name, "-", "_")}_agent"
  sandbox_origin = "https://${aws_cloudfront_distribution.sandbox[0].domain_name}"
  agent_zip_path = coalesce(var.agent_zip_path, "${path.module}/../agentcore/build/agent.zip")
  source_dir     = "${path.module}/../agentcore"
}

# Chat on the deployed site: the identity pod invokes the agent with the node role.
# Only identity's NetworkPolicy allows it to reach the credentials.
resource "aws_iam_role_policy" "nodes_invoke_agent" {
  count = var.enable_agentcore ? 1 : 0
  name  = "invoke-agent-runtime"
  role  = aws_iam_role.nodes.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "bedrock-agentcore:InvokeAgentRuntime"
      Resource = [module.agentcore[0].agent_runtime_arn, "${module.agentcore[0].agent_runtime_arn}/runtime-endpoint/*"]
    }]
  })
}

output "agent_runtime_arn" {
  description = "AgentCore Runtime ARN, or null when AgentCore is off."
  value       = one(module.agentcore[*].agent_runtime_arn)
}

output "agentcore_gateway_url" {
  description = "AgentCore Gateway URL, or null when AgentCore is off."
  value       = one(module.agentcore[*].gateway_url)
}

output "agentcore_access_secret_arn" {
  description = "Secret that holds the Virtual Lab login for tools, or null when AgentCore is off."
  value       = one(module.agentcore[*].access_secret_arn)
}
