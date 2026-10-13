locals {
  use_floci = var.floci_endpoint != ""
}

provider "aws" {
  region = var.aws_region

  # Dummy credentials are fine for Floci. When floci_endpoint is empty, fall
  # back to the normal AWS credential chain.
  access_key = local.use_floci ? "test" : null
  secret_key = local.use_floci ? "test" : null

  # Floci has no real account, so skip the checks that need one.
  skip_credentials_validation = local.use_floci
  skip_metadata_api_check     = local.use_floci
  skip_requesting_account_id  = local.use_floci

  # Path-style addressing (localhost:4566/bucket) rather than bucket.localhost.
  s3_use_path_style = local.use_floci

  # Floci serves every service from one endpoint. Add services here as you
  # start using them (lambda, apigateway, events, iam, logs, ...).
  dynamic "endpoints" {
    for_each = local.use_floci ? [1] : []
    content {
      dynamodb       = var.floci_endpoint
      s3             = var.floci_endpoint
      secretsmanager = var.floci_endpoint
      sts            = var.floci_endpoint
    }
  }

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
