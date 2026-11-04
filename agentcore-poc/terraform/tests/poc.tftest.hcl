mock_provider "aws" {}

variables {
  sandbox_account_id = "123456789012"
  sandbox_origin     = "https://example.cloudfront.net"
  agent_zip_path     = "tests/fixtures/agent.zip"
}

run "agent_speaks_agui_and_callers_use_iam" {
  command = plan

  assert {
    condition     = aws_bedrockagentcore_agent_runtime.agent.protocol_configuration[0].server_protocol == "AGUI"
    error_message = "Runtime must use AG-UI"
  }
  assert {
    condition     = length(aws_bedrockagentcore_agent_runtime.agent.authorizer_configuration) == 0
    error_message = "Runtime callers use IAM"
  }
  assert {
    condition     = aws_bedrockagentcore_agent_runtime.agent.environment_variables["AGENT_REGION"] == var.region
    error_message = "Agent needs its region"
  }
}

run "gateway_uses_iam_and_lists_the_tools" {
  command = plan

  assert {
    condition     = aws_bedrockagentcore_gateway.tools.authorizer_type == "AWS_IAM"
    error_message = "Gateway must use IAM"
  }
  assert {
    condition     = aws_bedrockagentcore_gateway.tools.protocol_type == "MCP"
    error_message = "Gateway must speak MCP"
  }
  assert {
    condition     = aws_bedrockagentcore_gateway_target.virtual_lab.name == "virtual-lab"
    error_message = "Tools must appear as virtual-lab___<tool>"
  }
  assert {
    condition     = strcontains(aws_bedrockagentcore_gateway_target.virtual_lab.target_configuration[0].mcp[0].lambda[0].tool_schema[0].s3[0].uri, filemd5("../lambda/tools.json"))
    error_message = "Target tools must come from the schema in S3"
  }
  assert {
    condition     = strcontains(aws_s3_object.tool_schema.key, filemd5("../lambda/tools.json"))
    error_message = "A changed tools.json must change the key"
  }
  assert {
    condition     = aws_s3_object.tool_schema.source_hash == filemd5("../lambda/tools.json")
    error_message = "The schema must re-upload when tools.json changes"
  }
}

run "new_zip_changes_the_code_key" {
  command = plan

  variables {
    agent_zip_path = "tests/fixtures/other.zip"
  }

  assert {
    condition     = aws_s3_object.agent_code.key == "agent-${filemd5("tests/fixtures/other.zip")}.zip"
    error_message = "A new zip must change the key so the Runtime updates"
  }
  assert {
    condition     = aws_s3_object.agent_code.source_hash == filemd5("tests/fixtures/other.zip")
    error_message = "The zip uploads as multipart, so its etag never equals an MD5"
  }
}

run "lambda_targets_the_sandbox_origin" {
  command = plan

  assert {
    condition     = aws_lambda_function.tools.environment[0].variables["SANDBOX_ORIGIN"] == var.sandbox_origin
    error_message = "Lambda must call the configured origin"
  }
  assert {
    condition     = aws_lambda_function.tools.timeout == 60
    error_message = "Tools need up to 60 seconds for several Virtual Lab calls"
  }
  assert {
    condition     = aws_lambda_function.tools.architectures[0] == "arm64"
    error_message = "Lambda is arm64"
  }
}

run "runtime_logs_are_managed_so_destroy_removes_them" {
  command = plan

  assert {
    condition     = aws_cloudwatch_log_group.runtime.retention_in_days == 7
    error_message = "Runtime logs need a managed group with a retention"
  }
}

run "rejects_origin_with_a_path" {
  command = plan

  variables {
    sandbox_origin = "https://example.cloudfront.net/x"
  }

  expect_failures = [var.sandbox_origin]
}
