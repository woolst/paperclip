import { describe, expect, it } from "vitest";
import { prepareCommandManagedRuntime } from "./command-managed-runtime.js";
import { startAdapterExecutionTargetPaperclipBridge } from "./execution-target.js";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";
import { createTarballFromDirectory, mirrorDirectory, prepareSandboxManagedRuntime } from "./sandbox-managed-runtime.js";
import { materializePaperclipSkillCopy } from "./server-utils.js";
import { prepareWorkspaceForSshExecution, restoreWorkspaceFromSshExecution, syncDirectoryFromSsh, syncDirectoryToSsh } from "./ssh.js";

// Fork: each function that copies files for a run refuses before it touches a file or opens a connection.
const REFUSAL = /^Fork: Paperclip never copies files for a run \(.+ is disabled\)\.$/;
const spec = { host: "unused.invalid", port: 22, username: "x", remoteCwd: "/srv", privateKey: null, knownHosts: null, strictHostKeyChecking: false };

describe("the copy functions of the adapters refuse", () => {
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["syncDirectoryToSsh", () => syncDirectoryToSsh({ spec, localDir: "/nonexistent", remoteDir: "/srv/x" } as never)],
    ["syncDirectoryFromSsh", () => syncDirectoryFromSsh({ spec, localDir: "/nonexistent", remoteDir: "/srv/x" } as never)],
    ["prepareWorkspaceForSshExecution", () => prepareWorkspaceForSshExecution({ spec, localDir: "/nonexistent" } as never)],
    ["restoreWorkspaceFromSshExecution", () => restoreWorkspaceFromSshExecution({ spec, localDir: "/nonexistent" } as never)],
    ["prepareRemoteManagedRuntime", () => prepareRemoteManagedRuntime({ spec, adapterKey: "claude", workspaceLocalDir: "/nonexistent" } as never)],
    ["prepareCommandManagedRuntime", () => prepareCommandManagedRuntime({ spec: { remoteCwd: "/srv" }, adapterKey: "claude" } as never)],
    ["materializePaperclipSkillCopy", () => materializePaperclipSkillCopy("/nonexistent/a", "/nonexistent/b")],
    ["prepareSandboxManagedRuntime", () => prepareSandboxManagedRuntime({ spec: { remoteCwd: "/srv" } } as never)],
    ["mirrorDirectory", () => mirrorDirectory("/nonexistent/a", "/nonexistent/b")],
    ["createTarballFromDirectory", () => createTarballFromDirectory({ localDir: "/nonexistent", archivePath: "/nonexistent.tgz" })],
    ["startAdapterExecutionTargetPaperclipBridge", () => startAdapterExecutionTargetPaperclipBridge({
      runId: "r", target: { kind: "remote", transport: "ssh", remoteCwd: "/srv", spec } } as never)],
  ];
  for (const [name, call] of calls) {
    it(name, async () => {
      await expect(call()).rejects.toThrow(REFUSAL);
    });
  }

  it("leaves a run with no remote target alone at the bridge", async () => {
    expect(await startAdapterExecutionTargetPaperclipBridge({ runId: "r", target: null } as never)).toBeNull();
  });
});
