variable "sandbox_account_id" {
  description = "Dedicated sandbox account ID; enforced by the AWS provider."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.sandbox_account_id))
    error_message = "Supply a twelve-digit account ID."
  }
}

variable "sandbox_origin" {
  description = "The Virtual Lab's CloudFront origin."
  type        = string
  validation {
    condition     = can(regex("^https://[a-z0-9]+\\.cloudfront\\.net$", var.sandbox_origin))
    error_message = "Use https://<id>.cloudfront.net with no path."
  }
}

variable "region" {
  description = "AWS region for all resources."
  type        = string
}

variable "name" {
  description = "Letters, digits and underscores for Runtime naming; converted to hyphens where a resource needs them."
  type        = string
  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9_]{0,40}$", var.name))
    error_message = "Use letters, digits and underscores, starting with a letter."
  }
}

variable "model_id" {
  description = "Bedrock inference profile ID."
  type        = string
  default     = "us.anthropic.claude-haiku-5-5"
}

variable "lambda_memory_mb" {
  description = "Memory for the tool Lambda."
  type        = number
  default     = 512
}

variable "tool_timeout_seconds" {
  description = "Longest a tool call may run. Used by the Lambda and the agent's Gateway client."
  type        = number
  default     = 60

  validation {
    condition     = var.tool_timeout_seconds >= 10 && var.tool_timeout_seconds <= 300
    error_message = "Use 10 to 300 seconds."
  }
}

variable "max_output_tokens" {
  description = "Most tokens the model may write in one call."
  type        = number
  default     = 1024
}

variable "agent_zip_path" {
  description = "Agent package built by agentcore/scripts/build_agent.sh."
  type        = string
}

variable "source_dir" {
  description = "Folder that holds lambda/ and build/."
  type        = string
}
