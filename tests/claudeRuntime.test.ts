import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeRuntime, discoverClaudeExecutable, NativeClaudeProcessAdapter, type ClaudeProcessAdapter } from "../src/claude/ClaudeRuntime";
import { MATERIAL_PAPER_DEEP_READING_SKILL_ID, SkillCatalog } from "../src/skills/SkillCatalog";

describe("ClaudeRuntime", () => {
  it("sends the prompt over stdin and emits deduplicated streaming text", async () => {
    const invocations: Array<{ args: string[]; cwd: string; stdin: string }> = [];
    const adapter: ClaudeProcessAdapter = {
      async run(input, observer) {
        invocations.push({ args: input.args, cwd: input.cwd, stdin: input.stdin });
        observer.stdout('{"type":"system","subtype":"init","session_id":"session-1"}\n');
        observer.stdout('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}}\n');
        observer.stdout('{"type":"assistant","message":{"content":[{"type":"text","text":"你好"}]}}\n');
        return { exitCode: 0, stderr: "" };
      },
      async cancel() {}
    };
    const events: string[] = [];
    const runtime = new ClaudeRuntime({ vaultPath: "C:/vault", executablePath: "claude.exe", processAdapter: adapter });

    const result = await runtime.runTurn(
      { runId: "run-1", prompt: "总结", currentNotePath: "papers/a.md", permissionMode: "acceptEdits" },
      event => { if (event.type === "text-delta") events.push(event.text); }
    );

    expect(invocations[0]?.stdin).toContain("总结");
    expect(invocations[0]?.stdin).toContain("papers/a.md");
    expect(invocations[0]?.cwd).toBe("C:/vault");
    expect(invocations[0]?.args).toContain("--output-format");
    expect(invocations[0]?.args).not.toContain("--disallowedTools");
    expect(events.join("")).toBe("你好");
    expect(result).toMatchObject({ sessionId: "session-1", text: "你好" });
  });

  it("does not append an assistant segment twice after a tool call", async () => {
    const runtime = new ClaudeRuntime({
      vaultPath: "C:/vault",
      executablePath: "claude.exe",
      processAdapter: {
        async run(_input, observer) {
          observer.stdout('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"FIRST\\n\\n"}}}\n');
          observer.stdout('{"type":"assistant","message":{"id":"message-1","content":[{"type":"text","text":"FIRST\\n\\n"},{"type":"tool_use","name":"Read","input":{"file_path":"paper.md"}}]}}\n');
          observer.stdout('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"SECOND"}}}\n');
          observer.stdout('{"type":"assistant","message":{"id":"message-2","content":[{"type":"text","text":"SECOND"}]}}\n');
          return { exitCode: 0, stderr: "" };
        },
        async cancel() {}
      }
    });
    const streamed: string[] = [];

    const result = await runtime.runTurn(
      { runId: "tool-separated", prompt: "Use a tool between two updates" },
      event => { if (event.type === "text-delta") streamed.push(event.text); }
    );

    expect(streamed.join("")).toBe("FIRST\n\nSECOND");
    expect(result.text).toBe("FIRST\n\nSECOND");
  });

  it("uses an assistant snapshot when no partial text was streamed", async () => {
    const runtime = new ClaudeRuntime({
      vaultPath: "C:/vault",
      executablePath: "claude.exe",
      processAdapter: {
        async run(_input, observer) {
          observer.stdout('{"type":"assistant","message":{"id":"snapshot-only","content":[{"type":"text","text":"fallback"}]}}\n');
          return { exitCode: 0, stderr: "" };
        },
        async cancel() {}
      }
    });
    const streamed: string[] = [];

    const result = await runtime.runTurn(
      { runId: "snapshot-only", prompt: "Fallback" },
      event => { if (event.type === "text-delta") streamed.push(event.text); }
    );

    expect(streamed).toEqual(["fallback"]);
    expect(result.text).toBe("fallback");
  });

  it("preserves identical text intentionally emitted by separate assistant messages", async () => {
    const runtime = new ClaudeRuntime({
      vaultPath: "C:/vault",
      executablePath: "claude.exe",
      processAdapter: {
        async run(_input, observer) {
          observer.stdout('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"repeat"}}}\n');
          observer.stdout('{"type":"assistant","message":{"id":"message-1","content":[{"type":"text","text":"repeat"}]}}\n');
          observer.stdout('{"type":"assistant","message":{"id":"message-1","content":[{"type":"tool_use","name":"Read"}]}}\n');
          observer.stdout('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"repeat"}}}\n');
          observer.stdout('{"type":"assistant","message":{"id":"message-2","content":[{"type":"text","text":"repeat"}]}}\n');
          return { exitCode: 0, stderr: "" };
        },
        async cancel() {}
      }
    });

    const result = await runtime.runTurn({ runId: "intentional-repeat", prompt: "Repeat exactly" }, () => undefined);

    expect(result.text).toBe("repeatrepeat");
  });

  it("fills a suffix missing from the partial stream using the assistant snapshot", async () => {
    const runtime = new ClaudeRuntime({
      vaultPath: "C:/vault",
      executablePath: "claude.exe",
      processAdapter: {
        async run(_input, observer) {
          observer.stdout('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"par"}}}\n');
          observer.stdout('{"type":"assistant","message":{"id":"partial-message","content":[{"type":"text","text":"partial"}]}}\n');
          return { exitCode: 0, stderr: "" };
        },
        async cancel() {}
      }
    });
    const streamed: string[] = [];

    const result = await runtime.runTurn(
      { runId: "missing-suffix", prompt: "Finish the word" },
      event => { if (event.type === "text-delta") streamed.push(event.text); }
    );

    expect(streamed).toEqual(["par", "tial"]);
    expect(result.text).toBe("partial");
  });

  it("keeps streamed text when a lagging assistant snapshot is its shorter prefix", async () => {
    const runtime = new ClaudeRuntime({
      vaultPath: "C:/vault",
      executablePath: "claude.exe",
      processAdapter: {
        async run(_input, observer) {
          observer.stdout('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"partial"}}}\n');
          observer.stdout('{"type":"assistant","message":{"id":"lagging-snapshot","content":[{"type":"text","text":"par"}]}}\n');
          return { exitCode: 0, stderr: "" };
        },
        async cancel() {}
      }
    });
    const streamed: string[] = [];

    const result = await runtime.runTurn(
      { runId: "lagging-snapshot", prompt: "Keep streamed text" },
      event => { if (event.type === "text-delta") streamed.push(event.text); }
    );

    expect(streamed).toEqual(["partial"]);
    expect(result.text).toBe("partial");
  });

  it("clears pending streamed text at a tool-only assistant boundary", async () => {
    const runtime = new ClaudeRuntime({
      vaultPath: "C:/vault",
      executablePath: "claude.exe",
      processAdapter: {
        async run(_input, observer) {
          observer.stdout('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"before"}}}\n');
          observer.stdout('{"type":"assistant","message":{"id":"tool-boundary","content":[{"type":"tool_use","name":"Read"}]}}\n');
          observer.stdout('{"type":"assistant","message":{"id":"after-boundary","content":[{"type":"text","text":"after"}]}}\n');
          return { exitCode: 0, stderr: "" };
        },
        async cancel() {}
      }
    });

    const result = await runtime.runTurn({ runId: "tool-boundary", prompt: "Continue after the tool" }, () => undefined);

    expect(result.text).toBe("beforeafter");
  });

  it("rejects an assistant snapshot that conflicts with its partial stream", async () => {
    const runtime = new ClaudeRuntime({
      vaultPath: "C:/vault",
      executablePath: "claude.exe",
      processAdapter: {
        async run(_input, observer) {
          observer.stdout('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"streamed"}}}\n');
          observer.stdout('{"type":"assistant","message":{"id":"mismatch","content":[{"type":"text","text":"different"}]}}\n');
          return { exitCode: 0, stderr: "" };
        },
        async cancel() {}
      }
    });

    await expect(runtime.runTurn({ runId: "mismatch", prompt: "Mismatch" }, () => undefined))
      .rejects.toThrow("流式文本与完整消息不一致");
    expect(runtime.getStatus()).toEqual({ state: "idle" });
  });

  it("enforces the output limit while filling a missing snapshot suffix", async () => {
    const runtime = new ClaudeRuntime({
      vaultPath: "C:/vault",
      executablePath: "claude.exe",
      maxOutputChars: 5,
      processAdapter: {
        async run(_input, observer) {
          observer.stdout('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"par"}}}\n');
          observer.stdout('{"type":"assistant","message":{"id":"limited-suffix","content":[{"type":"text","text":"partial"}]}}\n');
          return { exitCode: 0, stderr: "" };
        },
        async cancel() {}
      }
    });

    await expect(runtime.runTurn({ runId: "limited-suffix", prompt: "Finish the word" }, () => undefined))
      .rejects.toThrow("超过插件允许的大小");
    expect(runtime.getStatus()).toEqual({ state: "idle" });
  });

  it("adds resume/model/effort flags and delegates cancellation", async () => {
    const cancelled: string[] = [];
    let args: string[] = [];
    let release: (() => void) | undefined;
    const adapter: ClaudeProcessAdapter = {
      run(input) { args = input.args; return new Promise(resolve => { release = () => resolve({ exitCode: 0, stderr: "" }); }); },
      async cancel(runId) { cancelled.push(runId); release?.(); }
    };
    const runtime = new ClaudeRuntime({ vaultPath: "C:/vault", executablePath: "claude.exe", processAdapter: adapter });
    const running = runtime.runTurn({ runId: "r", prompt: "继续", sessionId: "s", model: "sonnet", effort: "high" }, () => undefined);
    await runtime.cancel("r");
    const result = await running;
    expect(args).toEqual(expect.arrayContaining(["--resume", "s", "--model", "sonnet", "--effort", "high"]));
    expect(cancelled).toEqual(["r"]);
    expect(result.stopped).toBe(true);
  });

  it("injects only explicitly selected skill instructions while preserving safe mode", async () => {
    let invocation: { args: string[]; stdin: string } | undefined;
    const adapter: ClaudeProcessAdapter = {
      async run(input) {
        invocation = { args: input.args, stdin: input.stdin };
        return { exitCode: 0, stderr: "" };
      },
      async cancel() {}
    };
    const runtime = new ClaudeRuntime({ vaultPath: "C:/vault", executablePath: "claude.exe", processAdapter: adapter });
    const directory = await mkdtemp(path.join(os.tmpdir(), "paperdian-skills-"));
    const materialDirectory = path.join(directory, "material-paper-deep-reading");
    await mkdir(materialDirectory);
    await writeFile(path.join(materialDirectory, "SKILL.md"), await readFile(path.resolve("src/skills/builtin/material-paper-deep-reading/SKILL.md")));
    const catalog = new SkillCatalog({ directory });
    await catalog.withSelection([MATERIAL_PAPER_DEEP_READING_SKILL_ID], async selectedSkills => {
      selectedSkills.push({ id: "local:critic", name: "critic", instructions: "检查结论是否被实验支持。" });
      await runtime.runTurn({
        runId: "skill-run",
        prompt: "分析这篇论文",
        selectedSkills
      }, () => undefined);
    });

    expect(invocation?.args).toContain("--safe-mode");
    expect(invocation?.args).toContain("--add-dir");
    expect(invocation?.args).toEqual(expect.arrayContaining(["--disallowedTools", "WebFetch,WebSearch"]));
    expect(invocation?.stdin).toContain("<selected-skill name=\"material-paper-deep-reading\" resource-directory=");
    expect(invocation?.stdin).toContain("## 图表解读");
    expect(invocation?.stdin).toContain("## 实验样品制备方法");
    expect(invocation?.stdin).toContain("## 一句话总结");
    expect(invocation?.stdin).toContain("output/<期刊缩写>_<研究看点>_<年份>.md");
    expect(invocation?.stdin).toContain("期刊缩写: 通俗的研究看点");
    expect(invocation?.stdin).toContain("../raw/assets/原文图片文件");
    expect(invocation?.stdin).toContain("本轮只能使用当前已剪藏的 Markdown 原文笔记");
    expect(invocation?.stdin).toContain("不得访问 `source` URL");
    expect(invocation?.stdin).toContain("作者区、作者注记、equal-contribution 注记和 correspondence 说明");
    expect(invocation?.stdin).toContain("绝不能根据作者顺序、CRediT 贡献角色、单位相同或其他推断认定共同一作");
    expect(invocation?.stdin).toContain("只列已核验通讯作者所关联的全部单位");
    expect(invocation?.stdin).toContain("DOI：文中未明确说明");
    expect(invocation?.stdin).not.toContain("先访问 `source` 指向的出版商文章落地页");
    expect(invocation?.stdin).toContain("<selected-skill name=\"critic\">");
    expect(invocation?.stdin).toContain("用户请求：\n分析这篇论文");
  });

  it("keeps web tools available when only non-deep-reading skills are selected", async () => {
    let args: string[] = [];
    const runtime = new ClaudeRuntime({
      vaultPath: "C:/vault",
      executablePath: "claude.exe",
      processAdapter: {
        async run(input) { args = input.args; return { exitCode: 0, stderr: "" }; },
        async cancel() {}
      }
    });

    await runtime.runTurn({
      runId: "local-skill-run",
      prompt: "普通编辑",
      selectedSkills: [{ id: "local:editor", name: "editor", instructions: "编辑文本。" }]
    }, () => undefined);

    expect(args).not.toContain("--disallowedTools");
  });

  it("grants access to staged skill resources while preserving safe mode and prompt guidance", async () => {
    let invocation: { args: string[]; stdin: string } | undefined;
    const runtime = new ClaudeRuntime({
      vaultPath: "C:/vault",
      executablePath: "claude.exe",
      processAdapter: {
        async run(input) {
          invocation = { args: input.args, stdin: input.stdin };
          return { exitCode: 0, stderr: "" };
        },
        async cancel() {}
      }
    });
    const stagedDirectory = "C:/Temp/paperdian-skills/0-writer";

    await runtime.runTurn({
      runId: "resource-skill-run",
      prompt: "写一篇文章",
      selectedSkills: [{
        id: "local:writer",
        name: "writer",
        instructions: "先读取 references/style.md。",
        resourceDirectory: stagedDirectory
      }]
    }, () => undefined);

    expect(invocation?.args).toContain("--safe-mode");
    expect(invocation?.args).toEqual(expect.arrayContaining(["--add-dir", stagedDirectory]));
    expect(invocation?.stdin).toContain(`resource-directory="${stagedDirectory}"`);
    expect(invocation?.stdin).toContain("相对路径均以该目录为基准");
    expect(invocation?.stdin).toContain("最终产物写入当前 Vault");
  });

  it("exposes only the staged bundle path to a Claude invocation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-runtime-skill-"));
    const source = path.join(root, "skills", "private-source");
    await mkdir(path.join(source, "references"), { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\nname: private-source\ndescription: 测试隔离路径\n---\n\n读取 references/style.md。\n");
    await writeFile(path.join(source, "references", "style.md"), "isolated style");
    const catalog = new SkillCatalog({ directory: path.join(root, "skills") });
    const selectedId = (await catalog.list()).skills.find(item => item.name === "private-source")?.id;
    let invocation: { args: string[]; stdin: string } | undefined;
    const runtime = new ClaudeRuntime({
      vaultPath: "C:/vault",
      executablePath: "claude.exe",
      processAdapter: {
        async run(input) {
          invocation = { args: input.args, stdin: input.stdin };
          const addDirectory = input.args[input.args.indexOf("--add-dir") + 1];
          expect(await readFile(path.join(addDirectory!, "references", "style.md"), "utf8")).toBe("isolated style");
          return { exitCode: 0, stderr: "" };
        },
        async cancel() {}
      }
    });

    await catalog.withSelection([selectedId!], selectedSkills => runtime.runTurn({
      runId: "isolated-resource-run",
      prompt: "使用样式",
      selectedSkills
    }, () => undefined));

    expect(invocation?.args.join("\n")).not.toContain(source);
    expect(invocation?.stdin).not.toContain(source);
  });

  it("resolves an npm claude.cmd shim to the native executable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-claude-"));
    const executable = path.join(root, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(path.join(root, "claude.cmd"), "@echo off\r\n");
    await writeFile(executable, "fake");
    expect(await discoverClaudeExecutable(path.join(root, "claude.cmd"))).toBe(executable);
  });

  it("accepts an explicitly configured native Claude executable without a Windows extension", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-claude-native-"));
    const executable = path.join(root, "claude");
    await writeFile(executable, "fake");
    await chmod(executable, 0o755);

    await expect(discoverClaudeExecutable(executable)).resolves.toBe(executable);
  });

  it("does not treat an extensionless directory as a Claude executable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-claude-directory-"));
    const directory = path.join(root, "claude");
    await mkdir(directory);

    await expect(discoverClaudeExecutable(directory)).rejects.toThrow("未找到 Claude Code");
  });

  it("reports process failures with the streamed stderr and becomes usable again", async () => {
    let attempts = 0;
    const runtime = new ClaudeRuntime({
      vaultPath: "C:/vault", executablePath: "claude",
      processAdapter: {
        async run(_input, observer) {
          attempts += 1;
          if (attempts === 1) {
            observer.stderr("upstream unavailable");
            return { exitCode: 2, stderr: "less useful fallback" };
          }
          return { exitCode: 0, stderr: "" };
        },
        async cancel() {}
      }
    });

    await expect(runtime.runTurn({ runId: "failed", prompt: "测试" }, () => undefined)).rejects.toThrow("upstream unavailable");
    expect(runtime.getStatus()).toEqual({ state: "idle" });
    await expect(runtime.runTurn({ runId: "retry", prompt: "继续" }, () => undefined)).resolves.toMatchObject({ runId: "retry", text: "" });
  });

  it("rejects invalid stream data and clears its running state", async () => {
    const runtime = new ClaudeRuntime({
      vaultPath: "C:/vault", executablePath: "claude",
      processAdapter: {
        async run(_input, observer) { observer.stdout("not-json\\n"); return { exitCode: 0, stderr: "" }; },
        async cancel() {}
      }
    });

    await expect(runtime.runTurn({ runId: "bad", prompt: "测试" }, () => undefined)).rejects.toThrow("无法解析");
    expect(runtime.getStatus()).toEqual({ state: "idle" });
  });

  it("processes a final line without a newline and enforces the output limit", async () => {
    const runtime = new ClaudeRuntime({
      vaultPath: "C:/vault", executablePath: "claude", maxOutputChars: 2,
      processAdapter: {
        async run(_input, observer) { observer.stdout('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"太长了"}}}'); return { exitCode: 0, stderr: "" }; },
        async cancel() {}
      }
    });

    await expect(runtime.runTurn({ runId: "limit", prompt: "测试" }, () => undefined)).rejects.toThrow("超过插件允许的大小");
    expect(runtime.getStatus()).toEqual({ state: "idle" });
  });

  it.each(["stdout", "stderr"] as const)("rejects a %s observer error and stops a still-running native process", async stream => {
    const adapter = new NativeClaudeProcessAdapter();
    const observerError = new Error(`${stream} observer failed`);
    const runId = `${stream}-observer-error`;
    let childPid: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const run = adapter.run(
      {
        runId,
        executablePath: process.execPath,
        args: ["-e", `process.${stream}.write(String(process.pid)); setInterval(() => undefined, 1_000);`],
        cwd: process.cwd(),
        stdin: ""
      },
      {
        stdout(chunk) {
          if (stream !== "stdout") return;
          childPid = Number(chunk);
          throw observerError;
        },
        stderr(chunk) {
          if (stream !== "stderr") return;
          childPid = Number(chunk);
          throw observerError;
        }
      }
    );
    const boundedRun = Promise.race([
      run,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("native process was not stopped after the observer failed")), 1_000);
      })
    ]);

    try {
      await expect(boundedRun).rejects.toBe(observerError);
      expect(childPid).toBeTypeOf("number");
      expect(() => process.kill(childPid!, 0)).toThrow();
      await expect(adapter.cancel(runId)).resolves.toBeUndefined();
    } finally {
      if (timeout) clearTimeout(timeout);
      await adapter.cancel(runId);
      await run.catch(() => undefined);
    }
  }, 5_000);
});
