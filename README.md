# Video Processor

Procesa videos MP4 subidos a S3 generando múltiples versiones de calidad.
La infraestructura se despliega con AWS CDK.

## Arquitectura

```
S3 (videos-input/)
       ↓
  Lambda (trigger)
       ↓
  Step Function
       ↓
  Paso 1 → Paso 2 → ... → Paso N
```

## Pasos de procesamiento

Cada video subido genera un registro en DynamoDB con los campos:
`currentStep`, `totalSteps`, `stepName`, `status`, `createdAt`, `updatedAt`

| # | stepName | Descripción |
|---|----------|-------------|
| 1 | `GENERATING_QUALITIES` | Se registra el job en DynamoDB y se dispara el transcodeo en MediaConvert (240p, 360p, 480p, 720p, 1080p) |
| 2 | TBD | Se ejecuta cuando MediaConvert finaliza |

## Comandos

```bash
npx cdk deploy   # Deploy
npx cdk diff     # Preview de cambios
npx cdk destroy  # Eliminar stack
```