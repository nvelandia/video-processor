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
}

export function buildDefinition(scope: Construct, props: DefinitionProps): sfn.IChainable {
  const { jobsTable, qualitiesLaunchFn, highlightsLaunchFn, twelvelabsFn } = props;

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

  const invokePegasus = new sfn.CustomState(scope, 'InvokePegasus', {
    stateJson: {
      Type: 'Task',
      Resource: 'arn:aws:states:::bedrock-runtime:startAsyncInvoke.sync:2',
      Parameters: {
        ModelId: 'twelvelabs.pegasus-1-2-v1:0',
        ModelInput: {
          mediaSource: {
            s3Location: { 'uri.$': '$.inputKey' },
          },
          inputPrompt: 'Identify all key moments (goals, cards, near misses) in this soccer match. Return a JSON array where each element has: start (MM:SS), end (MM:SS), label (string).',
        },
        OutputDataConfig: {
          s3OutputDataConfig: {
            's3Uri.$': "States.Format('{}tmp/', $.outputVideo)",
          },
        },
      },
      ResultPath: '$.pegasusInvocation',
    },
  });

  const parsePegasusOutput = new tasks.LambdaInvoke(scope, 'ParsePegasusOutput', {
    lambdaFunction: twelvelabsFn,
    payload: sfn.TaskInput.fromObject({
      'jobId.$':        '$.jobId',
      'outputBucket.$': '$.outputBucket',
    }),
    resultSelector: { 'timestamps.$': '$.Payload.timestamps' },
    resultPath: '$.parsed',
  });

  const updateHighlightsFailed = new tasks.DynamoUpdateItem(scope, 'UpdateHighlightsFailed', {
    table: jobsTable,
    key: { jobId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')) },
    updateExpression: 'SET highlightsStatus = :s',
    expressionAttributeValues: { ':s': tasks.DynamoAttributeValue.fromString('FAILED') },
    resultPath: sfn.JsonPath.DISCARD,
  }).next(new sfn.Fail(scope, 'NoTimestamps', {
    error: 'EmptyTimestamps',
    cause: 'Pegasus no devolvió momentos clave',
  }));

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
      'timestamps.$':  '$.parsed.timestamps',
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
      sfn.Condition.isPresent('$.parsed.timestamps[0]'),
      sfn.Chain.start(updateHighlightsToProcessing)
        .next(launchHighlights)
        .next(updateHighlightsDone),
    )
    .otherwise(updateHighlightsFailed);

  const branchB = sfn.Chain.start(invokePegasus)
    .next(parsePegasusOutput)
    .next(checkTimestamps);

  // ── Parallel ──────────────────────────────────────────────────────────────────

  const parallel = new sfn.Parallel(scope, 'ParallelProcess');
  parallel.branch(branchA);
  parallel.branch(branchB);

  return sfn.Chain.start(registerStart).next(parallel);
}