import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

interface PegasusTimestamp {
  start: string;
  end: string;
  label: string;
}

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

export const handler = async (event: { jobId: string; outputBucket: string }): Promise<{ timestamps: MediaConvertClipping[] }> => {
  const { jobId, outputBucket } = event;
  const key = `${jobId}/tmp/pegasus-result.json`;

  const response = await s3.send(new GetObjectCommand({
    Bucket: outputBucket,
    Key: key,
  }));

  const body = await response.Body!.transformToString();
  const parsed = JSON.parse(body);

  const raw: PegasusTimestamp[] = Array.isArray(parsed) ? parsed : (parsed.timestamps ?? []);

  const timestamps: MediaConvertClipping[] = raw.map((t) => ({
    StartTimecode: toTimecode(t.start),
    EndTimecode: toTimecode(t.end),
  }));

  console.log(`Pegasus output parseado: ${timestamps.length} clips para jobId=${jobId}`);

  return { timestamps };
};