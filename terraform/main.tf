terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # S3 Vectors resources landed in the AWS provider in the 6.x line.
      version = ">= 6.15.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4.0"
    }
    null = {
      source  = "hashicorp/null"
      version = ">= 3.2.0"
    }
  }

  # Local state only — this is a throwaway POC. Do NOT use for anything real.
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = var.project_name
      ManagedBy   = "terraform"
      Purpose     = "s3-vectors-website-search-poc"
      CostCenter  = var.cost_center
      auto-delete = "no"
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}
