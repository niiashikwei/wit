/**
 * The project's own settings for Wit's SDLC views, from an optional `.claude/wit.json`. Every key
 * is optional and has a default that works for most repositories; unknown keys are ignored and a
 * value of the wrong type falls back to its default, so a typo never breaks the dashboard.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

                                 
               
                                                                                                 
                 
 

                            
     
                                                                                           
                                                                                               
                                            
     
                 
                                                                                  
                            
                                                                                                  
              
                                                          
                        
                                                                                            
                             
                                                                                        
                                   
                                                         
                                     
                                                               
                                    
                                          
                        
                                                                      
                        
 

export const DEFAULTS            = {
  deploy: "main",
  mainBranch: null,
  gh: false,
  incidentLabel: "incident",
  failureWindowHours: 72,
  layers: {},
  features: {},
  coverageReports: [],
  testReports: [],
  sampleSeconds: 5,
};

const isGlobMap = (v         )                                =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.values(v).every((g) => Array.isArray(g) && g.every((x) => typeof x === "string"));

/** Merges a parsed wit.json over the defaults, keeping only values of the right shape. */
export function normalise(raw         )            {
  const c                          = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw         ) : {};
  const out            = { ...DEFAULTS };
  if (typeof c.deploy === "string" && /^(main|tag:.+|gh-deployments|gh-workflow:.+)$/.test(c.deploy))
    out.deploy = c.deploy;
  if (typeof c.mainBranch === "string" && c.mainBranch) out.mainBranch = c.mainBranch;
  if (typeof c.gh === "boolean") out.gh = c.gh;
  if (typeof c.incidentLabel === "string" && c.incidentLabel) out.incidentLabel = c.incidentLabel;
  if (typeof c.failureWindowHours === "number" && c.failureWindowHours > 0)
    out.failureWindowHours = c.failureWindowHours;
  if (isGlobMap(c.layers)) out.layers = c.layers;
  if (isGlobMap(c.features)) out.features = c.features;
  if (Array.isArray(c.coverageReports))
    out.coverageReports = c.coverageReports.flatMap((r) =>
      typeof r === "string"
        ? [{ path: r }]
        : r && typeof r === "object" && typeof r.path === "string"
          ? [{ path: r.path, ...(typeof r.layer === "string" ? { layer: r.layer } : {}) }]
          : [],
    );
  if (Array.isArray(c.testReports)) out.testReports = c.testReports.filter((r) => typeof r === "string");
  if (typeof c.sampleSeconds === "number" && c.sampleSeconds >= 1) out.sampleSeconds = c.sampleSeconds;
  return out;
}

/** The project's settings: `.claude/wit.json` over the defaults. */
export function loadConfig(root        )            {
  try {
    return normalise(JSON.parse(readFileSync(join(root, ".claude", "wit.json"), "utf8")));
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * A glob as a regular expression over forward-slash paths: `**` any folders, `*` within one
 * folder, `?` one character, `{a,b}` either. A glob without a slash matches the file name anywhere.
 */
export function globRe(glob        )         {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ;
    if (ch === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else if (ch === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${glob.slice(i + 1, end).split(",").map(escape).join("|")})`;
        i = end;
      }
    } else re += escape(ch);
  }
  return new RegExp(glob.includes("/") ? `^${re}$` : `(?:^|/)${re}$`);
}
const escape = (s        ) => s.replace(/[.+^$()|[\]\\]/g, "\\$&");

export const matches = (path        , globs          ) => globs.some((g) => globRe(g).test(path));
