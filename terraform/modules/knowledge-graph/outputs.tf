output "gateway_url" {
  description = "URL the agent calls for the kg_* tools."
  value       = aws_bedrockagentcore_gateway.graph.gateway_url
}

output "gateway_arn" {
  description = "Gateway ARN, for InvokeGateway grants."
  value       = aws_bedrockagentcore_gateway.graph.gateway_arn
}

output "ingest_bucket" {
  description = "Bucket that load-graph uploads the raw files to."
  value       = aws_s3_bucket.ingest.id
}

output "ingest_function" {
  description = "Lambda that load-graph invokes to write the graph."
  value       = aws_lambda_function.ingest.function_name
}

output "graph_function" {
  description = "Lambda behind the tools."
  value       = aws_lambda_function.graph.function_name
}
