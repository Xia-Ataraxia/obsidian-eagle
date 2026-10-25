
export interface DebounceControllerOptions {
	delayMs: number;
	onRun: () => Promise<void>;
}

export class DebounceController {
	private timer: number | null = null;
	private running = false;
	private rerun = false;

	constructor(private readonly options: DebounceControllerOptions) {}

	markDirty(): void {
		if (this.running) {
			this.rerun = true;
			return;
		}
		if (this.timer) {
			window.clearTimeout(this.timer);
		}
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.run();
		}, this.options.delayMs);
	}

	dispose(): void {
		if (this.timer) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private async run(): Promise<void> {
		this.running = true;
		this.rerun = false;
		try {
			await this.options.onRun();
		} finally {
			this.running = false;
			if (this.rerun) {
				this.rerun = false;
				this.markDirty();
			}
		}
	}
}
