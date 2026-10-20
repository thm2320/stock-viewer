terraform {
  # Local state lives outside the repo; supply the path at init time:
  #   terraform init -backend-config="path=$HOME/.terraform-state/stock-viewer/terraform.tfstate"
  backend "local" {}

  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
