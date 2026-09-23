/**
 * working-status — replace pi's generic `Working` row with a live phase line.
 *
 * Everything shown here is measured, never estimated:
 *
 *   waiting 4.2s                 从请求发出到首个 token（= TTFT）
 *   thinking 3.1s · 820 ch       正在输出思考内容
 *   writing 5.4s · 2.1k ch       正在输出正文
 *   calling write 1.2s           正在生成工具调用参数
 *   bash 12.3s · 1.2k out        工具执行中（输出=全部 text 块字符数）
 *   write 1.4s · 300 out
 *   · quiet 6.1s                 超过 3s 无任何输出（卡顿/阻塞肉眼可见）
 *
 * 数字含义（都是逐个 delta 累加的精确值，不是估算）：
 *   `reason` 本次 LLM 调用已产出的思考字符数
 *   `text`   本次 LLM 调用已产出的正文字符数
 *   `tool`   正在生成的工具调用参数已产出字符数
 *   `out`    当前工具已产出的输出字符数（只数 text 块；图片不计）
 *
 * 注意 `out` 只统计文本。若工具只产出图片（例如 read 读图），`out` 保持 0 ——
 * 这是真实值，不是卡死；此时靠行尾 quiet 计时判断是否真的没动静。
 *
 * 无开关命令 — 装上扩展即默认开启；想停用就移除扩展文件（或 /reload 前删掉）。
 *
 * Install: pi install npm:pi-working-status  →  /reload
 * Or drop this file in ~/.pi/agent/extensions/ and /reload.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TICK_MS = 200;
/** 静默多久后在行尾追加 quiet 计时。 */
const QUIET_SECONDS = 3;

type PhaseName = "waiting" | "thinking" | "writing" | "calling" | "tool";

interface Phase {
	name: PhaseName;
	label: string;
	since: number;
}

const BASE_LABEL: Record<PhaseName, string> = {
	waiting: "waiting",
	thinking: "thinking",
	writing: "writing",
	calling: "calling",
	tool: "tool",
};

/** 工具流式输出：partialResult 形如 { content: [{ type: "text", text }, …] }。
 *  逐块累加所有 text 块；图片块无文本字段，自然计 0。 */
function partialOutputLength(partialResult: unknown): number {
	if (!partialResult || typeof partialResult !== "object") return 0;
	const content = (partialResult as { content?: unknown }).content;
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const { type, text } = block as { type?: string; text?: unknown };
		if (type === "text" && typeof text === "string") total += text.length;
	}
	return total;
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
}

function formatCount(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

/** 正在生成的工具调用中，从 partial 里按 contentIndex 取工具名。
 *  数组是追加式的，但索引偶尔可能越界，故先做范围检查。 */
function callingLabel(partial: AssistantMessage, contentIndex: number): string {
	const block = partial.content[contentIndex];
	const name = block && block.type === "toolCall" ? block.name : "";
	return name ? `calling ${name}` : "calling tool";
}

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let phase: Phase = { name: "waiting", label: BASE_LABEL.waiting, since: 0 };
	/** 本次 LLM 调用已产出的字符数，按来源分开统计（不再揉成一个数）。 */
	let reasonChars = 0;
	let textChars = 0;
	let callChars = 0;
	/** 当前工具已产出的输出字符数。 */
	let toolOutput = 0;
	let lastActivity = 0;
	let lastPainted: string | undefined;

	/** 同一阶段内只更新文案（工具名可能比 toolcall_start 晚到），不重置计时。 */
	function setPhase(name: PhaseName, label = BASE_LABEL[name]): void {
		if (phase.name === name) {
			phase.label = label;
			return;
		}
		phase = { name, label, since: Date.now() };
		if (name !== "tool") toolOutput = 0;
	}

	/** 强制从此刻重新计时（每次 provider 请求、每个工具开始时）。 */
	function restartPhase(name: PhaseName, label = BASE_LABEL[name]): void {
		phase = { name, label, since: Date.now() };
	}

	function paint(): void {
		if (!ctx || !phase.since) return;
		const now = Date.now();
		const parts = [`${phase.label} ${formatDuration((now - phase.since) / 1000)}`];

		if (phase.name === "tool") {
			if (toolOutput > 0) parts.push(`${formatCount(toolOutput)} out`);
		} else if (phase.name !== "waiting") {
			// 只显示当前阶段真正在产出的那一种计数，避免把思考量粘到正文上。
			const count =
				phase.name === "thinking" ? reasonChars : phase.name === "writing" ? textChars : callChars;
			if (count > 0) parts.push(`${formatCount(count)} ch`);
		}

		const quiet = (now - lastActivity) / 1000;
		if (quiet >= QUIET_SECONDS) parts.push(`quiet ${formatDuration(quiet)}`);

		const text = parts.join(" · ");
		if (text === lastPainted) return;
		lastPainted = text;
		ctx.ui.setWorkingMessage(text);
	}

	function startTimer(): void {
		if (timer) clearInterval(timer);
		timer = setInterval(paint, TICK_MS);
	}

	function stopTimer(): void {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	}

	pi.on("agent_start", (_event, eventCtx) => {
		ctx = eventCtx;
		reasonChars = 0;
		textChars = 0;
		callChars = 0;
		toolOutput = 0;
		lastActivity = Date.now();
		restartPhase("waiting");
		startTimer();
	});

	// 每次 LLM 请求发出：从这里开始算 TTFT，字符数按「本条消息」清零。
	pi.on("before_provider_request", (_event, eventCtx) => {
		ctx = eventCtx;
		reasonChars = 0;
		textChars = 0;
		callChars = 0;
		lastActivity = Date.now();
		restartPhase("waiting");
		paint();
	});

	pi.on("message_update", (event, eventCtx) => {
		const streamEvent = event.assistantMessageEvent;
		ctx = eventCtx;

		if (streamEvent.type === "thinking_delta") {
			reasonChars += streamEvent.delta.length;
			setPhase("thinking");
		} else if (streamEvent.type === "text_delta") {
			textChars += streamEvent.delta.length;
			setPhase("writing");
		} else if (streamEvent.type === "toolcall_start" || streamEvent.type === "toolcall_delta") {
			if (streamEvent.type === "toolcall_delta") callChars += streamEvent.delta.length;
			setPhase("calling", callingLabel(streamEvent.partial, streamEvent.contentIndex));
		} else {
			return; // start / *_end / done / error：阶段不变
		}

		lastActivity = Date.now();
	});

	pi.on("tool_execution_start", (event, eventCtx) => {
		ctx = eventCtx;
		toolOutput = 0;
		lastActivity = Date.now();
		restartPhase("tool", event.toolName);
		paint();
	});

	pi.on("tool_execution_update", (event, eventCtx) => {
		ctx = eventCtx;
		const length = partialOutputLength(event.partialResult);
		if (length === 0) return;
		toolOutput = length;
		lastActivity = Date.now();
	});

	pi.on("tool_execution_end", (_event, eventCtx) => {
		ctx = eventCtx;
		restartPhase("waiting");
	});

	pi.on("agent_settled", (_event, eventCtx) => {
		stopTimer();
		phase = { name: "waiting", label: BASE_LABEL.waiting, since: 0 };
		reasonChars = 0;
		textChars = 0;
		callChars = 0;
		toolOutput = 0;
		lastPainted = undefined;
		try {
			eventCtx.ui.setWorkingMessage(undefined);
		} catch {
			// 会话已被替换，这行本来也不存在了。
		}
	});

	pi.on("session_shutdown", () => {
		stopTimer();
	});

}
