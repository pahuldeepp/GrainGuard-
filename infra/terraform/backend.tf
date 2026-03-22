# Remote state backend — S3 + DynamoDB locking
# Before first use, create these resources manually (or via a bootstrap script):
#
#   aws s3api create-bucket \
#     --bucket grainguard-terraform-state \
#     --region us-east-1
#
#   aws s3api put-bucket-versioning \
#     --bucket grainguard-terraform-state \
#     --versioning-configuration Status=Enabled
#
#   aws s3api put-bucket-encryption \
#     --bucket grainguard-terraform-state \
#     --server-side-encryption-configuration \
#       '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"}}]}'
#
#   aws dynamodb create-table \
#     --table-name grainguard-terraform-locks \
#     --attribute-definitions AttributeName=LockID,AttributeType=S \
#     --key-schema AttributeName=LockID,KeyType=HASH \
#     --billing-mode PAY_PER_REQUEST \
#     --region us-east-1
#
# Then run: terraform init -reconfigure

terraform {
  backend "s3" {
    bucket         = "grainguard-terraform-state"     # must already exist
    key            = "grainguard/terraform.tfstate"   # path within bucket
    region         = "us-east-1"
    dynamodb_table = "grainguard-terraform-locks"     # prevents concurrent apply
    encrypt        = true                             # KMS server-side encryption
  }
}
