terraform {
  required_version = ">= 1.9, < 2.0"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.71" }
    archive = { source = "hashicorp/archive", version = "~> 2.7" }
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.sandbox_account_id]
  default_tags {
    tags = { Project = "mmrf-virtual-lab-sandbox", Data = "synthetic-only", Environment = "sandbox" }
  }
}
