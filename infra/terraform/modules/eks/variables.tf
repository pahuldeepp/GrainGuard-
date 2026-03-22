variable "project"            { type = string }
variable "environment"        { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "instance_type"      { type = string }
variable "desired_nodes"      { type = number }
