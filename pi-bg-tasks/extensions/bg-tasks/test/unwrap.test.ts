/**
 * Tests for unwrap.ts — recovering the original command from the sandbox
 * extension's sandbox-exec wrapping so job display surfaces stay readable.
 *
 * `quote()` below mirrors @anthropic-ai/sandbox-runtime's shell-quote
 * exactly (bare-word fast path, otherwise single quotes with `'"'"'`).
 * If the runtime changes its quoting, unwrapSandboxCommand must degrade
 * to identity (never corrupt), which the garbage-input cases assert.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseShellWords, unwrapSandboxCommand } from "../unwrap.ts";

/** Mirror of the runtime's quote() — keep in sync with the pinned version. */
function quote(args: string[]): string {
    return args
        .map((arg) => {
            if (arg === "") return "''";
            if (/^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/.test(arg)) return arg;
            return "'" + arg.replace(/'/g, `'"'"'`) + "'";
        })
        .join(" ");
}

/** Build a wrapped command the way the runtime's macOS wrap does. */
function wrap(original: string, profile = "(version 1) (deny default)"): string {
    return quote([
        "env",
        "SANDBOX_RUNTIME=1",
        "TMPDIR=/tmp/claude",
        "HTTP_PROXY=http://srt.Y21k:token@localhost:1234",
        "/usr/bin/sandbox-exec",
        "-p",
        profile,
        "/bin/bash",
        "-c",
        original,
    ]);
}

describe("parseShellWords", () => {
    it("splits bare words", () => {
        assert.deepEqual(parseShellWords("env A=1 /bin/bash"), ["env", "A=1", "/bin/bash"]);
    });

    it("handles single-quoted and empty args", () => {
        assert.deepEqual(parseShellWords("env 'a b' '' c"), ["env", "a b", "", "c"]);
    });

    it("unescapes the '\"'\"' quote sequence", () => {
        assert.deepEqual(parseShellWords("'it'\"'\"'s'"), ["it's"]);
    });

    it("rejects double quotes (never emitted by quote())", () => {
        assert.equal(parseShellWords(`env "a b"`), null);
    });

    it("rejects unbalanced quotes", () => {
        assert.equal(parseShellWords("env 'abc"), null);
    });

    it("rejects consecutive spaces", () => {
        assert.equal(parseShellWords("env  A=1"), null);
    });
});

describe("unwrapSandboxCommand", () => {
    it("returns plain commands unchanged", () => {
        assert.equal(unwrapSandboxCommand("echo hello"), "echo hello");
        assert.equal(unwrapSandboxCommand("ls -la && git status"), "ls -la && git status");
    });

    it("returns env-prefixed non-sandbox commands unchanged", () => {
        assert.equal(unwrapSandboxCommand("env FOO=1 echo hi"), "env FOO=1 echo hi");
    });

    it("recovers a simple command", () => {
        assert.equal(unwrapSandboxCommand(wrap("echo hello")), "echo hello");
    });

    it("recovers commands with single quotes", () => {
        assert.equal(unwrapSandboxCommand(wrap("echo 'it's ok'")), "echo 'it's ok'");
    });

    it("recovers commands containing ' -c '", () => {
        assert.equal(unwrapSandboxCommand(wrap("bash -c 'nested -c x'")), "bash -c 'nested -c x'");
    });

    it("recovers multiline commands", () => {
        assert.equal(unwrapSandboxCommand(wrap("echo a\necho b")), "echo a\necho b");
    });

    it("recovers commands with shell metacharacters", () => {
        const cmd = `for i in $(seq 1 3); do echo "tick-$i" > /tmp/t.log; done && cat /tmp/t.log | grep 'tick'`;
        assert.equal(unwrapSandboxCommand(wrap(cmd)), cmd);
    });

    it("recovers commands with double quotes", () => {
        assert.equal(unwrapSandboxCommand(wrap(`echo "quoted" && jq '.a'`)), `echo "quoted" && jq '.a'`);
    });

    it("recovers an empty command", () => {
        assert.equal(unwrapSandboxCommand(wrap("")), "");
    });

    it("recovers commands with trailing spaces and tabs", () => {
        assert.equal(unwrapSandboxCommand(wrap("echo hi  \t")), "echo hi  \t");
    });

    it("handles a profile containing spaces and quotes", () => {
        const profile = `(version 1) (allow file-read* (subpath "/tmp/my dir")) (with message "CMD64_ZW1w_END__abc123_SBX")`;
        assert.equal(unwrapSandboxCommand(wrap("echo ok", profile)), "echo ok");
    });

    it("degrades to identity on truncated/garbage wrapped input", () => {
        const truncated = wrap("echo hello").slice(0, 40); // cut mid-profile
        assert.equal(unwrapSandboxCommand(truncated), truncated);
        assert.equal(
            unwrapSandboxCommand("env SANDBOX_RUNTIME=1 /usr/bin/sandbox-exec -p"),
            "env SANDBOX_RUNTIME=1 /usr/bin/sandbox-exec -p"
        );
    });

    it("roundtrips a battery of nasty originals", () => {
        const originals = [
            "echo '\"'\"'double single'\"'\"'",
            "printf '%s\\n' done",
            "echo `date` $(pwd) $HOME",
            "git commit -m 'fix: it'\"'\"'s here'",
            "  leading spaces",
            "trailing space ",
            "echo -c -c -c",
            "'",
            "'''",
        ];
        for (const orig of originals) {
            assert.equal(unwrapSandboxCommand(wrap(orig)), orig, `roundtrip failed for ${JSON.stringify(orig)}`);
        }
    });
});
