resource "aws_security_group" "msk" {
  name   = "${var.project}-${var.environment}-msk-sg"
  vpc_id = var.vpc_id

  ingress {
    from_port   = 9092
    to_port     = 9092
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  ingress {
    from_port   = 9094
    to_port     = 9094
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

resource "aws_msk_cluster" "main" {
  cluster_name           = "${var.project}-${var.environment}"
  kafka_version          = "3.5.1"
  number_of_broker_nodes = var.environment == "prod" ? 3 : 1

  broker_node_group_info {
    instance_type   = var.instance_type
    client_subnets  = slice(var.private_subnet_ids, 0, var.environment == "prod" ? 3 : 1)
    security_groups = [aws_security_group.msk.id]

    storage_info {
      ebs_storage_info { volume_size = 100 }
    }
  }

  encryption_info {
    encryption_in_transit { client_broker = "TLS_PLAINTEXT" }
  }

  tags = { Name = "${var.project}-${var.environment}-msk" }
}
