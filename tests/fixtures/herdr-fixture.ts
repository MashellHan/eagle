import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrProvider } from "../../packages/agent/herdr-provider.ts";
export function herdrFixture(t: { after: (cleanup: () => void) => void }) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "eagle-herdr-provider-")),
  );
  const directory = join(root, "private");
  mkdirSync(directory, { mode: 0o700 });
  const configPath = join(directory, "agent.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      machineId: "herdr-mac",
      machineName: "Herdr fixture",
      url: "https://fixture.example.test",
      token: "isolated-herdr-machine-at-least-32-characters",
    }),
    { mode: 0o600 },
  );
  const binary = join(root, "fixture-herdr");
  const calls = join(root, "calls.jsonl");
  const state = join(root, "running");
  const createdSession = join(root, "created-session");
  const serverPid = join(root, "server-pid");
  writeFileSync(state, "running");
  writeFileSync(
    binary,
    `#!${process.execPath}
import {appendFileSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,nested:process.env.HERDR_ENV??null,secret:process.env.EAGLE_TEST_EXTRA??null})+'\\n');
if(args[0]==='--version') { console.log('herdr 0.9.5'); process.exit(0); }
const created=existsSync(${JSON.stringify(createdSession)})?readFileSync(${JSON.stringify(createdSession)},'utf8'):null;
if(args[0]==='session'&&args[1]==='list') {console.log(JSON.stringify({sessions:[{name:'default',running:true},{name:'work',running:readFileSync(${JSON.stringify(state)},'utf8')==='running'},...(created?[{name:created,running:true}]:[])]}));process.exit(0);}
if(args[0]==='--session'&&args[2]==='server') {writeFileSync(${JSON.stringify(serverPid)},String(process.pid));writeFileSync(${JSON.stringify(createdSession)},args[1]);setInterval(()=>{},1000);await new Promise(()=>{});}
if(args[0]!=='--session'||(args[1]!=='work'&&args[1]!==created)) process.exit(2);
const command=args.slice(2).join(' ');
if(command==='status') {console.log('server:\\n  status: running\\n  endpoint_compatible: yes\\n  private_protocol_compatible: yes\\nupdate:\\n  server_binary_stale: no');process.exit(0);}
if(command==='agent list') {console.log(JSON.stringify({result:{type:'agent_list',agents:[{name:'fixture-worker',pane_id:'w1:p1'}]}}));process.exit(0);}
if(command==='workspace list') {console.log(JSON.stringify({result:{workspaces:[]}}));process.exit(0);}
if(command==='pane list') {console.log(JSON.stringify({result:{panes:[]}}));process.exit(0);}
process.exit(2);
`,
    { mode: 0o700 },
  );
  const invoke = async (
    provider: HerdrProvider,
    action:
      | "probe"
      | "install"
      | "verify"
      | "disable"
      | "configure"
      | "create_session",
    extra = {},
  ) => {
    const revision =
      action === "configure" ||
      action === "disable" ||
      action === "create_session"
        ? { expectedRevision: provider.capabilities().revision }
        : {};
    const result = await provider.run(
      {
        tool: "herdr.setup",
        action,
        ...revision,
        ...extra,
      } as import("../../packages/agent/herdr-provider.ts").HerdrRequest,
      AbortSignal.timeout(5000),
    );
    assert.equal(result.state, "succeeded");
    return JSON.parse(result.stdout);
  };
  t.after(() => {
    if (existsSync(serverPid)) {
      try {
        process.kill(Number(readFileSync(serverPid, "utf8")), "SIGTERM");
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    directory,
    configPath,
    binary,
    calls,
    state,
    invoke,
    serverPid,
    createdSession,
  };
}
