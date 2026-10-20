#!/usr/bin/env bash
# Initialise Terraform with the state kept outside the repo.
# Override the location with TF_STATE_DIR; extra args go to `terraform init`.
set -euo pipefail

STATE_DIR="${TF_STATE_DIR:-$HOME/.terraform-state/stock-viewer}"
mkdir -p "$STATE_DIR"

cd "$(dirname "$0")"
terraform init -backend-config="path=$STATE_DIR/terraform.tfstate" "$@"
