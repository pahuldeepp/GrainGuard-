variable "project"            { type = string }
variable "environment"        { type = string }
variable "vpc_id"             { type = string }
variable "vpc_cidr"           { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "instance_class"     { type = string }

variable "db_password" {
  type      = string
  sensitive = true
}
