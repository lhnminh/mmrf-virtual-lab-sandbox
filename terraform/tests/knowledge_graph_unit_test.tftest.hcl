mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_data "aws_cloudfront_cache_policy" {
    defaults = { min_ttl = 0, default_ttl = 0, max_ttl = 0 }
  }
}
mock_provider "aws" {
  alias = "knowledge_graph"
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
}
override_data {
  target = data.aws_availability_zones.available
  values = { names = ["us-west-2a", "us-west-2b"] }
}
override_data {
  target = module.knowledge_graph[0].data.aws_availability_zones.available
  values = { names = ["us-west-2a", "us-west-2b"] }
}
variables {
  sandbox_account_id       = "123456789012"
  operator_role_arn        = "arn:aws:iam::123456789012:role/SandboxOperator"
  operator_cidrs           = ["192.0.2.1/32"]
  agent_zip_path           = "modules/agentcore/tests/fixtures/agent.zip"
  knowledge_graph_zip_path = "modules/agentcore/tests/fixtures/agent.zip"
}
run "off_by_default" {
  command = plan
  variables {
    enable_knowledge_graph = false
  }
  assert {
    condition     = length(module.knowledge_graph) == 0
    error_message = "A default deploy must create no knowledge graph resources."
  }
  assert {
    condition = (
      output.knowledge_graph_gateway_url == null &&
      output.knowledge_graph_ingest_bucket == null &&
      output.knowledge_graph_ingest_function == null
    )
    error_message = "Outputs must be null when the graph is off."
  }
  assert {
    condition     = length(aws_iam_role_policy.agent_invoke_knowledge_graph) == 0
    error_message = "With no graph there is nothing to grant."
  }
}
run "on_without_agent" {
  command = plan
  variables {
    enable_agentcore       = false
    enable_knowledge_graph = true
  }
  assert {
    condition     = length(module.knowledge_graph) == 1
    error_message = "The flag must create the module."
  }
  assert {
    condition     = length(aws_iam_role_policy.agent_invoke_knowledge_graph) == 0
    error_message = "With no agent there is no role to grant."
  }
}
run "on_with_agent" {
  command = plan
  variables {
    enable_https           = true
    enable_agentcore       = true
    enable_knowledge_graph = true
  }
  assert {
    condition     = length(module.knowledge_graph) == 1
    error_message = "The flag must create the module."
  }
  assert {
    condition     = length(aws_iam_role_policy.agent_invoke_knowledge_graph) == 1
    error_message = "The agent needs permission to call the KG Gateway."
  }
}
