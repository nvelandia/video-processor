import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as path from 'path';
import { Construct } from 'constructs';

export interface FargatePegasusProps {
  stage: string;
  inputBucket: s3.IBucket;
}

export class FargatePegasus extends Construct {
  readonly cluster: ecs.Cluster;
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly container: ecs.ContainerDefinition;
  readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: FargatePegasusProps) {
    super(scope, id);

    const { stage, inputBucket } = props;

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{
        name: 'public',
        subnetType: ec2.SubnetType.PUBLIC,
        cidrMask: 24,
      }],
    });

    this.securityGroup = new ec2.SecurityGroup(this, 'Sg', {
      vpc,
      allowAllOutbound: true,
      description: `Pegasus Fargate task - ${stage}`,
    });

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `video-processor-${stage}-pegasus`,
      vpc,
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
      resources: ['*'],
    }));
    inputBucket.grantRead(taskRole);

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
      taskRole,
    });

    this.container = this.taskDefinition.addContainer('pegasus', {
      image: ecs.ContainerImage.fromAsset(
        path.join(__dirname, '../../fargate/pegasus'),
      ),
      environment: {
        ACCOUNT_ID: cdk.Stack.of(this).account,
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: `video-processor-${stage}-pegasus`,
      }),
    });
  }
}
