import * as cdk from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { buildDefinition } from '../step-functions/definition';

export interface StateMachineConstructProps {
  stage: string;
  jobsTable: dynamodb.ITable;
  qualitiesLaunchFn: lambda.IFunction;
  highlightsLaunchFn: lambda.IFunction;
  pegasusCluster: ecs.ICluster;
  pegasusTaskDef: ecs.FargateTaskDefinition;
  pegasusContainer: ecs.ContainerDefinition;
  pegasusSecurityGroup: ec2.ISecurityGroup;
  bedrockModelId: string;
}

export class StateMachineConstruct extends Construct {
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: StateMachineConstructProps) {
    super(scope, id);

    const {
      stage,
      jobsTable,
      qualitiesLaunchFn,
      highlightsLaunchFn,
      pegasusCluster,
      pegasusTaskDef,
      pegasusContainer,
      pegasusSecurityGroup,
      bedrockModelId,
    } = props;

    const definition = buildDefinition(this, {
      jobsTable,
      qualitiesLaunchFn,
      highlightsLaunchFn,
      pegasusCluster,
      pegasusTaskDef,
      pegasusContainer,
      pegasusSecurityGroup,
      bedrockModelId,
    });

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: `video-processor-${stage}-pipeline`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(2),
    });

    qualitiesLaunchFn.grantInvoke(this.stateMachine.role);
    highlightsLaunchFn.grantInvoke(this.stateMachine.role);

    // Allow Step Functions to launch and track the Fargate task
    this.stateMachine.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask', 'ecs:StopTask', 'ecs:DescribeTasks'],
      resources: ['*'],
    }));
    this.stateMachine.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [
        pegasusTaskDef.taskRole.roleArn,
        pegasusTaskDef.executionRole!.roleArn,
      ],
    }));

    jobsTable.grantWriteData(this.stateMachine.role);
  }
}
