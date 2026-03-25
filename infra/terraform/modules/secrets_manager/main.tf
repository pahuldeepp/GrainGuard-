locals {
  secrets = {
    db_password            = { description = "RDS Postgres master password" }
    auth0_client_secret    = { description = "Auth0 client secret for BFF" }
    auth0_mgmt_secret      = { description = "Auth0 management API secret" }
    redis_auth_token       = { description = "Elasticache Redis auth token" }
    kafka_sasl_password    = { description = "MSK SASL/SCRAM password" }
    slack_webhook_url      = { description = "Slack webhook for Grafana alerts" }
    api_key_signing_secret = { description = "HMAC secret for device API key signing" }
    jwt_signing_secret     = { description = "JWT signing secret fallback" }
  }
}

resource "aws_secretsmanager_secret" "secrets" {
  for_each                = local.secrets
  name                    = "${var.project}/${var.environment}/${each.key}"
  description             = each.value.description
  recovery_window_in_days = var.environment == "prod" ? 30 : 0
  tags                    = { Name = "${var.project}-${var.environment}-${each.key}" }
}

resource "aws_secretsmanager_secret_version" "placeholders" {
  for_each      = local.secrets
  secret_id     = aws_secretsmanager_secret.secrets[each.key].id
  secret_string = "PLACEHOLDER_REPLACE_BEFORE_DEPLOY"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_iam_policy" "secrets_read" {
  name        = "${var.project}-${var.environment}-secrets-read"
  description = "Allow reading GrainGuard secrets from Secrets Manager"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
        Resource = [for s in aws_secretsmanager_secret.secrets : s.arn]
      },
      {
        Sid      = "ListSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:ListSecrets"]
        Resource = "*"
      }
    ]
  })
}
