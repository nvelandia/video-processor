import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import * as path from 'path';

export interface LambdasProps {
  stage: string;
  bucket: s3.IBucket;
  jobsTable: dynamodb.ITable;
  mediaConvertRoleArn: string;
  mediaConvertEndpoint: string;
  stateMachineArn: string;
}

export class Lambdas extends Construct {
  readonly orchestrator: nodejs.NodejsFunction;
  readonly qualitiesLaunch: nodejs.NodejsFunction;
  readonly qualitiesCallback: nodejs.NodejsFunction;
  readonly highlightsLaunch: nodejs.NodejsFunction;
  readonly highlightsCallback: nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: LambdasProps) {
    super(scope, id);

    const {
      stage,
      bucket,
      jobsTable,
      mediaConvertRoleArn,
      mediaConvertEndpoint,
      stateMachineArn,
    } = props;

    // ── Orchestrator ────────────────────────────────────────────────────────────

    this.orchestrator = new nodejs.NodejsFunction(this, 'Orchestrator', {
      functionName: `video-processor-${stage}-orchestrator`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambda/orchestrator/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(15),
      environment: {
        TABLE_NAME: jobsTable.tableName,
        BUCKET: bucket.bucketName,
        STATE_MACHINE_ARN: stateMachineArn,
      },
    });

    jobsTable.grantWriteData(this.orchestrator);
    bucket.grantPut(this.orchestrator);
    this.orchestrator.addToRolePolicy(new iam.PolicyStatement({
      actions: ['states:StartExecution'],
      resources: [stateMachineArn],
    }));

    // ── Qualities ───────────────────────────────────────────────────────────────

    const mediaConvertEnv = {
      MEDIACONVERT_ENDPOINT: mediaConvertEndpoint,
      MEDIACONVERT_ROLE_ARN: mediaConvertRoleArn,
      TABLE_NAME: jobsTable.tableName,
    };

    this.qualitiesLaunch = new nodejs.NodejsFunction(this, 'QualitiesLaunch', {
      functionName: `video-processor-${stage}-qualities-launch`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambda/qualities/index.ts'),
      handler: 'launch',
      timeout: cdk.Duration.seconds(30),
      environment: mediaConvertEnv,
    });

    this.qualitiesLaunch.addToRolePolicy(new iam.PolicyStatement({
      actions: ['mediaconvert:CreateJob', 'iam:PassRole'],
      resources: ['*'],
    }));
    bucket.grantRead(this.qualitiesLaunch);
    jobsTable.grantWriteData(this.qualitiesLaunch);

    this.qualitiesCallback = new nodejs.NodejsFunction(this, 'QualitiesCallback', {
      functionName: `video-processor-${stage}-qualities-callback`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambda/qualities/index.ts'),
      handler: 'callback',
      timeout: cdk.Duration.seconds(10),
      environment: { TABLE_NAME: jobsTable.tableName },
    });

    this.qualitiesCallback.addToRolePolicy(new iam.PolicyStatement({
      actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
      resources: ['*'],
    }));
    jobsTable.grantReadData(this.qualitiesCallback);

    // ── Highlights ──────────────────────────────────────────────────────────────

    this.highlightsLaunch = new nodejs.NodejsFunction(this, 'HighlightsLaunch', {
      functionName: `video-processor-${stage}-highlights-launch`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambda/highlights/index.ts'),
      handler: 'launch',
      timeout: cdk.Duration.seconds(30),
      environment: mediaConvertEnv,
    });

    this.highlightsLaunch.addToRolePolicy(new iam.PolicyStatement({
      actions: ['mediaconvert:CreateJob', 'iam:PassRole'],
      resources: ['*'],
    }));
    bucket.grantRead(this.highlightsLaunch);
    jobsTable.grantWriteData(this.highlightsLaunch);

    this.highlightsCallback = new nodejs.NodejsFunction(this, 'HighlightsCallback', {
      functionName: `video-processor-${stage}-highlights-callback`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambda/highlights/index.ts'),
      handler: 'callback',
      timeout: cdk.Duration.seconds(10),
      environment: { TABLE_NAME: jobsTable.tableName },
    });

    this.highlightsCallback.addToRolePolicy(new iam.PolicyStatement({
      actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
      resources: ['*'],
    }));
    jobsTable.grantReadData(this.highlightsCallback);
  }
}
