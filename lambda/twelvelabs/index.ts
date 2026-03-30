import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrock = new BedrockRuntimeClient({});

interface MediaConvertClipping {
  StartTimecode: string;
  EndTimecode: string;
}

function toTimecode(mmss: string): string {
  const parts = mmss.split(':');
  const minutes = parts[0].padStart(2, '0');
  const seconds = parts[1].padStart(2, '0');
  return `00:${minutes}:${seconds}:00`;
}

export const handler = async (event: {
  jobId: string;
  inputKey: string;
  bedrockModelId: string;
}): Promise<{ timestamps: MediaConvertClipping[] }> => {
  const { jobId, inputKey, bedrockModelId } = event;

  const requestBody = JSON.stringify({
    mediaSource: {
      s3Location: { uri: inputKey, bucketOwner: process.env.ACCOUNT_ID },
    },
    inputPrompt:
      'Identify all goals in this soccer match. ' +
      'Return a JSON array where each element has: start (MM:SS), end (MM:SS), label (string).',
  });

  const response = await bedrock.send(new InvokeModelCommand({
    modelId: bedrockModelId,
    body: new TextEncoder().encode(requestBody),
    contentType: 'application/json',
    accept: 'application/json',
  }));

  const rawString = new TextDecoder().decode(response.body);
  console.log('Bedrock raw response:', rawString);

  const responseBody = JSON.parse(rawString);
  console.log('Bedrock parsed response:', JSON.stringify(responseBody));

  let raw: Array<{ start: string; end: string; label: string }> = [];
  if (Array.isArray(responseBody)) {
    raw = responseBody;
  } else if (Array.isArray(responseBody.timestamps)) {
    raw = responseBody.timestamps;
  } else if (typeof responseBody.message === 'string') {
    raw = JSON.parse(responseBody.message);
  }

  const timestamps: MediaConvertClipping[] = raw.map((t) => ({
    StartTimecode: toTimecode(t.start),
    EndTimecode: toTimecode(t.end),
  }));

  console.log(`Pegasus: ${timestamps.length} clips para jobId=${jobId}`);
  return { timestamps };
};
