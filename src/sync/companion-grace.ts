/** A bounded window for JSON-first uploads. No batch sleeps or lost cursors. */
export class CompanionGrace {
	private deadlines = new Map<string, number>();
	private timer: number | null = null;
	private paused = false;

	constructor(private readonly retry: () => Promise<void>) {}

	get pendingCount(): number {
		return this.deadlines.size;
	}

	defer(id: string): boolean {
		const now = Date.now();
		const deadline =
			this.deadlines.get(id) ?? now + 60_000;
		if (now >= deadline) {
			return false;
		}
		this.deadlines.set(id, deadline);
		this.schedule();
		return true;
	}

	retain(ids: string[]): void {
		const current = new Set(ids);
		for (const id of this.deadlines.keys()) {
			if (!current.has(id)) {
				this.complete(id);
			}
		}
	}

	complete(id: string): void {
		this.deadlines.delete(id);
		if (this.deadlines.size === 0 && this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
	}

	pause(): void {
		this.paused = true;
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
	}

	resume(): void {
		this.paused = false;
		this.schedule();
	}

	private schedule(): void {
		if (this.paused || this.timer !== null || this.deadlines.size === 0) {
			return;
		}
		const wait = Math.max(1000, Math.min(...this.deadlines.values()) - Date.now());
		this.timer = window.setTimeout(() => {
			this.timer = null;
			// A busy/offline engine may decline a pass. Preserve the deadline and
			// retry later instead of abandoning the scan or restarting its grace.
			void this.retry().finally(() => this.schedule());
		}, wait);
	}
}
