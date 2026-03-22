output "ci_push_role_arn" { value = aws_iam_role.ci_push.arn }

output "service_role_arns" {
  description = "Map of service name to IAM role ARN — use as IRSA annotation on K8s ServiceAccounts"
  value       = { for k, v in aws_iam_role.service : k => v.arn }
}
