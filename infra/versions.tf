terraform {
  # Local state lives in infra/state, which orca.yaml shares across worktrees
  backend "local" {
    path = "state/terraform.tfstate"
  }

  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
