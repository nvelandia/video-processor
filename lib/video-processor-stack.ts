import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
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

    // 2. Tabla DynamoDB para tracking de jobs
    const jobsTable = new dynamodb.Table(this, 'VideoJobsTable', {
      partitionKey: { name: 'videoId', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // 3. IAM Role para MediaConvert
    const mediaConvertRole = new iam.Role(this, 'MediaConvertServiceRole', {
      assumedBy: new iam.ServicePrincipal('mediaconvert.amazonaws.com'),
    });

    // Otorgar permisos de lectura/escritura en el bucket a MediaConvert
    videoInputBucket.grantReadWrite(mediaConvertRole);

    // 4. Lambda: registra el job en DynamoDB (paso 1 del Step Function)
    const registerJobLambda = new nodejs.NodejsFunction(this, 'RegisterJob', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/register-job.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      environment: {
        TABLE_NAME: jobsTable.tableName,
      },
    });

    jobsTable.grantWriteData(registerJobLambda);

    // 5a. Lambda: genera calidades de video con MediaConvert (rama paralela)
    const submitJobLambda = new nodejs.NodejsFunction(this, 'SubmitMediaConvertJob', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/submit-job.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        VIDEO_BUCKET: videoInputBucket.bucketName,
        OUTPUT_PREFIX: 'videos-output/',
        MEDIACONVERT_ROLE_ARN: mediaConvertRole.roleArn,
        MEDIACONVERT_ENDPOINT: 'https://mediaconvert.us-east-1.amazonaws.com',
      },
    });

    submitJobLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [mediaConvertRole.roleArn],
    }));
    submitJobLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['mediaconvert:CreateJob'],
      resources: ['*'],
    }));
    videoInputBucket.grantRead(submitJobLambda);

    // 5b. Lambda: analiza el video con Twelve Labs Pegasus via Bedrock (rama paralela)
    const analyzeVideoLambda = new nodejs.NodejsFunction(this, 'AnalyzeVideo', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/analyze-video.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      environment: {
        PEGASUS_MODEL_ID: process.env.PEGASUS_MODEL_ID ?? '',
        BUCKET_OWNER: this.account,
      },
    });

    analyzeVideoLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:*::foundation-model/twelvelabs.pegasus-1-2-v1:0`],
    }));
    videoInputBucket.grantRead(analyzeVideoLambda);

    // 6. Step Function
    const registerJobTask = new tasks.LambdaInvoke(this, 'Registrar trabajo', {
      lambdaFunction: registerJobLambda,
      outputPath: '$.Payload',
    });

    const analysisFailed = new sfn.Pass(this, 'Analisis fallido', {
      parameters: { error: sfn.JsonPath.stringAt('$.Cause') },
    });

    const analyzeVideoTask = new tasks.LambdaInvoke(this, 'Analizar video con Pegasus', {
      lambdaFunction: analyzeVideoLambda,
    });
    analyzeVideoTask.addCatch(analysisFailed, { errors: ['States.ALL'] });

    const parallelState = new sfn.Parallel(this, 'Procesar video en paralelo');
    parallelState.branch(
      new tasks.LambdaInvoke(this, 'Generar calidades de video', {
        lambdaFunction: submitJobLambda,
      })
    );
    parallelState.branch(analyzeVideoTask);

    const stateMachine = new sfn.StateMachine(this, 'VideoProcessingStateMachine', {
      definition: registerJobTask.next(parallelState),
      timeout: cdk.Duration.minutes(10),
    });

    // 7. Lambda trigger: recibe evento S3 e inicia el Step Function
    const triggerLambda = new nodejs.NodejsFunction(this, 'TriggerStepFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/start-execution.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      environment: {
        STATE_MACHINE_ARN: stateMachine.stateMachineArn,
      },
    });

    stateMachine.grantStartExecution(triggerLambda);

    // 8. Notificaciones S3 → trigger Lambda
    videoInputBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(triggerLambda),
      { prefix: 'videos-input/', suffix: '.mp4' }
    );

    videoInputBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(triggerLambda),
      { prefix: 'videos-input/', suffix: '.m3u8' }
    );
  }
}