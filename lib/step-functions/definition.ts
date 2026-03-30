import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface DefinitionProps {
  jobsTable: dynamodb.ITable;
  qualitiesLaunchFn: lambda.IFunction;
  highlightsLaunchFn: lambda.IFunction;
  twelvelabsFn: lambda.IFunction;
  bedrockModelId: string;
}

export function buildDefinition(scope: Construct, props: DefinitionProps): sfn.IChainable {
  const { jobsTable, qualitiesLaunchFn, highlightsLaunchFn, twelvelabsFn, bedrockModelId } = props;

  // ── RegisterStart ─────────────────────────────────────────────────────────────

  const registerStart = new tasks.DynamoPutItem(scope, 'RegisterStart', {
    table: jobsTable,
    item: {
      jobId:            tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')),
      qualitiesStatus:  tasks.DynamoAttributeValue.fromString('PENDING'),
      highlightsStatus: tasks.DynamoAttributeValue.fromString('PEGASUS'),
      outputVideo:      tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.outputVideo')),
      inputKey:         tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.inputKey')),
      createdAt:        tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.Execution.StartTime')),
    },
    resultPath: sfn.JsonPath.DISCARD,
  });

  // ── Branch A — Calidades ─────────────────────────────────────────────────────

  const launchQualities = new tasks.LambdaInvoke(scope, 'LaunchMediaConvertQualities', {
    lambdaFunction: qualitiesLaunchFn,
    integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
    payload: sfn.TaskInput.fromObject({
      'taskToken':   sfn.JsonPath.taskToken,
      'jobId.$':     '$.jobId',
      'inputKey.$':  '$.inputKey',
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

  const branchA = sfn.Chain.start(launchQualities).next(updateQualitiesDone);

  // ── Branch B — Análisis + Highlight reel ─────────────────────────────────────

  const updateHighlightsFailed = new tasks.DynamoUpdateItem(scope, 'UpdateHighlightsFailed', {
    table: jobsTable,
    key: { jobId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')) },
    updateExpression: 'SET highlightsStatus = :s',
    expressionAttributeValues: { ':s': tasks.DynamoAttributeValue.fromString('FAILED') },
    resultPath: sfn.JsonPath.DISCARD,
  }).next(new sfn.Succeed(scope, 'NoTimestamps'));

  const updateHighlightsToProcessing = new tasks.DynamoUpdateItem(scope, 'UpdateHighlightsStatus', {
    table: jobsTable,
    key: { jobId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')) },
    updateExpression: 'SET highlightsStatus = :s',
    expressionAttributeValues: { ':s': tasks.DynamoAttributeValue.fromString('HIGHLIGHTS') },
    resultPath: sfn.JsonPath.DISCARD,
  });

  const launchHighlights = new tasks.LambdaInvoke(scope, 'LaunchMediaConvertHighlight', {
    lambdaFunction: highlightsLaunchFn,
    integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
    payload: sfn.TaskInput.fromObject({
      'taskToken':     sfn.JsonPath.taskToken,
      'jobId.$':       '$.jobId',
      'inputKey.$':    '$.inputKey',
      'outputVideo.$': '$.outputVideo',
      'timestamps.$':  '$.pegasus.timestamps',
    }),
    resultPath: sfn.JsonPath.DISCARD,
  });

  const updateHighlightsDone = new tasks.DynamoUpdateItem(scope, 'UpdateHighlightsDone', {
    table: jobsTable,
    key: { jobId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')) },
    updateExpression: 'SET highlightsStatus = :s',
    expressionAttributeValues: { ':s': tasks.DynamoAttributeValue.fromString('DONE') },
    resultPath: sfn.JsonPath.DISCARD,
  });

  const updateHighlightsFailedOnMediaConvert = new tasks.DynamoUpdateItem(scope, 'UpdateHighlightsFailedOnMediaConvert', {
    table: jobsTable,
    key: { jobId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')) },
    updateExpression: 'SET highlightsStatus = :s',
    expressionAttributeValues: { ':s': tasks.DynamoAttributeValue.fromString('FAILED') },
    resultPath: sfn.JsonPath.DISCARD,
  });

  launchHighlights.addCatch(updateHighlightsFailedOnMediaConvert, { errors: ['States.ALL'], resultPath: '$.error' });

  const checkTimestamps = new sfn.Choice(scope, 'CheckTimestamps')
    .when(
      sfn.Condition.isPresent('$.pegasus.timestamps[0]'),
      sfn.Chain.start(updateHighlightsToProcessing)
        .next(launchHighlights)
        .next(updateHighlightsDone),
    )
    .otherwise(updateHighlightsFailed);

  // ── Pegasus polling loop ──────────────────────────────────────────────────────

  const invokePegasus = new tasks.LambdaInvoke(scope, 'InvokePegasus', {
    lambdaFunction: twelvelabsFn,
    payload: sfn.TaskInput.fromObject({
      'jobId.$':        '$.jobId',
      'inputKey.$':     '$.inputKey',
      'bedrockModelId': bedrockModelId,
    }),
    resultSelector: { 'timestamps.$': '$.Payload.timestamps' },
    resultPath: '$.pegasus',
  });

  const branchB = sfn.Chain.start(invokePegasus).next(checkTimestamps);

  // ── Parallel ──────────────────────────────────────────────────────────────────

  const parallel = new sfn.Parallel(scope, 'ParallelProcess');
  parallel.branch(branchA);
  parallel.branch(branchB);

  // Suppress unused variable warning
  void bedrockModelId;

  return sfn.Chain.start(registerStart).next(parallel);
}
