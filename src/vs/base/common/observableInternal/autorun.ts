/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChangeContext, IObservable, IObservableWithChange, IObserver, IReader } from './base.js';
import { DebugNameData, IDebugNameData } from './debugName.js';
import { assertFn, BugIndicatingError, DisposableStore, IDisposable, markAsDisposed, onBugIndicatingError, toDisposable, trackDisposable } from './commonFacade/deps.js';
import { getLogger } from './logging.js';

/**
 * Runs immediately and whenever a transaction ends and an observed observable changed.
 * {@link fn} should start with a JS Doc using `@description` to name the autorun.
 */
export function autorun(fn: (reader: IReader) => void): IDisposable {
	return new AutorunObserver(
		new DebugNameData(undefined, undefined, fn),
		fn,
		undefined,
		undefined
	);
}

/**
 * Runs immediately and whenever a transaction ends and an observed observable changed.
 * {@link fn} should start with a JS Doc using `@description` to name the autorun.
 */
export function autorunOpts(options: IDebugNameData & {}, fn: (reader: IReader) => void): IDisposable {
	return new AutorunObserver(
		new DebugNameData(options.owner, options.debugName, options.debugReferenceFn ?? fn),
		fn,
		undefined,
		undefined
	);
}

/**
 * Runs immediately and whenever a transaction ends and an observed observable changed.
 * {@link fn} should start with a JS Doc using `@description` to name the autorun.
 *
 * Use `createEmptyChangeSummary` to create a "change summary" that can collect the changes.
 * Use `handleChange` to add a reported change to the change summary.
 * The run function is given the last change summary.
 * The change summary is discarded after the run function was called.
 *
 * @see autorun
 */
export function autorunHandleChanges<TChangeSummary>(
	options: IDebugNameData & {
		createEmptyChangeSummary?: () => TChangeSummary;
		handleChange: (context: IChangeContext, changeSummary: TChangeSummary) => boolean;
	},
	fn: (reader: IReader, changeSummary: TChangeSummary) => void
): IDisposable {
	return new AutorunObserver(
		new DebugNameData(options.owner, options.debugName, options.debugReferenceFn ?? fn),
		fn,
		options.createEmptyChangeSummary,
		options.handleChange
	);
}

/**
 * @see autorunHandleChanges (but with a disposable store that is cleared before the next run or on dispose)
 */
export function autorunWithStoreHandleChanges<TChangeSummary>(
	options: IDebugNameData & {
		createEmptyChangeSummary?: () => TChangeSummary;
		handleChange: (context: IChangeContext, changeSummary: TChangeSummary) => boolean;
	},
	fn: (reader: IReader, changeSummary: TChangeSummary, store: DisposableStore) => void
): IDisposable {
	const store = new DisposableStore();
	const disposable = autorunHandleChanges(
		{
			owner: options.owner,
			debugName: options.debugName,
			debugReferenceFn: options.debugReferenceFn ?? fn,
			createEmptyChangeSummary: options.createEmptyChangeSummary,
			handleChange: options.handleChange,
		},
		(reader, changeSummary) => {
			store.clear();
			fn(reader, changeSummary, store);
		}
	);
	return toDisposable(() => {
		disposable.dispose();
		store.dispose();
	});
}

/**
 * @see autorun (but with a disposable store that is cleared before the next run or on dispose)
 */
export function autorunWithStore(fn: (reader: IReader, store: DisposableStore) => void): IDisposable {
	const store = new DisposableStore();
	const disposable = autorunOpts(
		{
			owner: undefined,
			debugName: undefined,
			debugReferenceFn: fn,
		},
		reader => {
			store.clear();
			fn(reader, store);
		}
	);
	return toDisposable(() => {
		disposable.dispose();
		store.dispose();
	});
}

export function autorunDelta<T>(
	observable: IObservable<T>,
	handler: (args: { lastValue: T | undefined; newValue: T }) => void
): IDisposable {
	let _lastValue: T | undefined;
	return autorunOpts({ debugReferenceFn: handler }, (reader) => {
		const newValue = observable.read(reader);
		const lastValue = _lastValue;
		_lastValue = newValue;
		handler({ lastValue, newValue });
	});
}

export function autorunIterableDelta<T>(
	getValue: (reader: IReader) => Iterable<T>,
	handler: (args: { addedValues: T[]; removedValues: T[] }) => void,
	getUniqueIdentifier: (value: T) => unknown = v => v,
) {
	const lastValues = new Map<unknown, T>();
	return autorunOpts({ debugReferenceFn: getValue }, (reader) => {
		const newValues = new Map();
		const removedValues = new Map(lastValues);
		for (const value of getValue(reader)) {
			const id = getUniqueIdentifier(value);
			if (lastValues.has(id)) {
				removedValues.delete(id);
			} else {
				newValues.set(id, value);
				lastValues.set(id, value);
			}
		}
		for (const id of removedValues.keys()) {
			lastValues.delete(id);
		}

		if (newValues.size || removedValues.size) {
			handler({ addedValues: [...newValues.values()], removedValues: [...removedValues.values()] });
		}
	});
}



const enum AutorunState {
	/**
	 * A dependency could have changed.
	 * We need to explicitly ask them if at least one dependency changed.
	 */
	dependenciesMightHaveChanged = 1,

	/**
	 * A dependency changed and we need to recompute.
	 */
	stale = 2,
	upToDate = 3,
}

export class AutorunObserver<TChangeSummary = any> implements IObserver, IReader, IDisposable {
	private state = AutorunState.stale;
	private updateCount = 0;
	private disposed = false;
	private dependencies = new Set<IObservable<any>>();
	private dependenciesToBeRemoved = new Set<IObservable<any>>();
	private changeSummary: TChangeSummary | undefined;

	public get debugName(): string {
		return this._debugNameData.getDebugName(this) ?? '(anonymous)';
	}

	constructor(
		public readonly _debugNameData: DebugNameData,
		public readonly _runFn: (reader: IReader, changeSummary: TChangeSummary) => void,
		private readonly createChangeSummary: (() => TChangeSummary) | undefined,
		private readonly _handleChange: ((context: IChangeContext, summary: TChangeSummary) => boolean) | undefined,
	) {
		this.changeSummary = this.createChangeSummary?.();
		getLogger()?.handleAutorunCreated(this);
		this._runIfNeeded();

		trackDisposable(this);
	}

	public dispose(): void {
		this.disposed = true;
		for (const o of this.dependencies) {
			o.removeObserver(this);
		}
		this.dependencies.clear();

		markAsDisposed(this);
	}

	private _runIfNeeded() {
		if (this.state === AutorunState.upToDate) {
			return;
		}

		const emptySet = this.dependenciesToBeRemoved;
		this.dependenciesToBeRemoved = this.dependencies;
		this.dependencies = emptySet;

		this.state = AutorunState.upToDate;

		const isDisposed = this.disposed;
		try {
			if (!isDisposed) {
				getLogger()?.handleAutorunTriggered(this);
				const changeSummary = this.changeSummary!;
				try {
					this.changeSummary = this.createChangeSummary?.();
					this._isReaderValid = true;
					this._runFn(this, changeSummary);
				} catch (e) {
					onBugIndicatingError(e);
				} finally {
					this._isReaderValid = false;
				}
			}
		} finally {
			if (!isDisposed) {
				getLogger()?.handleAutorunFinished(this);
			}
			// We don't want our observed observables to think that they are (not even temporarily) not being observed.
			// Thus, we only unsubscribe from observables that are definitely not read anymore.
			for (const o of this.dependenciesToBeRemoved) {
				o.removeObserver(this);
			}
			this.dependenciesToBeRemoved.clear();
		}
	}

	public toString(): string {
		return `Autorun<${this.debugName}>`;
	}

	// IObserver implementation
	public beginUpdate(): void {
		if (this.state === AutorunState.upToDate) {
			this.state = AutorunState.dependenciesMightHaveChanged;
		}
		this.updateCount++;
	}

	public endUpdate(): void {
		try {
			if (this.updateCount === 1) {
				do {
					if (this.state === AutorunState.dependenciesMightHaveChanged) {
						this.state = AutorunState.upToDate;
						for (const d of this.dependencies) {
							d.reportChanges();
							if (this.state as AutorunState === AutorunState.stale) {
								// The other dependencies will refresh on demand
								break;
							}
						}
					}

					this._runIfNeeded();
				} while (this.state !== AutorunState.upToDate);
			}
		} finally {
			this.updateCount--;
		}

		assertFn(() => this.updateCount >= 0);
	}

	public handlePossibleChange(observable: IObservable<any>): void {
		if (this.state === AutorunState.upToDate && this.dependencies.has(observable) && !this.dependenciesToBeRemoved.has(observable)) {
			this.state = AutorunState.dependenciesMightHaveChanged;
		}
	}

	public handleChange<T, TChange>(observable: IObservableWithChange<T, TChange>, change: TChange): void {
		if (this.dependencies.has(observable) && !this.dependenciesToBeRemoved.has(observable)) {
			try {
				const shouldReact = this._handleChange ? this._handleChange({
					changedObservable: observable,
					change,
					didChange: (o): this is any => o === observable as any,
				}, this.changeSummary!) : true;
				if (shouldReact) {
					this.state = AutorunState.stale;
				}
			} catch (e) {
				onBugIndicatingError(e);
			}
		}
	}

	// IReader implementation
	private _isReaderValid = false;

	public readObservable<T>(observable: IObservable<T>): T {
		if (!this._isReaderValid) { throw new BugIndicatingError('The reader object cannot be used outside its compute function!'); }

		// In case the run action disposes the autorun
		if (this.disposed) {
			return observable.get();
		}

		observable.addObserver(this);
		const value = observable.get();
		this.dependencies.add(observable);
		this.dependenciesToBeRemoved.delete(observable);
		return value;
	}
}

export namespace autorun {
	export const Observer = AutorunObserver;
}
