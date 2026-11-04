output "agent_runtime_arn" {
  value = aws_bedrockagentcore_agent_runtime.agent.agent_runtime_arn
}

output "gateway_url" {
  value = aws_bedrockagentcore_gateway.tools.gateway_url
}

output "lambda_function_name" {
  value = aws_lambda_function.tools.function_name
}

output "access_secret_arn" {
  value = aws_secretsmanager_secret.access.arn
}
