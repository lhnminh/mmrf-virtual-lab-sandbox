# The root provider tags everything as synthetic. This data is public reference data, so the
# module gets its own provider with the same region and account check.
provider "aws" {
  alias               = "knowledge_graph"
  region              = var.region
  allowed_account_ids = [var.sandbox_account_id]
  default_tags {
    tags = { Project = "mmrf-virtual-lab-sandbox", Data = "public-reference", Environment = "sandbox" }
  }
}

module "knowledge_graph" {
  count  = var.enable_knowledge_graph ? 1 : 0
  source = "./modules/knowledge-graph"

  providers = { aws = aws.knowledge_graph }

  sandbox_account_id = var.sandbox_account_id
  region             = var.region
  name               = "${var.name}-kg"
  lambda_zip_path    = coalesce(var.knowledge_graph_zip_path, "${path.module}/../knowledge-graph/build/lambda.zip")
  source_dir         = "${path.module}/../knowledge-graph"
}

# Lets the agent call the graph tools. Separate from the agent module, so the module stays usable alone.
resource "aws_iam_role_policy" "agent_invoke_knowledge_graph" {
  count = var.enable_knowledge_graph && var.enable_agentcore ? 1 : 0
  name  = "invoke-knowledge-graph-gateway"
  role  = module.agentcore[0].runtime_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "bedrock-agentcore:InvokeGateway"
      Resource = module.knowledge_graph[0].gateway_arn
    }]
  })
}

output "knowledge_graph_gateway_url" {
  description = "Knowledge graph Gateway URL, or null when the graph is off."
  value       = one(module.knowledge_graph[*].gateway_url)
}

output "knowledge_graph_ingest_bucket" {
  description = "Bucket load-graph uploads to, or null when the graph is off."
  value       = one(module.knowledge_graph[*].ingest_bucket)
}

output "knowledge_graph_ingest_function" {
  description = "Lambda load-graph invokes, or null when the graph is off."
  value       = one(module.knowledge_graph[*].ingest_function)
}
