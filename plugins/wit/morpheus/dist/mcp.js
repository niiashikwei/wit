/**
 * Morpheus as an MCP server: MCP's stdio transport (newline-delimited JSON-RPC) with read-only
 * tools, so Claude, the Claude desktop app and claude.ai artifacts can ask it questions. Nothing
 * leaves your machine.
 */
import { createInterface } from "node:readline";
import { answer, TOOLS } from "./api.js";

const PROTOCOL = "2025-06-18";
export const VERSION = "0.1.0";

                       
                 
                              
                  
               
  

/** Answers one request; notifications get no answer. */
export function handle(
  msg         ,
  ctx                                                                     ,
) {
  const reply = (result         ) => ({ jsonrpc: "2.0"         , id: msg.id ?? null, result });
  const fail = (code        , message        ) => ({
    jsonrpc: "2.0"         ,
    id: msg.id ?? null,
    error: { code, message },
  });
  if (msg.id === undefined) return null;
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "morpheus", version: VERSION },
        instructions:
          "Read-only numbers about how a project's Claude Code hooks, skills, agents and tokens are running.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: true, openWorldHint: false },
        })),
      });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      try {
        const data = ctx.call(name, msg.params?.arguments ?? {});
        // MCP's structured result must be an object: a table (a list) goes back as text only.
        const structured =
          data && typeof data === "object" && !Array.isArray(data) ? data : undefined;
        return reply({
          content: [{ type: "text", text: JSON.stringify(data) }],
          ...(structured ? { structuredContent: structured } : {}),
        });
      } catch (e) {
        return reply({ content: [{ type: "text", text: (e         ).message }], isError: true });
      }
    }
    default:
      return fail(-32601, `Unknown method ${msg.method}`);
  }
}

/** Serves MCP on stdin/stdout for the project at `root`. */
export function serveMcp(
  root        ,
  input                        = process.stdin,
  output                        = process.stdout,
) {
  const call = (name        , args                         ) => answer(name, args, { root });
  const rl = createInterface({ input });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg         ;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
      );
      return;
    }
    const out = handle(msg, { call });
    if (out) output.write(`${JSON.stringify(out)}\n`);
  });
  return rl;
}
