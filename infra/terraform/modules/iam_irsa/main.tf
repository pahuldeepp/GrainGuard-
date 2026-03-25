locals {
  oidc_provider = replace(var.oidc_issuer_url, "https://", "")
}

resource "aws_iam_role" "ci_push" {
  name = "${var.project}-${var.environment}-ci-ecr-push"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "sts.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Name = "${var.project}-${var.environment}-ci-ecr-push" }
}

resource "aws_iam_role_policy_attachment" "ci_ecr" {
  role       = aws_iam_role.ci_push.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser"
}

locals {
  service_accounts = {
    gateway          = "gateway"
    bff              = "bff"
    telemetry-ingest = "telemetry-ingest"
    asset-registry   = "asset-registry"
    risk-engine      = "risk-engine"
    jobs-worker      = "jobs-worker"
  }
}

resource "aws_iam_role" "service" {
  for_each = local.service_accounts
  name     = "${var.project}-${var.environment}-sa-${each.key}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = var.oidc_provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.oidc_provider}:sub" = "system:serviceaccount:${var.k8s_namespace}:${each.value}"
          "${local.oidc_provider}:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })

  tags = { Name = "${var.project}-${var.environment}-sa-${each.key}" }
}

resource "aws_iam_role_policy_attachment" "secrets_read" {
  for_each   = local.service_accounts
  role       = aws_iam_role.service[each.key].name
  policy_arn = var.secrets_read_policy_arn
}

resource "aws_iam_policy" "dynamodb_control_plane" {
  name        = "${var.project}-${var.environment}-dynamodb-control-plane"
  description = "Read/write GrainGuard DynamoDB control plane tables"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "ControlPlaneAccess"
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:BatchGetItem",
        "dynamodb:BatchWriteItem",
      ]
      Resource = var.dynamodb_table_arns
    }]
  })
}

resource "aws_iam_role_policy_attachment" "dynamodb" {
  for_each   = local.service_accounts
  role       = aws_iam_role.service[each.key].name
  policy_arn = aws_iam_policy.dynamodb_control_plane.arn
}
