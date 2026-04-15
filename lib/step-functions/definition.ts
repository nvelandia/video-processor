import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface DefinitionProps {
  jobsTable: dynamodb.ITable;
  qualitiesLaunchFn: lambda.IFunction;
}

export function buildDefinition(scope: Construct, props: DefinitionProps): sfn.IChainable {
  const { jobsTable, qualitiesLaunchFn } = props;

  // ── RegisterStart ─────────────────────────────────────────────────────────────

  const registerStart = new tasks.DynamoPutItem(scope, 'RegisterStart', {
    table: jobsTable,
    item: {
      jobId:           tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')),
      qualitiesStatus: tasks.DynamoAttributeValue.fromString('PENDING'),
      outputVideo:     tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.outputVideo')),
      inputKey:        tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.inputKey')),
      createdAt:       tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.Execution.StartTime')),
    },
    resultPath: sfn.JsonPath.DISCARD,
  });

  // ── Calidades de video ──────────────────────────────────────────────────────

  const launchQualities = new tasks.LambdaInvoke(scope, 'LaunchMediaConvertQualities', {
    lambdaFunction: qualitiesLaunchFn,
    integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
    payload: sfn.TaskInput.fromObject({
      'taskToken':     sfn.JsonPath.taskToken,
      'jobId.$':       '$.jobId',
      'inputKey.$':    '$.inputKey',
      'outputVideo.$': '$.outputVideo',
    }),
    resultPath: sfn.JsonPath.DISCARD,
  });

  const updateQualitiesDone = new tasks.DynamoUpdateItem(scope, 'UpdateQualitiesDone', {
    table: jobsTable,
    key: { jobId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')) },
    updateExpression: 'SET qualitiesStatus = :s',
    expressionAttributeValues: { ':s': tasks.DynamoAttributeValue.fromString('DONE') },
    resultPath: sfn.JsonPath.DISCARD,
  });

  const updateQualitiesFailed = new tasks.DynamoUpdateItem(scope, 'UpdateQualitiesFailed', {
    table: jobsTable,
    key: { jobId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')) },
    updateExpression: 'SET qualitiesStatus = :s',
    expressionAttributeValues: { ':s': tasks.DynamoAttributeValue.fromString('FAILED') },
    resultPath: sfn.JsonPath.DISCARD,
  });

  launchQualities.addCatch(updateQualitiesFailed, { errors: ['States.ALL'], resultPath: '$.error' });

  return sfn.Chain.start(registerStart)
    .next(launchQualities)
    .next(updateQualitiesDone);
}
