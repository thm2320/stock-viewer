locals {
  name_prefix = "${var.project_name}-${var.environment}"
}

# Price history: one item per symbol per timestamp.
#   "latest price"   -> Query symbol = X, ScanIndexForward = false, Limit = 1
#   "price history"  -> Query symbol = X with a range condition on timestamp
resource "aws_dynamodb_table" "quotes" {
  name         = "${local.name_prefix}-quotes"
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "symbol"
  range_key = "timestamp"

  attribute {
    name = "symbol"
    type = "S"
  }

  attribute {
    name = "timestamp"
    type = "N" # Unix seconds of the quote bar (TwelveData timestamp)
  }
}

# Raw WebSocket ticks: one item per symbol per second (latest tick wins).
# Items expire through the expiresAt TTL attribute.
resource "aws_dynamodb_table" "ticks" {
  name         = "${local.name_prefix}-ticks"
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "symbol"
  range_key = "timestamp"

  attribute {
    name = "symbol"
    type = "S"
  }

  attribute {
    name = "timestamp"
    type = "N" # Unix seconds of the tick (WebSocket price event timestamp)
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

# Raw responses from the market data API, kept for replay and debugging.
# resource "aws_s3_bucket" "raw_data" {
#   bucket = "${local.name_prefix}-raw-data"
# }

# Holds the market data API key. Terraform creates the empty secret only; set
# the value yourself so the key never lands in Terraform state:
#   aws secretsmanager put-secret-value \
#     --secret-id stock-viewer-local/market-data-api-key \
#     --secret-string 'YOUR_KEY'
# resource "aws_secretsmanager_secret" "market_data_api_key" {
#   name                    = "${local.name_prefix}/market-data-api-key"
#   recovery_window_in_days = 0 # allow immediate delete/recreate while experimenting
# }
