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
  default     = "us-west-2"
}

variable "name" {
  description = "Letters, digits and underscores for Runtime naming; converted to hyphens where a resource needs them."
  type        = string
  default     = "mmrf_agentcore_poc"
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

variable "agent_zip_path" {
  description = "Agent package built by scripts/build_agent.sh."
  type        = string
  default     = "../build/agent.zip"
}
