resource "aws_db_subnet_group" "main" {
  name       = "${var.project}-${var.environment}-rds-subnet"
  subnet_ids = var.private_subnet_ids
  tags       = { Name = "${var.project}-${var.environment}-rds-subnet" }
}

resource "aws_security_group" "rds" {
  name   = "${var.project}-${var.environment}-rds-sg"
  vpc_id = var.vpc_id

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_instance" "main" {
  identifier        = "${var.project}-${var.environment}"
  engine            = "postgres"
  engine_version    = "16"
  instance_class    = var.instance_class
  allocated_storage = 20
  storage_encrypted = true

  db_name  = "grainguard"
  username = "postgres"
  password = var.db_password

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  backup_retention_period = 7
  deletion_protection     = var.environment == "prod" ? true : false
  skip_final_snapshot     = var.environment == "prod" ? false : true
  multi_az                = var.environment == "prod" ? true : false

  tags = { Name = "${var.project}-${var.environment}-rds" }
}
