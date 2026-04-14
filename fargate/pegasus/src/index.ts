import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from '@aws-sdk/client-sfn';

const bedrock = new BedrockRuntimeClient({});
const sfn = new SFNClient({});

interface MediaConvertClipping {
  StartTimecode: string;
  EndTimecode: string;
}

function toTimecode(mmss: string): string {
  const [mm, ss] = mmss.split(':');
  return `00:${mm.padStart(2, '0')}:${ss.padStart(2, '0')}:00`;
}

async function main(): Promise<void> {
  const taskToken = process.env.TASK_TOKEN!;
  const jobId = process.env.JOB_ID!;
  const inputKey = process.env.INPUT_KEY!;
  const bedrockModelId = process.env.BEDROCK_MODEL_ID!;
  const accountId = process.env.ACCOUNT_ID!;

  try {
    const requestBody = JSON.stringify({
      mediaSource: {
        s3Location: { uri: inputKey, bucketOwner: accountId },
      },
      inputPrompt: `You are a professional soccer match analyst. Your task is to find EVERY single goal scored in this entire soccer match video, from the first minute to the last. Missing even one goal is a critical failure.

DETECTION STRATEGY:
- Watch the ENTIRE match from start to finish. Do not skip any segment.
- A goal is confirmed by ANY of these signals: the ball clearly enters the net, the referee points to the center circle, the scoreboard/overlay updates, players celebrate, the crowd erupts, or the broadcast shows a replay of the ball entering the net.
- Include ALL types of goals: open play, penalties, free kicks, own goals, headers, deflections, goals from corners, and goals scored in stoppage/injury time.
- Pay special attention to moments right after halftime, during injury time (45+, 90+), and after VAR reviews, as these are commonly missed.
- If you see a replay of a goal, do NOT count the replay as a separate goal. Only count the live moment.
- If the scoreboard changes, there MUST be a corresponding goal segment in your output.

SEGMENT DEFINITION for each goal:
- "start" (MM:SS): the beginning of the build-up play that leads to the goal. This is typically when the attacking team gains clear possession and initiates the move (a recovery, a key pass, a counter-attack start, a set piece setup, or a sustained attacking sequence). Aim for roughly 8 to 20 seconds before the ball enters the net, depending on how the play develops. Do not start mid-pass; start at a natural beginning of the action.
- "goal_moment" (MM:SS): The exact instant the ball crosses the goal line.
- "end" (MM:SS): after the goal is scored, include the immediate celebration and reaction. End roughly 6 to 10 seconds after goal_moment, or when the broadcast cuts to a replay or wide shot, whichever comes first.

OUTPUT FORMAT:
Respond with ONLY a valid JSON array. No explanation, no markdown, no text outside the JSON.
Each element must have exactly: "start" (MM:SS), "goal_moment" (MM:SS), "end" (MM:SS).

Example for a match with 3 goals:
[{"start":"02:10","goal_moment":"02:25","end":"02:33"},{"start":"45:50","goal_moment":"46:05","end":"46:14"},{"start":"78:30","goal_moment":"78:42","end":"78:50"}]

If no goals, respond: []

FINAL CHECK: Before responding, verify that the number of goals you found matches the score changes visible on screen. If the scoreboard shows a 3-2 result, you must have exactly 5 goal segments.`,
    });

    const response = await bedrock.send(new InvokeModelCommand({
      modelId: bedrockModelId,
      body: new TextEncoder().encode(requestBody),
      contentType: 'application/json',
      accept: 'application/json',
    }));

    const rawString = new TextDecoder().decode(response.body);
    const responseBody = JSON.parse(rawString);

    // Extract the text content from Bedrock's response envelope
    let textContent: string;
    if (typeof responseBody.message === 'string') {
      textContent = responseBody.message;
    } else if (typeof responseBody.output === 'string') {
      textContent = responseBody.output;
    } else {
      textContent = rawString;
    }

    // Extract JSON array from the response, even if there is surrounding prose
    const jsonMatch = textContent.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error(`No JSON array found in Bedrock response: ${textContent.slice(0, 200)}`);
    }

    let raw: Array<{ start: string; goal_moment?: string; end: string; label: string }> = JSON.parse(jsonMatch[0]);

    const timestamps: MediaConvertClipping[] = raw.map((t) => ({
      StartTimecode: toTimecode(t.start),
      EndTimecode: toTimecode(t.end),
    }));

    console.log(`Pegasus: ${timestamps.length} clips para jobId=${jobId}`);

    await sfn.send(new SendTaskSuccessCommand({
      taskToken,
      output: JSON.stringify({ timestamps, goals: raw }),
    }));
  } catch (err) {
    console.error('Error in pegasus task:', err);
    await sfn.send(new SendTaskFailureCommand({
      taskToken,
      error: 'PegasusFailed',
      cause: String(err),
    }));
    process.exit(1);
  }
}

main();
