variable "aws_region" {
  description = "AWS region (Floci accepts any valid region name)."
  type        = string
  default     = "us-east-1"
}

variable "floci_endpoint" {
  description = "Floci endpoint URL. Set to an empty string to target real AWS instead."
  type        = string
  default     = "http://localhost:4566"
}

variable "project_name" {
  description = "Prefix used when naming resources."
  type        = string
  default     = "stock-viewer"
}

variable "environment" {
  description = "Environment name, used in resource names and tags."
  type        = string
  default     = "local"
}
