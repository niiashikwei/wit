/**
 * The dashboard's web server: the page, a JSON API over the same questions as the MCP server, and
 * a live stream that says when something new was written (Server-Sent Events, pushed as Claude
 * Code writes its transcripts). It listens on 127.0.0.1 only and answers only requests addressed
 * to localhost, so other machines and other web pages can't read it.
 */
import { existsSync, readFileSync, watch,                } from "node:fs";
import { createServer,                                           } from "node:http";
import { join } from "node:path";
import { answer, project, refresh, TOOLS } from "./api.js";
import { logDirs, projectDirs } from "./paths.js";

/** The page: web/dashboard.html next to src/ (or dist/). */
export function pagePath()         {
  for (const p of [
    join(import.meta.dirname, "..", "web", "dashboard.html"),
    join(import.meta.dirname, "..", "..", "web", "dashboard.html"),
  ])
    if (existsSync(p)) return p;
  throw new Error("web/dashboard.html is missing");
}

/** Whether a request is addressed to this machine: blocks DNS-rebinding pages from reading the API. */
export function localHost(host                    , port        )          {
  if (!host) return false;
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase());
}

/** The tool input from a query string: plain params, and `kind`, `name`, `session`… as given. */
export function inputOf(url     )                          {
  const input                          = {};
  for (const [k, v] of url.searchParams) if (v !== "") input[k] = v;
  return input;
}

                                                    

                               
               
               
                                          
                      
 

export function serveWeb(opts              ) {
  const clients = new Set        ();
  const watchers = new Map                     ();
  const timers = new Map                        ();

  /** Reads what's new for a project and tells its open pages. */
  const push = (root        ) => {
    let lines = 0;
    try {
      lines = refresh(project(root), 0);
    } catch {
      return;
    }
    const msg = `event: changed\ndata: ${JSON.stringify({ lines, at: Date.now() })}\n\n`;
    for (const c of clients) if (c.root === root) c.res.write(msg);
  };
  const soon = (root        ) => {
    clearTimeout(timers.get(root));
    timers.set(
      root,
      setTimeout(() => push(root), opts.debounceMs ?? 750),
    );
  };
  /** Watches the project's transcript folders and hook logs once, for as long as a page is open. */
  const watchProject = (root        ) => {
    if (watchers.has(root)) return;
    const list              = [];
    for (const dir of [...projectDirs(root), ...logDirs(root)])
      try {
        list.push(watch(dir, { recursive: true }, () => soon(root)));
      } catch {
        /* a folder that vanished: the poll below still catches up */
      }
    watchers.set(root, list);
  };
  const unwatch = (root        ) => {
    if ([...clients].some((c) => c.root === root)) return;
    for (const w of watchers.get(root) ?? []) w.close();
    watchers.delete(root);
  };
  // A slow poll as well: fs.watch can miss events (network drives, some Linux setups).
  const poll = setInterval(() => {
    for (const root of new Set([...clients].map((c) => c.root))) push(root);
  }, 15_000);
  const beat = setInterval(() => {
    for (const c of clients) c.res.write(": keep-alive\n\n");
  }, 25_000);

  const send = (res                , status        , body        , type = "application/json") => {
    res.writeHead(status, {
      "content-type": `${type}; charset=utf-8`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(body);
  };

  const server = createServer((req                 , res                ) => {
    const port = (server.address()                           )?.port ?? opts.port;
    if (!localHost(req.headers.host, port)) return send(res, 403, '{"error":"localhost only"}');
    if (req.method !== "GET") return send(res, 405, '{"error":"GET only"}');
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/" || url.pathname === "/index.html")
      return send(res, 200, readFileSync(pagePath(), "utf8"), "text/html");
    if (url.pathname === "/api/stream") {
      const root = project(url.searchParams.get("project") || opts.root).root;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ root })}\n\n`);
      const c = { res, root };
      clients.add(c);
      watchProject(root);
      req.on("close", () => {
        clients.delete(c);
        unwatch(root);
      });
      return;
    }
    const m = url.pathname.match(/^\/api\/([a-z_]+)$/);
    if (m) {
      const name = m[1] .startsWith("morpheus_") ? m[1]  : `morpheus_${m[1]}`;
      if (!TOOLS.some((t) => t.name === name)) return send(res, 404, '{"error":"no such tool"}');
      try {
        return send(res, 200, JSON.stringify(answer(name, inputOf(url), { root: opts.root })));
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: (e         ).message }));
      }
    }
    return send(res, 404, '{"error":"not found"}');
  });
  server.on("close", () => {
    clearInterval(poll);
    clearInterval(beat);
    for (const list of watchers.values()) for (const w of list) w.close();
  });
  return new Promise               ((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port, "127.0.0.1", () => ok(server));
  });
}
