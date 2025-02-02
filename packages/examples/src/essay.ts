import { BatchFlow, BatchNode, Flow, Node } from "@pocketflow/core";
import dotenv from "dotenv";
import * as fs from "fs";
import * as yaml from "js-yaml";
import { OpenAI } from "openai";
import * as path from "path";
import readlineSync from "readline-sync";

dotenv.config({
  path: path.join(__dirname, "../../../.env"),
});

// --- minimal LLM wrapper ---
// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Minimal LLM wrapper
async function callLLM(prompt: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
  });
  return response.choices[0].message.content || '';
}

// --- shared state ---
const shared: any = { data: {}, summary: {} };

// --- load data node ---
class LoadData extends Node {
  async prep(shared: any): Promise<void> {
    const dataPath = path.join(__dirname, "../../../data/PaulGrahamEssaysLarge");
    const files = fs.readdirSync(dataPath);
    for (const fn of files) {
      const content = fs.readFileSync(path.join(dataPath, fn), "utf-8");
      shared.data[fn] = content;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async exec(res: any): Promise<void> { }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async post(s: any, prepRes: any, execRes: any): Promise<void> { }
}

// --- summarize one file ---
class SummarizeFile extends Node {
  async prep(s: any): Promise<string> {
    return s.data[this.params.filename];
  }
  async exec(content: string): Promise<string> {
    return await callLLM(`${content} Summarize in 10 words.`);
  }
  async post(s: any, prepRes: any, sr: any): Promise<void> {
    s.summary[this.params.filename] = sr;
  }
}

// --- map-reduce summarization ---
class MapSummaries extends BatchNode {
  async prep(s: any): Promise<string[]> {
    const text: string = s.data[this.params.filename];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 10000) {
      chunks.push(text.substring(i, i + 10000));
    }
    return chunks;
  }
  async exec(chunk: string): Promise<string> {
    return await callLLM(`${chunk} Summarize in 10 words.`);
  }
  async post(s: any, prepRes: any, er: any): Promise<void> {
    s.summary[this.params.filename] = er.map(
      (r: any, i: number) => `${i}. ${r}`
    );
  }
}

class ReduceSummaries extends Node {
  async prep(s: any): Promise<any> {
    return s.summary[this.params.filename];
  }
  async exec(chunks: any): Promise<string> {
    return await callLLM(`${chunks} Combine into 10 words summary.`);
  }
  async post(s: any, prepRes: any, sr: any): Promise<void> {
    s.summary[this.params.filename] = sr;
  }
}

// --- QA agent ---
class FindRelevantFile extends Node {
  async prep(s: any): Promise<{ q: string; filenames: string[]; fileSummaries: string[] }> {
    const q = readlineSync.question("Enter a question: ");
    const filenames = Object.keys(s.summary);
    const fileSummaries = filenames.map(fn => `- '${fn}': ${s.summary[fn]}`);
    return { q, filenames, fileSummaries };
  }
  async exec(p: any): Promise<any> {
    const { q, filenames, fileSummaries } = p;
    if (!q) return { think: "no question", has_relevant: false };
    const prompt = `
Question: ${q}
Find the most relevant file from:
${fileSummaries.join("\n")}
If none, explain why

Output in code fence:
\`\`\`yaml
think: >
    reasoning about relevance
has_relevant: true/false
most_relevant: filename if relevant
\`\`\`
`;
    const resp = await callLLM(prompt);
    const m = resp.match(/```yaml([\s\S]*?)```/);
    if (!m) throw new Error("no yaml block found");
    const yamlStr = m[1].trim();
    const result: any = yaml.load(yamlStr);
    if (!result || typeof result !== "object")
      throw new Error("invalid yaml response");
    if (!("think" in result) || !("has_relevant" in result))
      throw new Error("missing keys in response");
    if (result.has_relevant) {
      if (!("most_relevant" in result) || !filenames.includes(result.most_relevant))
        throw new Error("invalid most_relevant value");
    }
    return result;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async execFallback(p: any, exc: any): Promise<any> {
    return { think: "error", has_relevant: false };
  }
  async post(s: any, prepRes: any, res: any): Promise<string> {
    const { q } = prepRes;
    if (!q) {
      console.log("no question asked");
      return "end";
    }
    if (res.has_relevant) {
      s.question = q;
      s.relevant_file = res.most_relevant;
      console.log("relevant file:", res.most_relevant);
      return "answer";
    } else {
      console.log("no relevant file:", res.think);
      return "retry";
    }
  }
}

class AnswerQuestion extends Node {
  async prep(s: any): Promise<{ question: string; text: string }> {
    return { question: s.question, text: s.data[s.relevant_file] };
  }
  async exec(p: any): Promise<string> {
    const { question, text } = p;
    return await callLLM(`Question: ${question}\nText: ${text}\nAnswer in 50 words.`);
  }
  async post(s: any, prepRes: any, ex: any): Promise<void> {
    console.log("answer:", ex);
  }
}

class NoOp extends Node { }

// --- main orchestration ---
(async () => {
  // load data
  await new LoadData().run(shared);

  // summarize one file
  const nodeSumm = new SummarizeFile();
  nodeSumm.setParams({ filename: "addiction.txt" });
  await nodeSumm.run(shared);

  // map-reduce summarization
  const mapSumm = new MapSummaries();
  const reduceSumm = new ReduceSummaries();
  mapSumm.connect(reduceSumm); // default transition
  const flow = new Flow(mapSumm);
  flow.setParams({ filename: "before.txt" });
  await flow.run(shared);

  // summarize all files (batch flow)
  class SummarizeAllFiles extends BatchFlow {
    async prep(s: any): Promise<any[]> {
      return Object.keys(s.data).map(fn => ({ filename: fn }));
    }
  }
  await new SummarizeAllFiles(flow).run(shared);

  // QA agent chaining
  const frf = new FindRelevantFile(3);
  const aq = new AnswerQuestion();
  const noop = new NoOp();
  frf.transition("answer").to(aq);
  aq.connect(frf);
  frf.transition("retry").to(frf);
  frf.transition("end").to(noop);
  const qa = new Flow(frf);
  await qa.run(shared);
})();

