import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';

export class VideoProcessorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. Importar el bucket existente
    // const videoInputBucket = s3.Bucket.fromBucketName(this, 'videoInputBucket', 'media.tycsports.com');

    const videoInputBucket = new s3.Bucket(this, 'videoInputBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // 2. IAM Role para MediaConvert
    const mediaConvertRole = new iam.Role(this, 'MediaConvertServiceRole', {
      assumedBy: new iam.ServicePrincipal('mediaconvert.amazonaws.com'),
    });

    // Otorgar permisos de lectura/escritura en el bucket a MediaConvert
    videoInputBucket.grantReadWrite(mediaConvertRole);

    // 3. Función Lambda
    const processorLambda = new nodejs.NodejsFunction(this, 'SubmitMediaConvertJob', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/submit-job.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        // Pasamos el bucket unificado y la ruta de salida
        VIDEO_BUCKET: videoInputBucket.bucketName,
        OUTPUT_PREFIX: 'videos-output/', 
        MEDIACONVERT_ROLE_ARN: mediaConvertRole.roleArn,
        MEDIACONVERT_ENDPOINT: 'https://mediaconvert.us-east-1.amazonaws.com',
      },
    });

    // Permisos para la Lambda
    processorLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [mediaConvertRole.roleArn],
    }));
    processorLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['mediaconvert:CreateJob'],
      resources: ['*'],
    }));

    // La Lambda necesita leer el archivo original para disparar el job
    videoInputBucket.grantRead(processorLambda);

    // 4. Configurar las Notificaciones de S3 (Trigger)
    // Regla para .mp4 en la carpeta videos-input/
    videoInputBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(processorLambda),
      { prefix: 'videos-input/', suffix: '.mp4' }
    );

    // Regla para .m3u8 en la carpeta videos-input/
    videoInputBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(processorLambda),
      { prefix: 'videos-input/', suffix: '.m3u8' }
    );
  }
}