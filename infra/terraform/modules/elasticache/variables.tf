variable "project"            { type = string }
variable "environment"        { type = string }
variable "vpc_id"             { type = string }
variable "vpc_cidr"           { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "node_type"          { type = string }
