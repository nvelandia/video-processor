import { handler } from '../lambda/analyze-video';

jest.mock('@aws-sdk/client-bedrock-runtime', () => {
  const mockSendFn = jest.fn();
  return {
    __mockSend: mockSendFn,
    BedrockRuntimeClient: jest.fn(() => ({ send: mockSendFn })),
    InvokeModelCommand: jest.fn((input: unknown) => input),
  };
});

const { __mockSend: mockSend } = jest.requireMock('@aws-sdk/client-bedrock-runtime');

describe('analyze-video', () => {
  const event = {
    bucket: 'test-bucket',
    key: 'videos-input/partido.mp4',
    videoId: 'abc-123',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PEGASUS_MODEL_ID = 'twelvelabs.pegasus-1-2-v1:0';
    process.env.BUCKET_OWNER = '123456789012';
  });

  it('retorna los timestamps de goles cuando Bedrock responde correctamente', async () => {
    const mockGoals = [
      { timestamp: 23, description: 'Gol de cabeza en el área' },
      { timestamp: 87, description: 'Gol de penal' },
    ];

    mockSend.mockResolvedValueOnce({
      body: Buffer.from(JSON.stringify(mockGoals)),
    });

    const result = await handler(event);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      bucket: 'test-bucket',
      key: 'videos-input/partido.mp4',
      videoId: 'abc-123',
      goalTimestamps: mockGoals,
    });
  });

  it('construye el S3 URI correctamente a partir del bucket y key', async () => {
    mockSend.mockResolvedValueOnce({
      body: Buffer.from(JSON.stringify([])),
    });

    await handler(event);

    const callArg = mockSend.mock.calls[0][0] as { body: string };
    const body = JSON.parse(callArg.body) as { mediaSource: { s3Location: { uri: string; bucketOwner: string } } };
    expect(body.mediaSource.s3Location.uri).toBe('s3://test-bucket/videos-input/partido.mp4');
    expect(body.mediaSource.s3Location.bucketOwner).toBe('123456789012');
  });

  it('lanza error si Bedrock falla', async () => {
    mockSend.mockRejectedValueOnce(new Error('Bedrock timeout'));

    await expect(handler(event)).rejects.toThrow('Bedrock timeout');
  });
});