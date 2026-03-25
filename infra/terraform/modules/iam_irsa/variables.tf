variable "project"               { type = string }
variable "environment"           { type = string }
variable "oidc_issuer_url"       { type = string }
variable "oidc_provider_arn"     { type = string }
variable "secrets_read_policy_arn" { type = string }
variable "dynamodb_table_arns"   { type = list(string) }

variable "k8s_namespace" {
  type    = string
  default = "grainguard"
}
