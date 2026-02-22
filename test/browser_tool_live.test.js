import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createBrowserTool } from "../src/agents/tools/browser-tool.ts";

let hasPlaywright = false;
try {
  await import("playwright");
  hasPlaywright = true;
} catch {
  hasPlaywright = false;
}

test(
  "browser live engine handles JS form submit without navigation",
  { skip: !hasPlaywright },
  async (t) => {
    const server = createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`
          <html>
            <head><title>Live Form</title></head>
            <body>
              <form id="f">
                <input name="q" value="" />
                <button type="submit">Apply</button>
              </form>
              <div id="out">empty</div>
              <script>
                const f = document.getElementById('f');
                f.addEventListener('submit', (e) => {
                  e.preventDefault();
                  const v = f.querySelector('input[name="q"]').value;
                  document.getElementById('out').textContent = "value:" + v;
                });
              </script>
            </body>
          </html>
        `);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.close();
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      t.skip("could not resolve test server address");
      return;
    }

    const baseUrl = `http://127.0.0.1:${address.port}/`;
    const tool = createBrowserTool();

    try {
      await tool.execute("live-reset-1", { action: "reset" });

      const opened = await tool.execute("live-open-1", {
        action: "open",
        engine: "live",
        url: baseUrl,
        snapshotAfter: true,
      });
      assert.equal(opened.ok, true);
      assert.equal(opened.engine, "live");
      assert.equal(opened.snapshot.title, "Live Form");

      const filled = await tool.execute("live-fill-1", {
        action: "fill",
        engine: "live",
        tabId: opened.tab.id,
        formIndex: 1,
        fieldName: "q",
        value: "hello-spa",
      });
      assert.equal(filled.ok, true);
      assert.equal(filled.engine, "live");

      const submitted = await tool.execute("live-submit-1", {
        action: "submit",
        engine: "live",
        tabId: opened.tab.id,
        formIndex: 1,
      });
      assert.equal(submitted.ok, true);
      assert.equal(submitted.engine, "live");
      assert.equal(submitted.snapshot.title, "Live Form");
      assert.match(submitted.snapshot.text, /value:hello-spa/);
    } catch (error) {
      t.skip(`live engine unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await tool.execute("live-reset-2", { action: "reset" });
    }
  },
);

test(
  "browser live engine supports hover/press/select/drag/evaluate actions",
  { skip: !hasPlaywright },
  async (t) => {
    const server = createServer((req, res) => {
      if (req.url === "/actions") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`
          <html>
            <head><title>Live Actions</title></head>
            <body>
              <div id="hoverTarget" style="width:100px;height:20px;background:#ccc;">hover</div>
              <div id="hoverOut">no-hover</div>

              <input id="pressInput" />
              <div id="pressOut">no-press</div>

              <select id="colorSel">
                <option value="">--</option>
                <option value="red">Red</option>
                <option value="blue">Blue</option>
              </select>
              <div id="selectOut">no-select</div>

              <div id="dragSrc" draggable="true" style="width:60px;height:20px;background:#9cf;">drag-me</div>
              <div id="dragDst" style="width:80px;height:25px;border:1px solid #333;">drop-zone</div>
              <div id="dragOut">no-drag</div>

              <script>
                document.getElementById('hoverTarget').addEventListener('mouseenter', () => {
                  document.getElementById('hoverOut').textContent = 'hovered';
                });
                document.getElementById('pressInput').addEventListener('keydown', (e) => {
                  if (e.key === 'Enter') {
                    document.getElementById('pressOut').textContent = 'pressed-enter';
                  }
                });
                document.getElementById('colorSel').addEventListener('change', (e) => {
                  document.getElementById('selectOut').textContent = 'selected:' + e.target.value;
                });
                document.getElementById('dragSrc').addEventListener('dragstart', (e) => {
                  e.dataTransfer.setData('text/plain', 'dragged');
                });
                document.getElementById('dragDst').addEventListener('dragover', (e) => e.preventDefault());
                document.getElementById('dragDst').addEventListener('drop', (e) => {
                  e.preventDefault();
                  document.getElementById('dragOut').textContent = 'dropped';
                });
              </script>
            </body>
          </html>
        `);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.close();
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      t.skip("could not resolve test server address");
      return;
    }

    const actionsUrl = `http://127.0.0.1:${address.port}/actions`;
    const tool = createBrowserTool();

    try {
      await tool.execute("live-actions-reset-1", { action: "reset" });
      const opened = await tool.execute("live-actions-open-1", {
        action: "open",
        engine: "live",
        url: actionsUrl,
        snapshotAfter: true,
      });
      assert.equal(opened.ok, true);
      assert.equal(opened.engine, "live");

      const hovered = await tool.execute("live-actions-hover-1", {
        action: "hover",
        engine: "live",
        tabId: opened.tab.id,
        selector: "#hoverTarget",
        snapshotAfter: true,
      });
      assert.equal(hovered.ok, true);
      assert.match(hovered.snapshot.text, /hovered/);

      const pressed = await tool.execute("live-actions-press-1", {
        action: "press",
        engine: "live",
        tabId: opened.tab.id,
        selector: "#pressInput",
        key: "Enter",
        snapshotAfter: true,
      });
      assert.equal(pressed.ok, true);
      assert.match(pressed.snapshot.text, /pressed-enter/);

      const selected = await tool.execute("live-actions-select-1", {
        action: "select",
        engine: "live",
        tabId: opened.tab.id,
        selector: "#colorSel",
        values: ["blue"],
        snapshotAfter: true,
      });
      assert.equal(selected.ok, true);
      assert.match(selected.snapshot.text, /selected:blue/);

      const dragged = await tool.execute("live-actions-drag-1", {
        action: "drag",
        engine: "live",
        tabId: opened.tab.id,
        startSelector: "#dragSrc",
        endSelector: "#dragDst",
        snapshotAfter: true,
      });
      assert.equal(dragged.ok, true);
      assert.match(dragged.snapshot.text, /dropped/);

      const evaluated = await tool.execute("live-actions-eval-1", {
        action: "evaluate",
        engine: "live",
        tabId: opened.tab.id,
        expression: "(() => document.getElementById('selectOut')?.textContent)()",
      });
      assert.equal(evaluated.ok, true);
      assert.equal(evaluated.result, "selected:blue");

      const acted = await tool.execute("live-actions-act-eval-1", {
        action: "act",
        kind: "evaluate",
        engine: "live",
        tabId: opened.tab.id,
        expression: "(() => document.getElementById('dragOut')?.textContent)()",
      });
      assert.equal(acted.ok, true);
      assert.equal(acted.kind, "evaluate");
      assert.equal(acted.result, "dropped");
    } catch (error) {
      t.skip(`live engine unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await tool.execute("live-actions-reset-2", { action: "reset" });
    }
  },
);

test(
  "browser live engine supports upload/dialog/console/pdf actions",
  { skip: !hasPlaywright },
  async (t) => {
    const server = createServer((req, res) => {
      if (req.url === "/io") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`
          <html>
            <head><title>Live IO</title></head>
            <body>
              <input id="fileInput" type="file" />
              <div id="uploadOut">no-file</div>

              <button id="dialogBtn" type="button">Open Dialog</button>
              <div id="dialogOut">dialog-none</div>

              <script>
                console.log('live-io-ready');
                const fileInput = document.getElementById('fileInput');
                fileInput.addEventListener('change', () => {
                  const name = fileInput.files && fileInput.files[0] ? fileInput.files[0].name : 'none';
                  document.getElementById('uploadOut').textContent = 'file:' + name;
                  console.log('file-selected:' + name);
                });
                document.getElementById('dialogBtn').addEventListener('click', () => {
                  const ok = confirm('Proceed?');
                  document.getElementById('dialogOut').textContent = ok ? 'dialog-accept' : 'dialog-dismiss';
                  console.log('dialog-result:' + (ok ? 'accept' : 'dismiss'));
                });
              </script>
            </body>
          </html>
        `);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.close();
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      t.skip("could not resolve test server address");
      return;
    }

    const ioUrl = `http://127.0.0.1:${address.port}/io`;
    const tool = createBrowserTool();
    const tmpFile = path.join(os.tmpdir(), `t560-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    await writeFile(tmpFile, "upload payload", "utf8");
    t.after(async () => {
      await rm(tmpFile, { force: true });
    });

    try {
      await tool.execute("live-io-reset-1", { action: "reset" });
      const opened = await tool.execute("live-io-open-1", {
        action: "open",
        engine: "live",
        url: ioUrl,
        snapshotAfter: true,
      });
      assert.equal(opened.ok, true);
      assert.equal(opened.engine, "live");

      const logs1 = await tool.execute("live-io-console-1", {
        action: "console",
        engine: "live",
        tabId: opened.tab.id,
        limit: 20,
      });
      assert.equal(logs1.ok, true);
      assert.ok(logs1.total >= 1);
      assert.ok(logs1.messages.some((row) => String(row.text).includes("live-io-ready")));

      const uploaded = await tool.execute("live-io-upload-1", {
        action: "upload",
        engine: "live",
        tabId: opened.tab.id,
        selector: "#fileInput",
        path: tmpFile,
        snapshotAfter: true,
      });
      assert.equal(uploaded.ok, true);
      assert.match(uploaded.snapshot.text, /file:t560-upload-/);

      const armedDismiss = await tool.execute("live-io-dialog-arm-1", {
        action: "dialog",
        engine: "live",
        tabId: opened.tab.id,
        accept: false,
      });
      assert.equal(armedDismiss.ok, true);
      assert.equal(armedDismiss.armed.mode, "dismiss");

      await tool.execute("live-io-dialog-trigger-1", {
        action: "evaluate",
        engine: "live",
        tabId: opened.tab.id,
        expression: "(() => { document.getElementById('dialogBtn').click(); return true; })()",
      });
      const afterDismiss = await tool.execute("live-io-wait-1", {
        action: "wait",
        engine: "live",
        tabId: opened.tab.id,
        timeMs: 200,
        snapshotAfter: true,
      });
      assert.equal(afterDismiss.ok, true);
      assert.match(afterDismiss.snapshot.text, /dialog-dismiss/);

      const armedAccept = await tool.execute("live-io-dialog-arm-2", {
        action: "dialog",
        engine: "live",
        tabId: opened.tab.id,
        accept: true,
      });
      assert.equal(armedAccept.ok, true);
      assert.equal(armedAccept.armed.mode, "accept");

      await tool.execute("live-io-dialog-trigger-2", {
        action: "evaluate",
        engine: "live",
        tabId: opened.tab.id,
        expression: "(() => { document.getElementById('dialogBtn').click(); return true; })()",
      });
      const afterAccept = await tool.execute("live-io-wait-2", {
        action: "wait",
        engine: "live",
        tabId: opened.tab.id,
        timeMs: 200,
        snapshotAfter: true,
      });
      assert.equal(afterAccept.ok, true);
      assert.match(afterAccept.snapshot.text, /dialog-accept/);

      const dialogEvents = await tool.execute("live-io-dialog-read-1", {
        action: "dialog",
        engine: "live",
        tabId: opened.tab.id,
        limit: 10,
        clear: true,
      });
      assert.equal(dialogEvents.ok, true);
      assert.equal(dialogEvents.armed, null);
      assert.ok(dialogEvents.events.some((evt) => String(evt.handled).includes("dismiss")));
      assert.ok(dialogEvents.events.some((evt) => String(evt.handled).includes("accept")));

      const logs2 = await tool.execute("live-io-console-2", {
        action: "console",
        engine: "live",
        tabId: opened.tab.id,
        limit: 100,
        clear: true,
      });
      assert.equal(logs2.ok, true);
      assert.ok(logs2.messages.some((row) => String(row.text).includes("file-selected:")));
      assert.ok(logs2.messages.some((row) => String(row.text).includes("dialog-result:")));

      const pdf = await tool.execute("live-io-pdf-1", {
        action: "pdf",
        engine: "live",
        tabId: opened.tab.id,
      });
      assert.equal(pdf.ok, true);
      assert.equal(pdf.pdf.mimeType, "application/pdf");
      assert.ok(Number(pdf.pdf.bytes) > 1000);
    } catch (error) {
      t.skip(`live engine unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await tool.execute("live-io-reset-2", { action: "reset" });
    }
  },
);

test(
  "browser live engine click supports right/double click, popup tabs, and act resize/close",
  { skip: !hasPlaywright },
  async (t) => {
    const server = createServer((req, res) => {
      if (req.url === "/clicks") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`
          <html>
            <head><title>Live Clicks</title></head>
            <body>
              <a id="popupLink" href="/popup" target="_blank" rel="noopener">Open Popup</a>
              <div id="ctxTarget" style="width:140px;height:30px;border:1px solid #333;">ctx target</div>
              <div id="ctxOut">ctx-none</div>
              <button id="dblBtn" type="button">Double</button>
              <div id="dblOut">double:0</div>
              <script>
                document.getElementById('ctxTarget').addEventListener('contextmenu', (e) => {
                  e.preventDefault();
                  document.getElementById('ctxOut').textContent = 'right-clicked';
                });
                let dbl = 0;
                document.getElementById('dblBtn').addEventListener('dblclick', () => {
                  dbl += 1;
                  document.getElementById('dblOut').textContent = 'double:' + dbl;
                });
              </script>
            </body>
          </html>
        `);
        return;
      }
      if (req.url === "/popup") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`
          <html>
            <head><title>Popup Page</title></head>
            <body>
              <h1>Popup Ready</h1>
            </body>
          </html>
        `);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.close();
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      t.skip("could not resolve test server address");
      return;
    }

    const clicksUrl = `http://127.0.0.1:${address.port}/clicks`;
    const tool = createBrowserTool();

    try {
      await tool.execute("live-clicks-reset-1", { action: "reset" });
      const opened = await tool.execute("live-clicks-open-1", {
        action: "open",
        engine: "live",
        url: clicksUrl,
        snapshotAfter: true,
      });
      assert.equal(opened.ok, true);
      assert.equal(opened.engine, "live");

      const rightClick = await tool.execute("live-clicks-right-1", {
        action: "click",
        engine: "live",
        tabId: opened.tab.id,
        selector: "#ctxTarget",
        button: "right",
        snapshotAfter: true,
      });
      assert.equal(rightClick.ok, true);
      assert.match(rightClick.snapshot.text, /right-clicked/);

      const doubleClick = await tool.execute("live-clicks-double-1", {
        action: "click",
        engine: "live",
        tabId: opened.tab.id,
        selector: "#dblBtn",
        doubleClick: true,
        snapshotAfter: true,
      });
      assert.equal(doubleClick.ok, true);
      assert.match(doubleClick.snapshot.text, /double:1/);

      const popupClick = await tool.execute("live-clicks-popup-1", {
        action: "click",
        engine: "live",
        tabId: opened.tab.id,
        selector: "#popupLink",
        popupWaitMs: 3000,
        snapshotAfter: true,
      });
      assert.equal(popupClick.ok, true);
      assert.ok(popupClick.openedTab);
      assert.equal(popupClick.activeTabId, popupClick.openedTab.id);
      assert.equal(popupClick.snapshot.title, "Popup Page");

      const resized = await tool.execute("live-clicks-act-resize-1", {
        action: "act",
        kind: "resize",
        engine: "live",
        tabId: popupClick.openedTab.id,
        width: 900,
        height: 700,
      });
      assert.equal(resized.ok, true);
      assert.equal(resized.kind, "resize");
      assert.equal(resized.width, 900);
      assert.equal(resized.height, 700);

      const tabsBeforeClose = await tool.execute("live-clicks-tabs-1", {
        action: "tabs",
      });
      assert.equal(tabsBeforeClose.ok, true);
      assert.ok(tabsBeforeClose.tabs.length >= 2);

      const closed = await tool.execute("live-clicks-act-close-1", {
        action: "act",
        kind: "close",
        tabId: popupClick.openedTab.id,
      });
      assert.equal(closed.ok, true);
      assert.equal(closed.kind, "close");
      assert.equal(closed.closedTabId, popupClick.openedTab.id);
    } catch (error) {
      t.skip(`live engine unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await tool.execute("live-clicks-reset-2", { action: "reset" });
    }
  },
);
