variable "sandbox_account_id" {
  description = "Dedicated sandbox account ID; enforced by the AWS provider."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.sandbox_account_id))
    error_message = "Supply a twelve-digit dedicated sandbox account ID."
  }
}
variable "region" {
  type    = string
  default = "us-east-1"
}
variable "name" {
  type    = string
  default = "mmrf-synthetic"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name))
    error_message = "Use 3-31 lowercase letters, digits, and hyphens."
  }
}
variable "operator_role_arn" {
  description = "Existing IAM role the operator uses for Kubernetes administration; no credentials are created."
  type        = string
  validation {
    condition     = can(regex("^arn:aws:iam::[0-9]{12}:role/.+", var.operator_role_arn))
    error_message = "Supply an existing IAM role ARN in the sandbox account."
  }
}
variable "operator_cidrs" {
  description = "Operator/VPN egress CIDRs allowed to reach the EKS API. Workload services remain ClusterIP."
  type        = list(string)
  validation {
    condition     = length(var.operator_cidrs) > 0 && alltrue([for c in var.operator_cidrs : can(cidrnetmask(c)) && try(tonumber(split("/", c)[1]) >= 24 && tonumber(split("/", c)[1]) <= 32, false)])
    error_message = "Supply IPv4 CIDRs with /24 or narrower masks; unrestricted API access is not supported."
  }
}
variable "kubernetes_version" {
  type    = string
  default = "1.35"
}
variable "vpc_cidr" {
  description = "Fresh isolated VPC; existing LZA resources are never imported or modified."
  type        = string
  default     = "10.86.0.0/16"
  validation {
    condition     = can(cidrnetmask(var.vpc_cidr)) && try(tonumber(split("/", var.vpc_cidr)[1]) == 16, false)
    error_message = "Use an IPv4 /16 for the new isolated VPC."
  }
}
variable "enable_https" {
  description = "Add a private ALB and CloudFront HTTPS entry point; Helm must enable the password-protected access service."
  type        = bool
  default     = false
}
variable "enable_agentcore" {
  description = "Create the AgentCore Runtime, Gateway and tool Lambda. Tools call the CloudFront origin, so this needs enable_https."
  type        = bool
  default     = false
  validation {
    condition     = !var.enable_agentcore || var.enable_https
    error_message = "enable_agentcore needs enable_https."
  }
}
variable "agent_zip_path" {
  description = "Agent package. Defaults to the output of agentcore/scripts/build_agent.sh."
  type        = string
  default     = null
}
