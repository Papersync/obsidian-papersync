/**
 * How long a scan whose companion photo is missing waits before its text is
 * imported alone. The phone app uploads the scan JSON first and the photo
 * second (with retries), so a JSON can appear before its photo.
 */
// Local folders (incl. iCloud): measured from when the plugin first sees the JSON.
export const COMPANION_GRACE_MS = 60_000;
// Google Drive: measured from the JSON's Drive createdTime, so a multi-MB photo on
// mobile data, or an app backgrounded mid-upload, still lands in the same note.
export const DRIVE_COMPANION_GRACE_MS = 5 * 60_000;

export interface GracePolicy {
	/** Window length in ms. */
	windowMs: number;
	/** The source's own upload time (Drive createdTime). Invalid or absent = first sight. */
	uploadedAt?: string;
}

/**
 * A test-only override supplier (settings.companionGraceOverrideMs, written at
 * runtime by E2E, stripped on load, no UI). Honored only as a SHORTER window, so
 * a tampered value can never hold a scan back longer than production would.
 */
export type GraceOverrideSupplier = () => unknown;

const MIN_OVERRIDE_MS = 1000;

function overrideMs(supplier: GraceOverrideSupplier | undefined, windowMs: number): number | null {
	const value = supplier?.();
	if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_OVERRIDE_MS || value >= windowMs) {
		return null;
	}
	return value;
}

/** A bounded window for JSON-first uploads. No batch sleeps or lost cursors. */
export class CompanionGrace {
	private deadlines = new Map<string, number>();
	private timer: number | null = null;
	private paused = false;

	constructor(
		private readonly retry: () => Promise<void>,
		private readonly override?: GraceOverrideSupplier
	) {}

	get pendingCount(): number {
		return this.deadlines.size;
	}

	/** True while this scan is inside its grace (a re-check is not new work). */
	has(id: string): boolean {
		return this.deadlines.has(id);
	}

	defer(id: string, policy: GracePolicy = { windowMs: COMPANION_GRACE_MS }): boolean {
		const now = Date.now();
		const deadline = this.deadlines.get(id) ?? this.deadlineFor(now, policy);
		if (now >= deadline) {
			return false;
		}
		this.deadlines.set(id, deadline);
		this.schedule();
		return true;
	}

	private deadlineFor(now: number, policy: GracePolicy): number {
		const forced = overrideMs(this.override, policy.windowMs);
		if (forced !== null) {
			return now + forced;
		}
		const uploaded = policy.uploadedAt === undefined ? NaN : Date.parse(policy.uploadedAt);
		if (Number.isNaN(uploaded)) {
			return now + policy.windowMs;
		}
		// A source clock ahead of ours must not stretch the window past one full
		// window from now; a long-past upload still gets the folder floor, so this
		// never waits less than the first-sight grace did.
		const anchored = Math.min(uploaded, now) + policy.windowMs;
		return Math.max(anchored, now + Math.min(COMPANION_GRACE_MS, policy.windowMs));
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
