output "secret_arns" {
  value = { for k, v in aws_secretsmanager_secret.secrets : k => v.arn }
}
output "secret_names" {
  value = { for k, v in aws_secretsmanager_secret.secrets : k => v.name }
}
output "secrets_read_policy_arn" {
  value = aws_iam_policy.secrets_read.arn
}
