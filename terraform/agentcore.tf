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
