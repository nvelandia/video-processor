# Video Processor Project

## Arquitectura
Toda la infraestructura se despliega mediante AWS CDK.

## What this project does
Processes uploaded MP4 videos into multiple quality versions.
A file upload to S3 triggers a Lambda that handles the transcoding.

## Stack
- AWS CDK 
- S3 (video input bucket)
- Lambda (video processing)
- Language: Nodejs y TypeScript

## Project structure
- `lib/` - CDK stack definition
- `lambda/` - Lambda function code

## Key commands
```bash
cdk deploy        # Deploy stack
cdk diff          # Preview changes
cdk destroy       # Destroy stack
```
