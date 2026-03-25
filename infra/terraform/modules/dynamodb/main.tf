resource "aws_dynamodb_table" "feature_flags" {
  name         = "${var.project}-${var.environment}-feature-flags"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "tenant_id"
  range_key    = "flag_name"

  attribute {
    name = "tenant_id"
    type = "S"
  }

  attribute {
    name = "flag_name"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = var.environment == "prod" ? true : false
  }

  server_side_encryption { enabled = true }

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  tags = { Name = "${var.project}-${var.environment}-feature-flags" }
}

resource "aws_dynamodb_table" "idempotency_keys" {
  name         = "${var.project}-${var.environment}-idempotency-keys"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "idempotency_key"

  attribute {
    name = "idempotency_key"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  server_side_encryption { enabled = true }

  tags = { Name = "${var.project}-${var.environment}-idempotency-keys" }
}

resource "aws_dynamodb_table" "rate_counters" {
  name         = "${var.project}-${var.environment}-rate-counters"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "counter_key"

  attribute {
    name = "counter_key"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  server_side_encryption { enabled = true }

  tags = { Name = "${var.project}-${var.environment}-rate-counters" }
}

resource "aws_dynamodb_table" "webhook_retry_state" {
  name         = "${var.project}-${var.environment}-webhook-retry-state"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "webhook_id"

  attribute {
    name = "webhook_id"
    type = "S"
  }

  attribute {
    name = "tenant_id"
    type = "S"
  }

  global_secondary_index {
    name            = "tenant-index"
    hash_key        = "tenant_id"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  server_side_encryption { enabled = true }

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  tags = { Name = "${var.project}-${var.environment}-webhook-retry-state" }
}

resource "aws_dynamodb_table" "terraform_locks" {
  count        = var.create_terraform_lock_table ? 1 : 0
  name         = "grainguard-terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  server_side_encryption { enabled = true }

  tags = { Name = "grainguard-terraform-locks" }
}
