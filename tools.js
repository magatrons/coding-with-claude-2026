/* ============================================================
 * tools.js — Claude's toolbox for devlens
 * ============================================================
 *
 * THE BIG IDEA
 * ------------
 * Claude never actually *does* anything. It asks your code to do things.
 * This file is the boundary between what Claude decides and what your app
 * executes. It has two parts:
 *
 *   1. toolDefinitions — the menu of things Claude is allowed to ask for.
 *   2. handleToolCall  — the function that runs when Claude asks.
 *
 *
 * THE TOOL-USE CYCLE
 * ------------------
 * When a user sends a message in the devlens UI, this is the round trip:
 *
 *   (1) User  ──────"read package.json and tell me the name"──────▶ api.js
 *   (2) api.js sends the message to Claude, along with `toolDefinitions`
 *   (3) Claude thinks. It does NOT open any files. Instead it replies with
 *       a `tool_use` block that looks like this:
 *
 *           {
 *             "type": "tool_use",
 *             "id":   "toolu_01A...",
 *             "name": "read_file",
 *             "input": { "path": "package.json" }
 *           }
 *
 *   (4) api.js hands that block to `handleToolCall("read_file", {path:"package.json"})`
 *   (5) The matching handler runs on YOUR machine and returns a string.
 *   (6) api.js sends that string back to Claude as a `tool_result` block.
 *   (7) Claude reads the result and continues — maybe answering the user,
 *       maybe asking for another tool. Loop until Claude stops asking.
 *
 * Claude's "hands" are these handlers. Nothing outside this file is
 * reachable from Claude. If read_file isn't here, Claude cannot read files.
 * Your handler IS the permission system.
 * ============================================================
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const { exec } = require("node:child_process");
const { promisify } = require("node:util");

const execAsync = promisify(exec);


/* ============================================================
 * PART 1 — TOOL DEFINITIONS  (Claude's vocabulary)
 * ============================================================
 *
 * This array ships to Claude with every API request. It's how Claude knows
 * what's on the menu. Three fields per tool:
 *
 *   name         — the identifier Claude uses when asking ("read_file").
 *   description  — plain English written FOR CLAUDE. It's how Claude
 *                  decides whether to reach for this tool. Vague
 *                  descriptions lead to the wrong tool being picked.
 *   input_schema — JSON Schema describing the arguments. Claude fills this
 *                  in; the SDK validates the response against the schema
 *                  before it reaches you.
 *
 * Claude is only as capable as this list. Shrink the list, shrink Claude.
 */
const toolDefinitions = [
  {
    name: "read_file",
    description:
      "Read the full contents of a text file from the user's project directory. " +
      "Use this when you need to see what's inside a specific file before answering.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file from the project root, e.g. 'src/index.js'.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create a new file or overwrite an existing one with the given contents. " +
      "Use this when the user has asked you to make changes to a file.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path of the file to write.",
        },
        content: {
          type: "string",
          description: "The full text contents to write to the file.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the user's project directory and return its stdout and stderr. " +
      "Use this for things like running tests, checking git status, or installing packages.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to run, e.g. 'npm test'.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "list_files",
    description:
      "List the files and directories at a given path inside the project. " +
      "Use this to explore the structure of the codebase when you don't yet know what's there.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative directory path to list. Use '.' for the project root.",
        },
      },
      required: ["path"],
    },
  },
];


/* ============================================================
 * PART 2 — THE ROUTER
 * ============================================================
 *
 * When Claude returns a `tool_use` block, api.js pulls out the `name` and
 * `input` fields and calls this function. Its only job is to dispatch to
 * the right handler.
 *
 * This is the entire "magic" of tool use. There is no magic. It's a switch
 * statement. Claude said "read_file"; we call readFile. That's it.
 */
async function handleToolCall(name, input) {
  switch (name) {
    case "read_file":
      return await readFile(input.path);
    case "write_file":
      return await writeFile(input.path, input.content);
    case "run_command":
      return await runCommand(input.command);
    case "list_files":
      return await listFiles(input.path);
    default:
      // Claude asked for a tool we didn't define. This shouldn't happen —
      // Claude only knows about tools in `toolDefinitions` — but if it
      // does, tell Claude so it can recover on the next turn.
      return `Error: unknown tool "${name}".`;
  }
}


/* ============================================================
 * PART 3 — THE HANDLERS
 * ============================================================
 *
 * Each handler takes the arguments Claude supplied and returns a STRING.
 * That string becomes the `tool_result` Claude sees on its next turn.
 *
 * Whatever you return is Claude's entire understanding of what happened.
 * If you swallow an error silently, Claude thinks it succeeded. Be honest
 * in your return values — return error messages as strings, don't throw.
 */


// ------------------------------------------------------------
// write_file — THE FULLY-ANNOTATED REFERENCE HANDLER
// ------------------------------------------------------------
// Every other handler in this file follows the same shape:
//   (a) resolve + validate the path
//   (b) do the actual I/O work
//   (c) return a string that describes what happened
// Read this one carefully. The rest will feel familiar.
async function writeFile(filePath, content) {
  // (1) Resolve the path against the current working directory.
  //     `process.cwd()` is where the user launched the devlens CLI —
  //     their project root. `path.resolve` converts a relative path
  //     like "src/foo.js" into an absolute path on the real filesystem.
  const absolutePath = path.resolve(process.cwd(), filePath);

  // (2) Make sure Claude isn't trying to escape the project directory.
  //     Without this check, Claude could ask to write "../../etc/passwd".
  //     Remember: our handler IS the permission system. If we don't
  //     enforce the boundary here, nothing else will.
  if (!absolutePath.startsWith(process.cwd())) {
    return `Error: refused to write outside the project directory: ${filePath}`;
  }

  // (3) Do the actual work. `fs.writeFile` creates the file if it
  //     doesn't exist and overwrites it if it does. We `await` because
  //     filesystem operations are asynchronous in Node.
  try {
    await fs.writeFile(absolutePath, content, "utf-8");
  } catch (err) {
    // (4) If something goes wrong (no permission, missing parent
    //     directory, disk full), return the error AS A STRING. Claude
    //     will read it on the next turn and can recover — for example,
    //     by calling run_command to `mkdir -p` the parent directory.
    return `Error writing ${filePath}: ${err.message}`;
  }

  // (5) Return a confirmation string. This is exactly what Claude will
  //     see. Including the byte count gives Claude a signal to
  //     sanity-check that the write matched what it asked for.
  return `Successfully wrote ${content.length} bytes to ${filePath}.`;
}


// ------------------------------------------------------------
// read_file  (HANDS-ON: annotate each line, add error handling)
// ------------------------------------------------------------
// This is the student starting point. In the hands-on hour you'll:
//   • narrate each line in your own words as comments
//   • add handling for the case where the file doesn't exist, then
//     test by asking Claude to read a file that isn't there
async function readFile(filePath) {
  const absolutePath = path.resolve(process.cwd(), filePath);
  const content = await fs.readFile(absolutePath, "utf-8");
  return content;
}


// ------------------------------------------------------------
// run_command
// ------------------------------------------------------------
async function runCommand(command) {
  try {
    // Run the command in the project root. `execAsync` resolves with
    // the combined stdout/stderr of a successful command.
    const { stdout, stderr } = await execAsync(command, { cwd: process.cwd() });
    // Return both streams. Warnings often land on stderr even when the
    // command succeeded — Claude should see them.
    return `stdout:\n${stdout}\nstderr:\n${stderr}`;
  } catch (err) {
    // `exec` throws for any non-zero exit code. Forward everything so
    // Claude can read the failure (e.g. a failing test output) and
    // decide what to try next.
    return `Command failed (exit ${err.code}):\nstdout:\n${err.stdout ?? ""}\nstderr:\n${err.stderr ?? ""}`;
  }
}


// ------------------------------------------------------------
// list_files
// ------------------------------------------------------------
async function listFiles(dirPath) {
  const absolutePath = path.resolve(process.cwd(), dirPath);
  try {
    // `withFileTypes: true` gives us Dirent objects so we can tell
    // directories apart from files without a second stat() call.
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    // Mark directories with a trailing "/" so Claude can distinguish
    // them from files at a glance in the returned text.
    const formatted = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return formatted.join("\n");
  } catch (err) {
    return `Error listing ${dirPath}: ${err.message}`;
  }
}


/* ============================================================
 * EXPORTS
 * ============================================================
 * api.js imports these two names. Nothing else leaves this file —
 * the individual handlers are private, reachable only through the
 * router. That's intentional: it keeps the boundary small and
 * makes it obvious where "Claude asks" turns into "our code runs."
 */
module.exports = { toolDefinitions, handleToolCall };
