import { Flow, Node } from "@pocketflow/core";
import dotenv from "dotenv";
import * as yaml from "js-yaml";
import { OpenAI } from "openai";
import * as path from "path";

dotenv.config({
  path: path.join(__dirname, "../../../.env"),
});

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function callLLM(prompt: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
  });
  return response.choices[0].message.content || "";
}

const MAX_ITERATIONS = 5;
const PASSING_SCORE = 9;

// --- Draft node ---
// Writes a first draft, or revises the current draft using critic feedback.
class Draft extends Node {
  async prep(shared: any): Promise<any> {
    return {
      topic: shared.topic,
      draft: shared.draft,
      feedback: shared.feedback,
    };
  }

  async exec(p: any): Promise<string> {
    const { topic, draft, feedback } = p;
    const prompt = draft
      ? `Revise this haiku about "${topic}".

Current draft:
${draft}

Critic feedback:
${feedback}

Reply with only the revised haiku.`
      : `Write a haiku about "${topic}". Reply with only the haiku.`;
    return (await callLLM(prompt)).trim();
  }

  async post(shared: any, _prep: any, draft: string): Promise<string> {
    shared.draft = draft;
    shared.iteration++;
    console.log(`\n--- Draft #${shared.iteration} ---\n${draft}`);
    return "critique";
  }
}

// --- Critique node ---
// Scores the draft. Loops back to Draft until it passes or we run out of iterations.
class Critique extends Node {
  async prep(shared: any): Promise<any> {
    return { topic: shared.topic, draft: shared.draft };
  }

  async exec(p: any): Promise<any> {
    const prompt = `
You are a strict poetry critic. Evaluate this haiku about "${p.topic}":

${p.draft}

Judge imagery, structure (5-7-5), and emotional resonance.

Output in code fence:
\`\`\`yaml
think: >
    reasoning about strengths and weaknesses
score: 1-10 integer
feedback: >
    concrete suggestions for improvement
\`\`\`
`;
    const resp = await callLLM(prompt);
    const m = resp.match(/```yaml([\s\S]*?)```/);
    if (!m) throw new Error("no yaml block found");
    const result: any = yaml.load(m[1].trim());
    if (!result || typeof result !== "object") throw new Error("invalid yaml response");
    if (typeof result.score !== "number") throw new Error("missing numeric score");
    if (!result.feedback) throw new Error("missing feedback");
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async execFallback(_p: any, exc: any): Promise<any> {
    return { score: PASSING_SCORE, feedback: "critic failed, accepting draft" };
  }

  async post(shared: any, _prep: any, review: any): Promise<string> {
    console.log(`\nCritic score: ${review.score}/10`);
    console.log(`Feedback: ${String(review.feedback).trim()}`);

    if (review.score >= PASSING_SCORE) {
      console.log("\nDraft accepted!");
      return "done";
    }
    if (shared.iteration >= MAX_ITERATIONS) {
      console.log(`\nMax iterations (${MAX_ITERATIONS}) reached, stopping.`);
      return "done";
    }
    shared.feedback = review.feedback;
    return "revise"; // loop back to Draft
  }
}

// --- Finish node ---
class Finish extends Node {
  async prep(shared: any): Promise<void> {
    console.log(`\n=== Final haiku (after ${shared.iteration} draft(s)) ===\n${shared.draft}`);
  }
}

// --- Main orchestration ---
async function main() {
  const topic = process.argv.slice(2).join(" ") || "autumn rain";

  const shared: any = {
    topic,
    draft: null,
    feedback: null,
    iteration: 0,
  };

  console.log(`Topic: ${topic}`);

  const draft = new Draft();
  const critique = new Critique(3, 500); // retries for malformed yaml
  const finish = new Finish();

  draft.transition("critique").to(critique);
  critique.transition("revise").to(draft); // the loop
  critique.transition("done").to(finish);

  const flow = new Flow(draft, {
    onNodeStart: node => console.log(`\n[flow] running ${node.constructor.name}`),
  });
  await flow.run(shared);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
