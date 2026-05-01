/* ============================================================
 * api.js — the messages array, the agent loop
 * ============================================================
 *
 * Everything interesting about an AI chat product happens in this file.
 * It is ~100 lines and contains the entire mental model:
 *
 *   (1) build the messages array
 *   (2) send it to Claude
 *   (3) if Claude asked for a tool, run it and loop back to (2)
 *   (4) otherwise, return Claude's final answer
 *
 * That's all of Claude Code. That's all of Claude.ai. Every AI chat
 * product you've used is this loop with a different UI bolted on top.
 * ============================================================
 */

const fs = require("node:fs");
const path = require("node:path");
const Anthropic = require("@anthropic-ai/sdk");
const { toolDefinitions, handleToolCall } = require("./tools");

// The model ID is the ONLY thing that changes to use a different Claude.
// Named constant so students can spot it and swap it without digging.
const MODEL = "claude-sonnet-4-6";

// Hard cap on how many times we'll loop in a single /chat request.
//
// Every iteration is a real API call that costs real money. Without a cap,
// a bug in a tool handler (or a stubborn prompt) can send Claude into a
// spin that racks up charges by the second. The cap is not a limitation —
// it is a deliberate budget. Raise it only when you understand why.
const MAX_ITERATIONS = 10;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });


/* ------------------------------------------------------------
 * loadSystemPrompt — where CLAUDE.md actually lives
 * ------------------------------------------------------------
 * CLAUDE.md "isn't magic." It's a text file we read off disk and prepend
 * to the system prompt on every request. If there's no CLAUDE.md in the
 * user's current working directory, Claude falls back to base instructions.
 *
 * Loading it on every call (instead of once at startup) means students can
 * edit CLAUDE.md and see the change take effect on their next message.
 */
function loadSystemPrompt() {
  const base =
    "You are devlens, an AI assistant embedded in the user's project directory. " +
    "You have tools for reading files, writing files, running shell commands, " +
    "and listing directories. When the user asks a question that depends on the " +
    "contents of the codebase, use the tools — do not guess.";

  const claudeMdPath = path.resolve(process.cwd(), "CLAUDE.md");
  if (!fs.existsSync(claudeMdPath)) return base;

  const claudeMd = fs.readFileSync(claudeMdPath, "utf-8");
  return `${base}\n\n--- Project context (from CLAUDE.md) ---\n${claudeMd}`;
}


/* ------------------------------------------------------------
 * chat — one turn in a devlens conversation
 * ------------------------------------------------------------
 * Called from /chat in index.js with the new user message and the full
 * conversation history so far. Returns: the new history (for the browser
 * to send back next time), the final reply, and a trace of every step
 * that happened in between (for the UI to render).
 */
async function chat(userMessage, history) {
  // THE MESSAGES ARRAY.
  // This is the entire state of a Claude conversation. Every turn — user
  // message, assistant response, tool results — is one element of this
  // array. Nothing else is persisted across iterations. Claude has no
  // memory outside of what is in here, right now.
  const messages = [...history, { role: "user", content: userMessage }];

  // The trace is for the UI, not for the API. An in-order log of text,
  // tool calls, and tool results so students can watch the loop happen.
  const trace = [];

  // THE AGENT LOOP.
  // One API call per iteration. Claude decides what to do next; we decide
  // whether to keep asking. The loop ends when (a) Claude stops requesting
  // tools, or (b) we hit MAX_ITERATIONS. That's it. No "agent framework"
  // underneath — this while loop IS the agent framework.
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: loadSystemPrompt(),
      tools: toolDefinitions,
      messages,
    });

    // HISTORY ACCUMULATION.
    // Push Claude's full response (text + tool_use blocks) onto the array.
    // This is what lets Claude chain decisions: on the next iteration it
    // can see "I asked to read foo.js, and here's what came back." Without
    // this append, every iteration would start from a blank slate.
    messages.push({ role: "assistant", content: response.content });

    for (const block of response.content) {
      if (block.type === "text") {
        trace.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        trace.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      }
    }

    // Did Claude ask for any tools? If not, the turn is over.
    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      const reply = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return { reply, history: messages, trace, iterations: i + 1 };
    }

    // Claude asked for one or more tools. Run each through the handler in
    // tools.js, collect the results into a single user-role message, and
    // loop. The `tool_use_id` is what links each result back to its request.
    const toolResults = [];
    for (const block of toolUses) {
      const result = await handleToolCall(block.name, block.input);
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      trace.push({ type: "tool_result", tool_use_id: block.id, name: block.name, content: result });
    }
    messages.push({ role: "user", content: toolResults });
  }

  // Hit the cap. Be honest with the user about what happened.
  return {
    reply: `(Stopped after ${MAX_ITERATIONS} iterations — Claude kept asking for tools. Task may be incomplete. Raise MAX_ITERATIONS in api.js if this is expected.)`,
    history: messages,
    trace,
    iterations: MAX_ITERATIONS,
  };
}

module.exports = { chat };
