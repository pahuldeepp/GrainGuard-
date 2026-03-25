variable "project"     { type = string }
variable "environment" { type = string }
variable "create_terraform_lock_table" {
  description = "Create the DynamoDB table used for Terraform state locking. Set true once per AWS account."
  type        = bool
  default     = false
}
