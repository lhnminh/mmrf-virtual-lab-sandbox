output "agent_runtime_arn" {
  description = "ARN that Chat and invoke.py call."
  value       = aws_bedrockagentcore_agent_runtime.agent.agent_runtime_arn
}

output "gateway_url" {
  description = "AgentCore Gateway URL that the agent calls for tools."
  value       = aws_bedrockagentcore_gateway.tools.gateway_url
}

output "lambda_function_name" {
  description = "Name of the tool Lambda."
  value       = aws_lambda_function.tools.function_name
}

output "access_secret_arn" {
  description = "Secret that set_access_secret.py fills with the Virtual Lab login."
  value       = aws_secretsmanager_secret.access.arn
}
