data "archive_file" "tools" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda"
  output_path = "${path.module}/../build/tools.zip"
  excludes    = ["__pycache__/**", "tools.json"]
}

# Created empty; scripts/set_access_secret.py fills it, which keeps the login out of state.
resource "aws_secretsmanager_secret" "access" {
  name                    = "${local.hyphen_name}-access"
  recovery_window_in_days = 0
}

resource "aws_cloudwatch_log_group" "tools" {
  name              = "/aws/lambda/${local.hyphen_name}-tools"
  retention_in_days = 7
}

resource "aws_iam_role" "tools" {
  name = "${local.hyphen_name}-tools"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "tools" {
  name = "tools"
  role = aws_iam_role.tools.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadLogin"
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.access.arn
      },
      {
        Sid      = "WriteLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.tools.arn}:*"
      },
    ]
  })
}

resource "aws_lambda_function" "tools" {
  function_name    = "${local.hyphen_name}-tools"
  role             = aws_iam_role.tools.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "handler.handler"
  filename         = data.archive_file.tools.output_path
  source_code_hash = data.archive_file.tools.output_base64sha256
  timeout          = 60

  environment {
    variables = {
      ACCESS_SECRET_ARN = aws_secretsmanager_secret.access.arn
      SANDBOX_ORIGIN    = var.sandbox_origin
    }
  }

  depends_on = [aws_cloudwatch_log_group.tools, aws_iam_role_policy.tools]
}
