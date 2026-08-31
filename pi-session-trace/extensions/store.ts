/** TraceStore — ordered records + turn structure + change notification. */

import type { TrajectoryRecord, UsageInfo } from "./types.ts";

export class TraceStore {
	readonly records: TrajectoryRecord[] = [];
	private listeners = new Set<() => void>();

	/** Append a batch of records (already turn-tagged by the source). */
	appendMany(batch: TrajectoryRecord[]): void {
		if (batch.length === 0) return;
		this.records.push(...batch);
		this.notify();
	}

	/** Drop all records (session switch: /resume, /new, /fork trigger a fresh backfill). */
	reset(): void {
		this.records.length = 0;
		this.notify();
	}

	/** Update an existing record in place (tool completion, streaming growth). */
	update(id: string, patch: Partial<TrajectoryRecord>): void {
		const rec = this.findById(id);
		if (!rec) return;
		Object.assign(rec, patch);
		this.notify();
	}

	get(id: string): TrajectoryRecord | undefined {
		return this.findById(id);
	}

	/** Updates almost always target recently appended records — scan from the tail. */
	private findById(id: string): TrajectoryRecord | undefined {
		for (let i = this.records.length - 1; i >= 0; i--) {
			if (this.records[i]!.id === id) return this.records[i];
		}
		return undefined;
	}

	/** Aggregate all persisted usage attached to records in a turn, including tool/compaction usage. */
	turnUsage(turn: number): UsageInfo | undefined {
		return aggregateUsage(this.records.filter((record) => record.turn === turn));
	}

	/** Sum input+output tokens within a turn (reasoning remains a subset of output). */
	turnTokens(turn: number): number | undefined {
		const usage = this.turnUsage(turn);
		if (!usage) return undefined;
		const total = (usage.input ?? 0) + (usage.output ?? 0);
		return total || usage.totalTokens;
	}

	/** Aggregate all known usage in the currently selected trace. */
	totalUsage(): UsageInfo | undefined {
		return aggregateUsage(this.records);
	}

	turnRange(turn: number): { first: number; last: number } | undefined {
		let first = -1;
		let last = -1;
		for (let i = 0; i < this.records.length; i++) {
			if (this.records[i]!.turn !== turn) continue;
			if (first < 0) first = i;
			last = i;
		}
		return first < 0 ? undefined : { first, last };
	}

	subscribe(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	/** Incremented on every mutation — projection caches key off this. */
	version = 0;

	private notify(): void {
		this.version++;
		for (const cb of this.listeners) cb();
	}
}

function aggregateUsage(records: readonly TrajectoryRecord[]): UsageInfo | undefined {
	let found = false;
	const total: UsageInfo = { cost: {} };
	for (const record of records) {
		const usage = usageFor(record);
		if (!usage) continue;
		found = true;
		addNumber(total, "input", usage.input);
		addNumber(total, "output", usage.output);
		addNumber(total, "cacheRead", usage.cacheRead);
		addNumber(total, "cacheWrite", usage.cacheWrite);
		addNumber(total, "cacheWrite1h", usage.cacheWrite1h);
		addNumber(total, "reasoning", usage.reasoning);
		addNumber(total, "totalTokens", usage.totalTokens);
		if (usage.cost) {
			if (!total.cost) total.cost = {};
			addCost(total.cost, "input", usage.cost.input);
			addCost(total.cost, "output", usage.cost.output);
			addCost(total.cost, "cacheRead", usage.cost.cacheRead);
			addCost(total.cost, "cacheWrite", usage.cost.cacheWrite);
			addCost(total.cost, "total", usage.cost.total);
		}
	}
	if (!found) return undefined;
	if (total.cost && Object.keys(total.cost).length === 0) delete total.cost;
	return total;
}

function usageFor(record: TrajectoryRecord): UsageInfo | undefined {
	switch (record.kind) {
		case "assistant":
		case "compaction":
		case "marker":
			return record.usage;
		case "tool":
			return record.result?.usage;
		default:
			return undefined;
	}
}

function addNumber(target: UsageInfo, key: Exclude<keyof UsageInfo, "cost">, value: number | undefined): void {
	if (value === undefined) return;
	target[key] = ((target[key] as number | undefined) ?? 0) + value;
}

function addCost(target: NonNullable<UsageInfo["cost"]>, key: keyof NonNullable<UsageInfo["cost"]>, value: number | undefined): void {
	if (value === undefined) return;
	target[key] = (target[key] ?? 0) + value;
}
