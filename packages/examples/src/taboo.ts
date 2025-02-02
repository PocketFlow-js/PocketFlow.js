import { Flow, Node } from "@pocketflow/core";
import dotenv from 'dotenv';
import { OpenAI } from "openai";
import * as path from 'path';

dotenv.config({
  path: path.join(__dirname, "../../../.env"),
});

// --- A simple asynchronous queue implementation ---
class AsyncQueue {
  private _queue: any[];
  private _resolvers: ((value: any) => void)[];
  constructor() {
    this._queue = [];
    this._resolvers = [];
  }
  
  put(item: any) {
    if (this._resolvers.length > 0) {
      const resolve = this._resolvers.shift()!;
      resolve(item);
    } else {
      this._queue.push(item);
    }
  }
  
  get(): Promise<any> {
    if (this._queue.length > 0) {
      return Promise.resolve(this._queue.shift());
    } else {
      return new Promise((resolve) => {
        this._resolvers.push(resolve);
      });
    }
  }
}

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --- callLLM() function ---
// In a real application this would call your language model.
async function callLLM(prompt: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o', // or your chosen model
    messages: [{ role: 'user', content: prompt }],
  });
  return response.choices[0].message.content || '';
}

// --- Hinter node ---
// Waits for a “guess” from the hinter_queue, then generates a hint.
class Hinter extends Node {
  async prep(shared: any): Promise<any> {
    const guess = await shared.hinter_queue.get();
    if (guess === "GAME_OVER") {
      return null;
    }
    // Return target, forbidden words, and past guesses.
    return [shared.target_word, shared.forbidden_words, shared.past_guesses || []];
  }
  
  async exec(inputs: any): Promise<any> {
    if (inputs === null) return null;
    const [target, forbidden, past_guesses] = inputs;
    let prompt = `Generate hint for '${target}'\nForbidden words: ${forbidden.join(", ")}`;
    if (past_guesses.length > 0) {
      prompt += `\nPrevious wrong guesses: ${past_guesses.join(", ")}\nMake hint more specific.`;
    }
    prompt += "\nUse at most 5 words.";
    
    const hint = await callLLM(prompt);
    console.log(`\nHinter: Here's your hint - ${hint}`);
    return hint;
  }
  
  async post(shared: any, _prepRes: any, execRes: any): Promise<any> {
    if (execRes === null) return "end";
    // Send the hint to the guesser.
    shared.guesser_queue.put(execRes);
    return "continue";
  }
}

// --- Guesser node ---
// Waits for a hint from the guesser_queue, then makes a guess.
class Guesser extends Node {
  async prep(shared: any): Promise<any> {
    const hint = await shared.guesser_queue.get();
    return [hint, shared.past_guesses || []];
  }
  
  async exec(inputs: any): Promise<any> {
    const [hint, past_guesses] = inputs;
    const prompt = `Given hint: ${hint}, past wrong guesses: ${past_guesses.join(", ")}, make a new guess. Directly reply a single word:`;
    const guess = await callLLM(prompt);
    console.log(`Guesser: I guess it's - ${guess}`);
    return guess;
  }
  
  async post(shared: any, _prepRes: any, execRes: any): Promise<any> {
    // Check for correct guess (case insensitive)
    if (execRes.toLowerCase() === shared.target_word.toLowerCase()) {
      console.log("Game Over - Correct guess!");
      // Inform the hinter to stop.
      shared.hinter_queue.put("GAME_OVER");
      return "end";
    }
    // Save wrong guess.
    if (!shared.past_guesses) {
      shared.past_guesses = [];
    }
    shared.past_guesses.push(execRes);
    // Forward the guess (as context) to the hinter.
    shared.hinter_queue.put(execRes);
    return "continue";
  }
}

class NoOp extends Node { }

// --- Main function ---
async function main() {
  // Shared state for the game.
  const shared = {
    target_word: "abomination",
    forbidden_words: ["disgusting", "disturbing", "unpleasant", "dislike", "discomforting"],
    hinter_queue: new AsyncQueue(),
    guesser_queue: new AsyncQueue(),
    past_guesses: []
  };
  
  console.log("Game starting!");
  console.log(`Target word: ${shared.target_word}`);
  console.log(`Forbidden words: ${shared.forbidden_words.join(", ")}`);
  
  // Kick off the process by sending an initial empty message to the hinter.
  shared.hinter_queue.put("");
  
  // Create the nodes.
  const hinter = new Hinter();
  const guesser = new Guesser();
  const noop = new NoOp();
  
  // IMPORTANT: Attach self-loop transitions directly to the nodes.
  hinter.transition("continue").to(hinter);
  guesser.transition("continue").to(guesser);
  hinter.transition("end").to(noop);
  guesser.transition("end").to(noop);
  
  // Create flows using the nodes as the starting points.
  const hinterFlow = new Flow(hinter);
  const guesserFlow = new Flow(guesser);
  
  // Run both flows concurrently.
  await Promise.all([
    hinterFlow.run(shared),
    guesserFlow.run(shared)
  ]);
}

// Run the main function.
main().catch(err => console.error(err));
