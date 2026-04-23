import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface DefinitionProps {
  jobsTable:            dynamodb.ITable;
  qualitiesLaunchFn:    lambda.IFunction;
  splitterFn:           lambda.IFunction;
  crowdNoiseFn:         lambda.IFunction;
  transcribeLaunchFn:   lambda.IFunction;
  rekognitionLaunchFn:  lambda.IFunction;
  fusionFn:             lambda.IFunction;
  highlightLaunchFn:    lambda.IFunction;
}

export function buildDefinition(scope: Construct, props: DefinitionProps): sfn.IChainable {
  const {
    jobsTable,
    qualitiesLaunchFn,
    splitterFn,
    crowdNoiseFn,
    transcribeLaunchFn,
    rekognitionLaunchFn,
    fusionFn,
    highlightLaunchFn,
  } = props;

  // ── RegisterStart ─────────────────────────────────────────────────────────────

  const registerStart = new tasks.DynamoPutItem(scope, 'RegisterStart', {
    table: jobsTable,
    item: {
      jobId:           tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')),
      qualitiesStatus: tasks.DynamoAttributeValue.fromString('PENDING'),
      goalsStatus:     tasks.DynamoAttributeValue.fromString('PENDING'),
      outputVideo:     tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.outputVideo')),
      inputKey:        tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.inputKey')),
      createdAt:       tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.Execution.StartTime')),
    },
    resultPath: sfn.JsonPath.DISCARD,
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // Branch A: Qualities (sin cambios de flujo, sólo se reactiva dentro del Parallel)
  // ──────────────────────────────────────────────────────────────────────────────

  const launchQualities = new tasks.LambdaInvoke(scope, 'LaunchMediaConvertQualities', {
    lambdaFunction:     qualitiesLaunchFn,
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
    updateExpression:          'SET qualitiesStatus = :s',
    expressionAttributeValues: { ':s': tasks.DynamoAttributeValue.fromString('DONE') },
    resultPath: sfn.JsonPath.DISCARD,
  });

  const updateQualitiesFailed = new tasks.DynamoUpdateItem(scope, 'UpdateQualitiesFailed', {
    table: jobsTable,
    key: { jobId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')) },
    updateExpression:          'SET qualitiesStatus = :s',
    expressionAttributeValues: { ':s': tasks.DynamoAttributeValue.fromString('FAILED') },
    resultPath: sfn.JsonPath.DISCARD,
  });

  launchQualities.addCatch(updateQualitiesFailed, { errors: ['States.ALL'], resultPath: '$.error' });

  const qualitiesBranch = launchQualities.next(updateQualitiesDone);

  // ──────────────────────────────────────────────────────────────────────────────
  // Branch B: Goals
  // ──────────────────────────────────────────────────────────────────────────────

  // Splitter → preserva input original bajo $.splitter para chunks/fps/durationS
  const videoSplitter = new tasks.LambdaInvoke(scope, 'VideoSplitter', {
    lambdaFunction: splitterFn,
    payload: sfn.TaskInput.fromObject({
      'jobId.$':    '$.jobId',
      'inputKey.$': '$.inputKey',
    }),
    resultPath: '$.splitter',
    resultSelector: {
      'hasAudio.$':  '$.Payload.hasAudio',
      'chunks.$':    '$.Payload.chunks',
      'fps.$':       '$.Payload.fps',
      'durationS.$': '$.Payload.durationS',
    },
  });

  // Terminal NO_AUDIO — el splitter ya escribió el status, esto lo confirma idempotentemente
  const updateGoalsNoAudio = new tasks.DynamoUpdateItem(scope, 'UpdateGoalsNoAudio', {
    table: jobsTable,
    key: { jobId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')) },
    updateExpression:          'SET goalsStatus = :s',
    expressionAttributeValues: { ':s': tasks.DynamoAttributeValue.fromString('NO_AUDIO') },
    resultPath: sfn.JsonPath.DISCARD,
  });

  const updateGoalsFailed = new tasks.DynamoUpdateItem(scope, 'UpdateGoalsFailed', {
    table: jobsTable,
    key: { jobId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')) },
    updateExpression:          'SET goalsStatus = :s',
    expressionAttributeValues: { ':s': tasks.DynamoAttributeValue.fromString('FAILED') },
    resultPath: sfn.JsonPath.DISCARD,
  });

  const updateGoalsDone = new tasks.DynamoUpdateItem(scope, 'UpdateGoalsDone', {
    table: jobsTable,
    key: { jobId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.jobId')) },
    updateExpression:          'SET goalsStatus = :s',
    expressionAttributeValues: { ':s': tasks.DynamoAttributeValue.fromString('DONE') },
    resultPath: sfn.JsonPath.DISCARD,
  });

  // ── ChunkSignals: Parallel interno del Map ─────────────────────────────────

  const crowdNoiseAnalysis = new tasks.LambdaInvoke(scope, 'CrowdNoiseAnalysis', {
    lambdaFunction: crowdNoiseFn,
    payload:        sfn.TaskInput.fromJsonPathAt('$.chunk'),
    resultPath:     sfn.JsonPath.DISCARD,
  });

  const transcribeJob = new tasks.LambdaInvoke(scope, 'TranscribeJob', {
    lambdaFunction:     transcribeLaunchFn,
    integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
    payload: sfn.TaskInput.fromObject({
      'taskToken':     sfn.JsonPath.taskToken,
      'jobId.$':       '$.chunk.jobId',
      'chunkIndex.$':  '$.chunk.chunkIndex',
      'inputKey.$':    '$.chunk.inputKey',
      'startS.$':      '$.chunk.startS',
      'endS.$':        '$.chunk.endS',
      'offsetMs.$':    '$.chunk.offsetMs',
    }),
    resultPath: sfn.JsonPath.DISCARD,
  });

  const chunkSignals = new sfn.Parallel(scope, 'ChunkSignals', {
    resultPath: sfn.JsonPath.DISCARD,
  })
    .branch(crowdNoiseAnalysis)
    .branch(transcribeJob);

  // Map por chunk: crowd-noise + Transcribe en paralelo por cada chunk
  const goalsMap = new sfn.Map(scope, 'GoalsMap', {
    maxConcurrency: 12,
    itemsPath:      sfn.JsonPath.stringAt('$.splitter.chunks'),
    itemSelector:   { 'chunk.$': '$$.Map.Item.Value' },
    resultPath:     sfn.JsonPath.DISCARD,
  });
  goalsMap.itemProcessor(chunkSignals);

  // Rekognition una sola vez sobre el video completo — fuera del Map
  const rekognitionFullVideo = new tasks.LambdaInvoke(scope, 'RekognitionFullVideo', {
    lambdaFunction:     rekognitionLaunchFn,
    integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
    payload: sfn.TaskInput.fromObject({
      'taskToken':  sfn.JsonPath.taskToken,
      'jobId.$':    '$.jobId',
      'inputKey.$': '$.inputKey',
    }),
    resultPath: sfn.JsonPath.DISCARD,
  });

  // Parallel: Map (chunk signals) + Rekognition (full video)
  const goalsProcessing = new sfn.Parallel(scope, 'GoalsProcessing', {
    resultPath: sfn.JsonPath.DISCARD,
  })
    .branch(goalsMap)
    .branch(rekognitionFullVideo);

  const goalsFusion = new tasks.LambdaInvoke(scope, 'GoalsFusion', {
    lambdaFunction: fusionFn,
    payload: sfn.TaskInput.fromObject({ 'jobId.$': '$.jobId' }),
    resultPath: '$.fusion',
    resultSelector: { 'goals.$': '$.Payload.goals' },
  });

  const launchGoalsHighlight = new tasks.LambdaInvoke(scope, 'LaunchGoalsHighlight', {
    lambdaFunction:     highlightLaunchFn,
    integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
    payload: sfn.TaskInput.fromObject({
      'taskToken':  sfn.JsonPath.taskToken,
      'jobId.$':    '$.jobId',
      'inputKey.$': '$.inputKey',
      'fps.$':      '$.splitter.fps',
      'goals.$':    '$.fusion.goals',
    }),
    resultPath: sfn.JsonPath.DISCARD,
  });

  // Catches: cualquier fallo en goals → goalsStatus=FAILED, no revienta toda la SFN
  videoSplitter.addCatch(updateGoalsFailed,        { errors: ['States.ALL'], resultPath: '$.error' });
  goalsProcessing.addCatch(updateGoalsFailed,      { errors: ['States.ALL'], resultPath: '$.error' });
  goalsFusion.addCatch(updateGoalsFailed,          { errors: ['States.ALL'], resultPath: '$.error' });
  launchGoalsHighlight.addCatch(updateGoalsFailed, { errors: ['States.ALL'], resultPath: '$.error' });

  const goalsActiveChain = goalsProcessing
    .next(goalsFusion)
    .next(launchGoalsHighlight)
    .next(updateGoalsDone);

  const checkHasAudio = new sfn.Choice(scope, 'HasAudio?')
    .when(sfn.Condition.booleanEquals('$.splitter.hasAudio', false), updateGoalsNoAudio)
    .otherwise(goalsActiveChain);

  const goalsBranch = videoSplitter.next(checkHasAudio);

  // ── Parallel principal: branch A (qualities) + branch B (goals) ───────────────
  // TEMPORAL: branch A desactivada para probar solo branch B
  const qualitiesSkip = new sfn.Pass(scope, 'QualitiesSkip');

  const processingBranches = new sfn.Parallel(scope, 'ProcessingBranches', {
    resultPath: sfn.JsonPath.DISCARD,
  })
    .branch(qualitiesSkip)  // TEMPORAL — reemplazar por qualitiesBranch para producción
    .branch(goalsBranch);

  return sfn.Chain.start(registerStart).next(processingBranches);
}
