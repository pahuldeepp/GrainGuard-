terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket         = "grainguard-terraform-state"
    key            = "grainguard/dr/terraform.tfstate"
    region         = "us-east-1"           # state always in primary region
    dynamodb_table = "grainguard-terraform-locks"
    encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region   # us-west-2

  default_tags {
    tags = {
      Project     = var.project
      Environment = "dr"
      ManagedBy   = "terraform"
    }
  }
}
