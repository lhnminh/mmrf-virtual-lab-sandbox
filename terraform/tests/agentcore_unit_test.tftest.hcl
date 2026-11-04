mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_data "aws_cloudfront_cache_policy" {
    defaults = { min_ttl = 0, default_ttl = 0, max_ttl = 0 }
  }
}
override_data {
  target = data.aws_availability_zones.available
  values = { names = ["us-west-2a", "us-west-2b"] }
}
variables {
  sandbox_account_id = "123456789012"
  operator_role_arn  = "arn:aws:iam::123456789012:role/SandboxOperator"
  operator_cidrs     = ["192.0.2.1/32"]
  agent_zip_path     = "modules/agentcore/tests/fixtures/agent.zip"
}
run "agentcore_is_off_by_default" {
  command = plan
  variables {
    enable_python_agent = false
  }
  assert {
    condition     = length(module.agentcore) == 0 && output.agent_runtime_arn == null
    error_message = "A default deploy must create no AgentCore resources."
  }
}
run "agentcore_needs_https" {
  command = plan
  variables {
    enable_https     = false
    enable_python_agent = true
  }
  expect_failures = [var.enable_python_agent]
}
run "agentcore_on_with_https" {
  command = plan
  variables {
    enable_https     = true
    enable_python_agent = true
  }
  assert {
    condition     = length(module.agentcore) == 1
    error_message = "enable_python_agent must create the module."
  }
}
