/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import {TPromise} from 'vs/base/common/winjs.base';
import {Range} from 'vs/editor/common/core/range';
import {EditStack} from 'vs/editor/common/model/editStack';
import {ModelLine, ILineEdit, ILineMarker} from 'vs/editor/common/model/modelLine';
import {TextModelWithDecorations, DeferredEventsBuilder} from 'vs/editor/common/model/textModelWithDecorations';
import {IMode} from 'vs/editor/common/modes';
import EditorCommon = require('vs/editor/common/editorCommon');

export interface IDeltaSingleEditOperation {
	original: IValidatedEditOperation;
	deltaStartLineNumber: number;
	deltaStartColumn: number;
	deltaEndLineNumber: number;
	deltaEndColumn: number;
}

export interface IValidatedEditOperation {
	identifier: EditorCommon.ISingleEditOperationIdentifier;
	range: EditorCommon.IEditorRange;
	rangeLength: number;
	lines: string[];
	forceMoveMarkers: boolean;
}

interface IIdentifiedLineEdit extends ILineEdit{
	lineNumber: number;
}

export class EditableTextModel extends TextModelWithDecorations implements EditorCommon.IEditableTextModel {

	private _commandManager:EditStack;

	// for extra details about change events:
	private _isUndoing:boolean;
	private _isRedoing:boolean;

	// editable range
	private _hasEditableRange:boolean;
	private _editableRangeId:string;

	constructor(allowedEventTypes:string[], rawText:EditorCommon.IRawText, modeOrPromise:IMode|TPromise<IMode>) {
		allowedEventTypes.push(EditorCommon.EventType.ModelContentChanged);
		allowedEventTypes.push(EditorCommon.EventType.ModelContentChanged2);
		super(allowedEventTypes, rawText, modeOrPromise);

		this._commandManager = new EditStack(this);

		this._isUndoing = false;
		this._isRedoing = false;

		this._hasEditableRange = false;
		this._editableRangeId = null;
	}

	public dispose(): void {
		this._commandManager = null;
		super.dispose();
	}

	_resetValue(e:EditorCommon.IModelContentChangedFlushEvent, newValue:string): void {
		super._resetValue(e, newValue);

		// Destroy my edit history and settings
		this._commandManager = new EditStack(this);
		this._hasEditableRange = false;
		this._editableRangeId = null;
	}

	public pushStackElement(): void {
		if (this._isDisposed) {
			throw new Error('EditableTextModel.pushStackElement: Model is disposed');
		}

		this._commandManager.pushStackElement();
	}

	public pushEditOperations(beforeCursorState:EditorCommon.IEditorSelection[], editOperations:EditorCommon.IIdentifiedSingleEditOperation[], cursorStateComputer:EditorCommon.ICursorStateComputer): EditorCommon.IEditorSelection[] {
		if (this._isDisposed) {
			throw new Error('EditableTextModel.pushEditOperations: Model is disposed');
		}

		return this._commandManager.pushEditOperation(beforeCursorState, editOperations, cursorStateComputer);
	}

	/**
	 * Transform operations such that they represent the same logic edit,
	 * but that they also do not cause OOM crashes.
	 */
	private _reduceOperations(operations:IValidatedEditOperation[]): IValidatedEditOperation[] {
		if (operations.length < 1000) {
			// We know from empirical testing that a thousand edits work fine regardless of their shape.
			return operations;
		}

		// At one point, due to how events are emitted and how each operation is handled,
		// some operations can trigger a high ammount of temporary string allocations,
		// that will immediately get edited again.
		// e.g. a formatter inserting ridiculous ammounts of \n on a model with a single line
		// Therefore, the strategy is to collapse all the operations into a huge single edit operation
		return [this._toSingleEditOperation(operations)];
	}

	_toSingleEditOperation(operations:IValidatedEditOperation[]): IValidatedEditOperation {
		let forceMoveMarkers = false,
			firstEditRange = operations[0].range,
			lastEditRange = operations[operations.length-1].range,
			entireEditRange = new Range(firstEditRange.startLineNumber, firstEditRange.startColumn, lastEditRange.endLineNumber, lastEditRange.endColumn),
			lastEndLineNumber = firstEditRange.startLineNumber,
			lastEndColumn = firstEditRange.startColumn,
			result: string[] = [];

		for (let i = 0, len = operations.length; i < len; i++) {
			let operation = operations[i],
				range = operation.range;

			forceMoveMarkers = forceMoveMarkers || operation.forceMoveMarkers;

			// (1) -- Push old text
			for (let lineNumber = lastEndLineNumber; lineNumber < range.startLineNumber; lineNumber++) {
				if (lineNumber === lastEndLineNumber) {
					result.push(this._lines[lineNumber - 1].text.substring(lastEndColumn - 1));
				} else {
					result.push('\n');
					result.push(this._lines[lineNumber - 1].text);
				}
			}

			if (range.startLineNumber === lastEndLineNumber) {
				result.push(this._lines[range.startLineNumber - 1].text.substring(lastEndColumn - 1, range.startColumn - 1));
			} else {
				result.push('\n');
				result.push(this._lines[range.startLineNumber - 1].text.substring(0, range.startColumn - 1));
			}

			// (2) -- Push new text
			if (operation.lines) {
				for (let j = 0, lenJ = operation.lines.length; j < lenJ; j++) {
					if (j !== 0) {
						result.push('\n');
					}
					result.push(operation.lines[j]);
				}
			}

			lastEndLineNumber = operation.range.endLineNumber;
			lastEndColumn = operation.range.endColumn;
		}

		return {
			identifier: operations[0].identifier,
			range: entireEditRange,
			rangeLength: this.getValueLengthInRange(entireEditRange),
			lines: result.join('').split('\n'),
			forceMoveMarkers: forceMoveMarkers
		};
	}

	public applyEdits(rawOperations:EditorCommon.IIdentifiedSingleEditOperation[]): EditorCommon.IIdentifiedSingleEditOperation[] {

		let operations:IValidatedEditOperation[] = [];
		for (let i = 0; i < rawOperations.length; i++) {
			let op = rawOperations[i];
			let validatedRange = this.validateRange(op.range);
			operations[i] = {
				identifier: op.identifier,
				range: validatedRange,
				rangeLength: this.getValueLengthInRange(validatedRange),
				lines: op.text ? op.text.split(/\r\n|\r|\n/) : null,
				forceMoveMarkers: op.forceMoveMarkers
			};
		}

		// Sort operations
		operations.sort((a, b) => {
			return Range.compareRangesUsingEnds(a.range, b.range);
		});

		// Operations can not overlap!
		for (let i = operations.length - 2; i >= 0; i--) {
			if (operations[i+1].range.getStartPosition().isBeforeOrEqual(operations[i].range.getEndPosition())) {
				throw new Error('Overlapping ranges are not allowed!');
			}
		}

		// console.log(JSON.stringify(operations, null, '\t'));

		operations = this._reduceOperations(operations);

		let editableRange = this.getEditableRange();
		let editableRangeStart = editableRange.getStartPosition();
		let editableRangeEnd = editableRange.getEndPosition();
		for (let i = 0; i < operations.length; i++) {
			let operationRange = operations[i].range;
			if (!editableRangeStart.isBeforeOrEqual(operationRange.getStartPosition()) || !operationRange.getEndPosition().isBeforeOrEqual(editableRangeEnd)) {
				throw new Error('Editing outside of editable range not allowed!');
			}
		}

		// Delta encode operations
		let deltaOperations = EditableTextModel._toDeltaOperations(operations);
		let reverseRanges = EditableTextModel._getInverseEditRanges(deltaOperations);
		let reverseOperations: EditorCommon.IIdentifiedSingleEditOperation[] = [];
		for (let i = 0; i < operations.length; i++) {
			reverseOperations[i] = {
				identifier: operations[i].identifier,
				range: reverseRanges[i],
				text: this.getValueInRange(operations[i].range),
				forceMoveMarkers: operations[i].forceMoveMarkers
			};
		}

		this._applyEdits(operations);

		return reverseOperations;
	}

	private static _toDeltaOperation(base: IValidatedEditOperation, operation:IValidatedEditOperation): IDeltaSingleEditOperation {
		let deltaStartLineNumber = operation.range.startLineNumber - (base ? base.range.endLineNumber : 0);
		let deltaStartColumn = operation.range.startColumn - (deltaStartLineNumber === 0 ? base.range.endColumn : 0);
		let deltaEndLineNumber = operation.range.endLineNumber - (base ? base.range.endLineNumber : 0);
		let deltaEndColumn = operation.range.endColumn - (deltaEndLineNumber === 0 ? base.range.endColumn : 0);

		return {
			original: operation,
			deltaStartLineNumber: deltaStartLineNumber,
			deltaStartColumn: deltaStartColumn,
			deltaEndLineNumber: deltaEndLineNumber,
			deltaEndColumn: deltaEndColumn
		};
	}

	/**
	 * Assumes `operations` are validated and sorted ascending
	 */
	public static _getInverseEditRanges(operations:IDeltaSingleEditOperation[]): EditorCommon.IEditorRange[] {
		let lineNumber = 0,
			column = 0,
			result:EditorCommon.IEditorRange[] = [];

		for (let i = 0, len = operations.length; i < len; i++) {
			let op = operations[i];

			let startLineNumber = op.deltaStartLineNumber + lineNumber;
			let startColumn = op.deltaStartColumn + (op.deltaStartLineNumber === 0 ? column : 0);
			let resultRange: EditorCommon.IEditorRange;

			if (op.original.lines && op.original.lines.length > 0) {
				// There is something to insert
				if (op.original.lines.length === 1) {
					// Single line insert
					resultRange = new Range(startLineNumber, startColumn, startLineNumber, startColumn + op.original.lines[0].length);
				} else {
					// Multi line insert
					resultRange = new Range(startLineNumber, startColumn, startLineNumber + op.original.lines.length - 1, op.original.lines[op.original.lines.length - 1].length + 1);
				}
			} else {
				// There is nothing to insert
				resultRange = new Range(startLineNumber, startColumn, startLineNumber, startColumn);
			}

			lineNumber = resultRange.endLineNumber;
			column = resultRange.endColumn;

			result.push(resultRange);
		}

		return result;
	}

	private _applyEdits(operations:IValidatedEditOperation[]): void {

		// Note the minus!
		operations = operations.sort((a, b) => -Range.compareRangesUsingEnds(a.range, b.range));

		this._withDeferredEvents((deferredEventsBuilder:DeferredEventsBuilder) => {
			let contentChangedEvents: EditorCommon.IModelContentChangedEvent[] = [];
			let contentChanged2Events: EditorCommon.IModelContentChangedEvent2[] = [];
			let lineEditsQueue: IIdentifiedLineEdit[] = [];

			let queueLineEdit = (lineEdit:IIdentifiedLineEdit) => {
				if (lineEdit.startColumn === lineEdit.endColumn && lineEdit.text.length === 0) {
					// empty edit => ignore it
					return;
				}
				lineEditsQueue.push(lineEdit);
			};

			let flushLineEdits = () => {
				if (lineEditsQueue.length === 0) {
					return;
				}

				lineEditsQueue.reverse();

				// `lineEditsQueue` now contains edits from smaller (line number,column) to larger (line number,column)
				let currentLineNumber = lineEditsQueue[0].lineNumber, currentLineNumberStart = 0;

				for (let i = 1, len = lineEditsQueue.length; i < len; i++) {
					let lineNumber = lineEditsQueue[i].lineNumber;

					if (lineNumber === currentLineNumber) {
						continue;
					}

					this._invalidateLine(currentLineNumber - 1);
					this._lines[currentLineNumber - 1].applyEdits(deferredEventsBuilder.changedMarkers, lineEditsQueue.slice(currentLineNumberStart, i));
					contentChangedEvents.push(this._createLineChangedEvent(currentLineNumber));

					currentLineNumber = lineNumber;
					currentLineNumberStart = i;
				}

				this._invalidateLine(currentLineNumber - 1);
				this._lines[currentLineNumber - 1].applyEdits(deferredEventsBuilder.changedMarkers, lineEditsQueue.slice(currentLineNumberStart, lineEditsQueue.length));
				contentChangedEvents.push(this._createLineChangedEvent(currentLineNumber));

				lineEditsQueue = [];
			};

			let minTouchedLineNumber = operations[operations.length - 1].range.startLineNumber;
			let maxTouchedLineNumber = operations[0].range.endLineNumber + 1;
			let totalLinesCountDelta = 0;

			for (let i = 0, len = operations.length; i < len; i++) {
				let op = operations[i];

				// console.log();
				// console.log('-------------------');
				// console.log('OPERATION #' + (i));
				// console.log('op: ', op);
				// console.log('<<<\n' + this._lines.map(l => l.text).join('\n') + '\n>>>');

				let startLineNumber = op.range.startLineNumber;
				let startColumn = op.range.startColumn;
				let endLineNumber = op.range.endLineNumber;
				let endColumn = op.range.endColumn;

				if (startLineNumber === endLineNumber && startColumn === endColumn && (!op.lines || op.lines.length === 0)) {
					// no-op
					continue;
				}

				let deletingLinesCnt = endLineNumber - startLineNumber;
				let insertingLinesCnt = (op.lines ? op.lines.length - 1 : 0);
				let editingLinesCnt = Math.min(deletingLinesCnt, insertingLinesCnt);

				totalLinesCountDelta += (insertingLinesCnt - deletingLinesCnt);

				// Iterating descending to overlap with previous op
				// in case there are common lines being edited in both
				for (let j = editingLinesCnt; j >= 0; j--) {
					let editLineNumber = startLineNumber + j;

					queueLineEdit({
						lineNumber: editLineNumber,
						startColumn: (editLineNumber === startLineNumber ? startColumn : 1),
						endColumn: (editLineNumber === endLineNumber ? endColumn : this.getLineMaxColumn(editLineNumber)),
						text: (op.lines ? op.lines[j] : ''),
						forceMoveMarkers: op.forceMoveMarkers
					});
				}

				if (editingLinesCnt < deletingLinesCnt) {
					// Must delete some lines

					// Flush any pending line edits
					flushLineEdits();

					let spliceStartLineNumber = startLineNumber + editingLinesCnt;
					let spliceStartColumn = this.getLineMaxColumn(spliceStartLineNumber);

					let endLineRemains = this._lines[endLineNumber - 1].split(deferredEventsBuilder.changedMarkers, endColumn, false);
					this._invalidateLine(spliceStartLineNumber - 1);

					let spliceCnt = endLineNumber - spliceStartLineNumber;

					// Collect all these markers
					let markersOnDeletedLines: ILineMarker[] = [];
					for (let j = 0; j < spliceCnt; j++) {
						let deleteLineIndex = spliceStartLineNumber + j;
						markersOnDeletedLines = markersOnDeletedLines.concat(this._lines[deleteLineIndex].deleteLine(deferredEventsBuilder.changedMarkers, spliceStartColumn, deleteLineIndex + 1));
					}

					this._lines.splice(spliceStartLineNumber, spliceCnt);

					// Reconstruct first line
					this._lines[spliceStartLineNumber - 1].append(deferredEventsBuilder.changedMarkers, endLineRemains);
					this._lines[spliceStartLineNumber - 1].addMarkers(markersOnDeletedLines);
					contentChangedEvents.push(this._createLineChangedEvent(spliceStartLineNumber));

					contentChangedEvents.push(this._createLinesDeletedEvent(spliceStartLineNumber + 1, spliceStartLineNumber + spliceCnt));
				}

				if (editingLinesCnt < insertingLinesCnt) {
					// Must insert some lines

					// Flush any pending line edits
					flushLineEdits();

					let spliceLineNumber = startLineNumber + editingLinesCnt;
					let spliceColumn = (spliceLineNumber === startLineNumber ? startColumn : 1);
					if (op.lines) {
						spliceColumn += op.lines[editingLinesCnt].length;
					}

					// Split last line
					let leftoverLine = this._lines[spliceLineNumber - 1].split(deferredEventsBuilder.changedMarkers, spliceColumn, op.forceMoveMarkers);
					contentChangedEvents.push(this._createLineChangedEvent(spliceLineNumber));
					this._invalidateLine(spliceLineNumber - 1);

					// Lines in the middle
					let newLinesContent:string[] = [];
					for (let j = editingLinesCnt + 1; j <= insertingLinesCnt; j++) {
						let newLineNumber = startLineNumber + j;
						this._lines.splice(newLineNumber - 1, 0, new ModelLine(newLineNumber, op.lines[j]));
						newLinesContent.push(op.lines[j]);
					}
					newLinesContent[newLinesContent.length - 1] += leftoverLine.text;

					// Last line
					this._lines[startLineNumber + insertingLinesCnt - 1].append(deferredEventsBuilder.changedMarkers, leftoverLine);
					contentChangedEvents.push(this._createLinesInsertedEvent(spliceLineNumber + 1, startLineNumber + insertingLinesCnt, newLinesContent.join('\n')));
				}

				contentChanged2Events.push({
					range: new Range(startLineNumber, startColumn, endLineNumber, endColumn),
					rangeLength: op.rangeLength,
					text: op.lines ? op.lines.join(this.getEOL()) : '',
					eol: this._EOL,
					versionId: -1,
					isUndoing: this._isUndoing,
					isRedoing: this._isRedoing
				});

				// console.log('AFTER:');
				// console.log('<<<\n' + this._lines.map(l => l.text).join('\n') + '\n>>>');
			}

			flushLineEdits();

			maxTouchedLineNumber = Math.max(1, Math.min(this.getLineCount(), maxTouchedLineNumber + totalLinesCountDelta));
			if (totalLinesCountDelta !== 0) {
				// must update line numbers all the way to the bottom
				maxTouchedLineNumber = this.getLineCount();
			}

			for (let lineNumber = minTouchedLineNumber; lineNumber <= maxTouchedLineNumber; lineNumber++) {
				this._lines[lineNumber - 1].updateLineNumber(deferredEventsBuilder.changedMarkers, lineNumber);
			}

			if (contentChangedEvents.length !== 0 || contentChanged2Events.length !== 0) {
				if (contentChangedEvents.length === 0) {
					// Fabricate a fake line changed event to get an event out
					// This most likely occurs when there edit operations are no-ops
					contentChangedEvents.push(this._createLineChangedEvent(minTouchedLineNumber));
				}

				let versionBumps = Math.max(contentChangedEvents.length, contentChanged2Events.length);
				let finalVersionId = this.getVersionId() + versionBumps;
				this._setVersionId(finalVersionId);

				for (let i = contentChangedEvents.length - 1, versionId = finalVersionId; i >= 0; i--, versionId--) {
					contentChangedEvents[i].versionId = versionId;
				}
				for (let i = contentChanged2Events.length - 1, versionId = finalVersionId; i >= 0; i--, versionId--) {
					contentChanged2Events[i].versionId = versionId;
				}

				for (let i = 0, len = contentChangedEvents.length; i < len; i++) {
					this.emit(EditorCommon.EventType.ModelContentChanged, contentChangedEvents[i]);
				}
				for (let i = 0, len = contentChanged2Events.length; i < len; i++) {
					this.emit(EditorCommon.EventType.ModelContentChanged2, contentChanged2Events[i]);
				}
			}

			// this._assertLineNumbersOK();
		});
	}

	public _assertLineNumbersOK(): void {
		let foundMarkersCnt = 0;
		for (let i = 0, len = this._lines.length; i < len; i++) {
			let line = this._lines[i];
			let lineNumber = i + 1;

			if (line.lineNumber !== lineNumber) {
				throw new Error('Invalid lineNumber at line: ' + lineNumber + '; text is: ' + this.getValue());
			}

			let markers = line.getMarkers();
			for (let j = 0, lenJ = markers.length; j < lenJ; j++) {
				foundMarkersCnt++;
				let markerId = markers[j].id;
				let marker = this._markerIdToMarker[markerId];
				if (marker.line !== line) {
					throw new Error('Misplaced marker with id ' + markerId);
				}
			}
		}

		let totalMarkersCnt = Object.keys(this._markerIdToMarker).length;
		if (totalMarkersCnt !== foundMarkersCnt) {
			throw new Error('There are misplaced markers!');
		}
	}

	public static _toDeltaOperations(operations:IValidatedEditOperation[]): IDeltaSingleEditOperation[] {
		let result: IDeltaSingleEditOperation[] = [];
		for (let i = 0; i < operations.length; i++) {
			result[i] = EditableTextModel._toDeltaOperation(i > 0 ? operations[i-1] : null, operations[i]);
		}
		return result;
	}

	public undo(): EditorCommon.IEditorSelection[] {
		if (this._isDisposed) {
			throw new Error('EditableTextModel.undo: Model is disposed');
		}

		return this._withDeferredEvents(() => {
			this._isUndoing = true;
			let r = this._commandManager.undo();
			this._isUndoing = false;

			if (!r) {
				return null;
			}

			this._overwriteAlternativeVersionId(r.recordedVersionId);

			return r.selections;
		});
	}

	public redo(): EditorCommon.IEditorSelection[] {
		if (this._isDisposed) {
			throw new Error('EditableTextModel.redo: Model is disposed');
		}

		return this._withDeferredEvents(() => {
			this._isRedoing = true;
			let r = this._commandManager.redo();
			this._isRedoing = false;

			if (!r) {
				return null;
			}

			this._overwriteAlternativeVersionId(r.recordedVersionId);

			return r.selections;
		});
	}

	public setEditableRange(range:EditorCommon.IRange): void {
		if (this._isDisposed) {
			throw new Error('EditableTextModel.setEditableRange: Model is disposed');
		}

		this._commandManager.clear();
		if (this._hasEditableRange) {
			this.removeTrackedRange(this._editableRangeId);
			this._editableRangeId = null;
			this._hasEditableRange = false;
		}

		if (range) {
			this._hasEditableRange = true;
			this._editableRangeId = this.addTrackedRange(range, EditorCommon.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges);
		}
	}

	public hasEditableRange(): boolean {
		if (this._isDisposed) {
			throw new Error('EditableTextModel.hasEditableRange: Model is disposed');
		}

		return this._hasEditableRange;
	}

	public getEditableRange(): EditorCommon.IEditorRange {
		if (this._isDisposed) {
			throw new Error('EditableTextModel.getEditableRange: Model is disposed');
		}

		if (this._hasEditableRange) {
			return this.getTrackedRange(this._editableRangeId);
		} else {
			return this.getFullModelRange();
		}
	}

	private _createLineChangedEvent(lineNumber: number): EditorCommon.IModelContentChangedLineChangedEvent {
		return {
			changeType: EditorCommon.EventType.ModelContentChangedLineChanged,
			lineNumber: lineNumber,
			detail: this._lines[lineNumber - 1].text,
			versionId: -1,
			isUndoing: this._isUndoing,
			isRedoing: this._isRedoing
		};
	}

	private _createLinesDeletedEvent(fromLineNumber: number, toLineNumber: number): EditorCommon.IModelContentChangedLinesDeletedEvent {
		return {
			changeType: EditorCommon.EventType.ModelContentChangedLinesDeleted,
			fromLineNumber: fromLineNumber,
			toLineNumber: toLineNumber,
			versionId: -1,
			isUndoing: this._isUndoing,
			isRedoing: this._isRedoing
		};
	}

	private _createLinesInsertedEvent(fromLineNumber: number, toLineNumber: number, newLinesContent: string): EditorCommon.IModelContentChangedLinesInsertedEvent {
		return {
			changeType: EditorCommon.EventType.ModelContentChangedLinesInserted,
			fromLineNumber: fromLineNumber,
			toLineNumber: toLineNumber,
			detail: newLinesContent,
			versionId: -1,
			isUndoing: this._isUndoing,
			isRedoing: this._isRedoing
		};
	}
}