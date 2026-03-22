output "feature_flags_table_name"       { value = aws_dynamodb_table.feature_flags.name }
output "feature_flags_table_arn"        { value = aws_dynamodb_table.feature_flags.arn }
output "feature_flags_stream_arn"       { value = aws_dynamodb_table.feature_flags.stream_arn }
output "idempotency_keys_table_name"    { value = aws_dynamodb_table.idempotency_keys.name }
output "idempotency_keys_table_arn"     { value = aws_dynamodb_table.idempotency_keys.arn }
output "rate_counters_table_name"       { value = aws_dynamodb_table.rate_counters.name }
output "rate_counters_table_arn"        { value = aws_dynamodb_table.rate_counters.arn }
output "webhook_retry_state_table_name" { value = aws_dynamodb_table.webhook_retry_state.name }
output "webhook_retry_state_table_arn"  { value = aws_dynamodb_table.webhook_retry_state.arn }
output "webhook_retry_state_stream_arn" { value = aws_dynamodb_table.webhook_retry_state.stream_arn }
output "terraform_lock_table_name" {
  value = var.create_terraform_lock_table ? aws_dynamodb_table.terraform_locks[0].name : null
}
output "all_table_arns" {
  value = [
    aws_dynamodb_table.feature_flags.arn,
    aws_dynamodb_table.idempotency_keys.arn,
    aws_dynamodb_table.rate_counters.arn,
    aws_dynamodb_table.webhook_retry_state.arn,
  ]
}
