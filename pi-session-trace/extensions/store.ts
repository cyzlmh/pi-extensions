/** TraceStore — ordered records + turn structure + change notification. */

import type { TrajectoryRecord } from "./types.ts";

export class TraceStore {
	readonly records: TrajectoryRecord[] = [];
	private listeners = new Set<() => void>();

	/** Append a batch of records (already turn-tagged by the source). */
	appendMany(batch: TrajectoryRecord[]): void {
		if (batch.length === 0) return;
		this.records.push(...batch);
		this.notify();
	}

	/** Update an existing record in place (tool completion, streaming growth). */
	update(id: string, patch: Partial<TrajectoryRecord>): void {
		const rec = this.records.find((r) => r.id === id);
		if (!rec) return;
		Object.assign(rec, patch);
		this.notify();
	}

	get(id: string): TrajectoryRecord | undefined {
		return this.records.find((r) => r.id === id);
	}

	/** Distinct turn numbers present, ascending. */
	turns(): number[] {
		const seen = new Set<number>();
		for (const r of this.records) seen.add(r.turn);
		return [...seen].sort((a, b) => a - b);
	}

	/** Sum of assistant input+output tokens within a turn. */
	turnTokens(turn: number): number | undefined {
		let sum = 0;
		let any = false;
		for (const r of this.records) {
			if (r.turn !== turn || r.kind !== "assistant" || !r.usage) continue;
			sum += (r.usage.input ?? 0) + (r.usage.output ?? 0);
			any = true;
		}
		return any ? sum : undefined;
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
