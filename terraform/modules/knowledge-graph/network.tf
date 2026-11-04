# No internet gateway, NAT or peering: nothing in this VPC has a path out, and nothing outside
# it connects to Neptune. S3 is reached through the free gateway endpoint in ingest.tf's policy.
data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "kg" {
  cidr_block           = "10.90.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.name}-private" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.kg.id
  cidr_block        = "10.90.${count.index}.0/24"
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = { Name = "${var.name}-private-${count.index}" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.kg.id

  tags = { Name = "${var.name}-private" }
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.kg.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = "*"
      Action    = ["s3:ListBucket", "s3:GetObject"]
      Resource  = [aws_s3_bucket.ingest.arn, "${aws_s3_bucket.ingest.arn}/raw/*"]
    }]
  })
}
