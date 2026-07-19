import { Flow, Node } from "@pocketflow/core";
import dotenv from 'dotenv';
import { OpenAI } from "openai";
import * as path from 'path';
import * as readline from 'readline';

dotenv.config({
  path: path.join(__dirname, "../../../.env"),
});

// Create readline interface for human input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const askQuestion = (query: string): Promise<string> => {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer);
    });
  });
};

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function callLLM(prompt: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
  });
  return response.choices[0].message.content || '';
}

// Human player node that provides clues
class HumanClueGiver extends Node {
  async prep(shared: any): Promise<any> {
    return {
      target: shared.target_word,
      forbidden: shared.forbidden_words,
      guesses: shared.past_guesses || []
    };
  }

  async exec(inputs: any): Promise<any> {
    console.log("\n=== Your Turn to Give a Clue ===");
    console.log(`Target word: ${inputs.target}`);
    console.log(`Forbidden words: ${inputs.forbidden.join(", ")}`);
    if (inputs.guesses.length > 0) {
      console.log(`Previous guesses: ${inputs.guesses.join(", ")}`);
    }

    const clue = await askQuestion("Enter your clue (max 5 words): ");
    return clue.trim();
  }

  async post(shared: any, _prep: any, clue: any): Promise<any> {
    shared.current_clue = clue;
    return "next";
  }
}

// AI agents that try to guess based on human clues
class AIGuesser extends Node {
  name: string;

  constructor(name: string) {
    super();
    this.name = name;
  }

  async prep(shared: any): Promise<any> {
    return {
      clue: shared.current_clue,
      pastGuesses: shared.past_guesses || []
    };
  }

  async exec(inputs: any): Promise<any> {
    const prompt = `You are playing a word guessing game. Make a single word guess based on this information:
Current clue: "${inputs.clue}"
Previous wrong guesses: ${inputs.pastGuesses.join(", ") || "none"}

Important: Your response should be exactly one word, no punctuation or explanation.`;
    
    const guess = await callLLM(prompt);
    console.log(`\n${this.name} guesses: ${guess}`);
    return guess.trim().toLowerCase();
  }

  async post(shared: any, _prep: any, guess: string): Promise<any> {
    if (guess === shared.target_word.toLowerCase()) {
      console.log(`\n🎉 ${this.name} wins! The word was: ${shared.target_word}`);
      return "end";
    }

    if (!shared.past_guesses) {
      shared.past_guesses = [];
    }
    shared.past_guesses.push(guess);
    
    const feedback = await askQuestion("\nRate this guess (1-10): ");
    shared.last_rating = parseInt(feedback, 10);
    
    return "next";
  }
}

// Moderator that provides feedback and controls flow
class Moderator extends Node {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async exec(inputs: any): Promise<any> {
    if (this.params.last_rating > 7) {
      console.log("\n👍 Getting very close! Keep going!");
    } else if (this.params.last_rating > 4) {
      console.log("\n🤔 On the right track...");
    } else {
      console.log("\n❌ Way off! Try a different approach.");
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async post(shared: any, prepRes: any, execRes: any): Promise<any> {
    return "next";
  }
}

async function main() {
  const shared = {
    target_word: "democracy",
    forbidden_words: ["vote", "government", "people", "election", "politics"],
    past_guesses: [],
    current_clue: "",
    last_rating: 0
  };

  console.log("\n=== Word Guessing Game with AI Agents ===");
  console.log("You'll give clues, AI agents will guess!");
  console.log("Rate their guesses to help them learn.");
  
  const human = new HumanClueGiver();
  const agent1 = new AIGuesser("Agent Alpha");
  const agent2 = new AIGuesser("Agent Beta");
  const moderator = new Moderator();

  // Create the game loop
  human
    .transition("next").to(agent1)
    .transition("next").to(moderator)
    .transition("next").to(agent2)
    .transition("next").to(moderator)
    .transition("next").to(human);

  agent1
    .transition("next").to(moderator)
    .transition("end").to(moderator);

  agent2
    .transition("next").to(moderator)
    .transition("end").to(moderator);

  moderator
    .transition("next").to(human);

  const flow = new Flow(human);
  await flow.run(shared);

  rl.close();
  process.exit(0);
}

main().catch(console.error);