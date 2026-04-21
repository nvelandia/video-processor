import * as cdk from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { buildDefinition } from '../step-functions/definition';

export interface StateMachineConstructProps {
  stage: string;
  jobsTable: dynamodb.ITable;
  qualitiesLaunchFn: lambda.IFunction;
}

export class StateMachineConstruct extends Construct {
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: StateMachineConstructProps) {
    super(scope, id);

    const { stage, jobsTable, qualitiesLaunchFn } = props;

    const definition = buildDefinition(this, {
      jobsTable,
      qualitiesLaunchFn,
    });

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: `video-processor-${stage}-pipeline`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(4),
    });

    qualitiesLaunchFn.grantInvoke(this.stateMachine.role);
    jobsTable.grantWriteData(this.stateMachine.role);
  }
}
