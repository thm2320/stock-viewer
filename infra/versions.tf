terraform {
  # Local state lives outside the repo; supply the path at init time
  # by running ./init.sh (or `pnpm infra:init` from the repo root).
  backend "local" {}

  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
