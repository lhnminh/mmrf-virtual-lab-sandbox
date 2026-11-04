variable "sandbox_account_id" {
  description = "Dedicated sandbox account ID."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.sandbox_account_id))
    error_message = "Supply a twelve-digit account ID."
  }
}

variable "region" {
  description = "AWS region for all resources."
  type        = string
}

variable "name" {
  description = "Prefix for every resource name."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,40}$", var.name))
    error_message = "Use lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "lambda_zip_path" {
  description = "Package built by knowledge-graph/scripts/build_lambda.py."
  type        = string
}

variable "source_dir" {
  description = "Folder that holds tools.json."
  type        = string
}
