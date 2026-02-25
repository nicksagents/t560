import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assertExecCommandAllowed } from "../src/agents/self-protection.ts";

test("self protection blocks power-control exec commands", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "t560-power-"));
  const installRoot = path.join(workspaceDir, "install");
  await mkdir(installRoot, { recursive: true });
  const policy = {
    enabled: true,
    installRoot,
    protectedPaths: [{ raw: ".", absolute: installRoot }],
  };

  assert.throws(
    () =>
      assertExecCommandAllowed({
        command: "shutdown -h now",
        cwd: installRoot,
        policy,
      }),
    /power-control commands/i,
  );
  assert.throws(
    () =>
      assertExecCommandAllowed({
        command: "sudo reboot",
        cwd: installRoot,
        policy,
      }),
    /power-control commands/i,
  );
  assert.throws(
    () =>
      assertExecCommandAllowed({
        command: "systemctl poweroff",
        cwd: installRoot,
        policy,
      }),
    /power-control commands/i,
  );

  assert.doesNotThrow(() =>
    assertExecCommandAllowed({
      command: "echo safe",
      cwd: installRoot,
      policy,
    }),
  );
});

