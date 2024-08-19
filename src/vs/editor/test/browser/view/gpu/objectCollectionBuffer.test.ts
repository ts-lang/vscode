/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, strictEqual, throws } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from 'vs/base/test/common/utils';
import { createObjectCollectionBuffer, type IObjectCollectionBuffer } from 'vs/editor/browser/view/gpu/objectCollectionBuffer';

suite('ObjectCollectionBuffer', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function assertUsedData(buffer: IObjectCollectionBuffer<any>, expected: number[]) {
		deepStrictEqual(Array.from(buffer.view.subarray(0, buffer.viewUsedSize)), expected);
	}

	test('createEntry', () => {
		const buffer = store.add(createObjectCollectionBuffer([
			{ name: 'a' },
			{ name: 'b' },
		] as const, 5));
		assertUsedData(buffer, []);

		store.add(buffer.createEntry({ a: 1, b: 2 }));
		store.add(buffer.createEntry({ a: 3, b: 4 }));
		store.add(buffer.createEntry({ a: 5, b: 6 }));
		store.add(buffer.createEntry({ a: 7, b: 8 }));
		store.add(buffer.createEntry({ a: 9, b: 10 }));
		assertUsedData(buffer, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});

	test('createEntry beyond capacity', () => {
		const buffer = store.add(createObjectCollectionBuffer([
			{ name: 'a' },
			{ name: 'b' },
		] as const, 1));
		store.add(buffer.createEntry({ a: 1, b: 2 }));
		throws(() => buffer.createEntry({ a: 3, b: 4 }));
	});

	test('dispose entry', () => {
		const buffer = store.add(createObjectCollectionBuffer([
			{ name: 'a' },
			{ name: 'b' },
		] as const, 5));
		store.add(buffer.createEntry({ a: 1, b: 2 }));
		const entry1 = buffer.createEntry({ a: 3, b: 4 });
		store.add(buffer.createEntry({ a: 5, b: 6 }));
		const entry2 = buffer.createEntry({ a: 7, b: 8 });
		store.add(buffer.createEntry({ a: 9, b: 10 }));
		entry1.dispose();
		entry2.dispose();
		// Data from disposed entries is stale and doesn't need to be validated
		assertUsedData(buffer, [1, 2, 5, 6, 9, 10]);
	});

	test('entry.get', () => {
		const buffer = store.add(createObjectCollectionBuffer([
			{ name: 'foo' },
			{ name: 'bar' },
		] as const, 5));
		const entry = store.add(buffer.createEntry({ foo: 1, bar: 2 }));
		strictEqual(entry.get('foo'), 1);
		strictEqual(entry.get('bar'), 2);
	});

	test('entry.set', () => {
		const buffer = store.add(createObjectCollectionBuffer([
			{ name: 'foo' },
			{ name: 'bar' },
		] as const, 5));
		const entry = store.add(buffer.createEntry({ foo: 1, bar: 2 }));
		let changeCount = 0;
		store.add(buffer.onDidChange(() => changeCount++));
		entry.set('foo', 3);
		strictEqual(changeCount, 1);
		strictEqual(entry.get('foo'), 3);
		entry.set('bar', 4);
		strictEqual(changeCount, 2);
		strictEqual(entry.get('bar'), 4);
	});
});
