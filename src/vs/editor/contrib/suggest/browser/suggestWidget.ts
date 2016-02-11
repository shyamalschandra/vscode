/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./suggest';
import * as nls from 'vs/nls';
import { TPromise } from 'vs/base/common/winjs.base';
import { IDisposable, disposeAll } from 'vs/base/common/lifecycle';
import { assign } from 'vs/base/common/objects';
import Event, { Emitter } from 'vs/base/common/event';
import { append, addClass, removeClass, toggleClass, emmet as $, hide, show, addDisposableListener } from 'vs/base/browser/dom';
import { IRenderer, IDelegate, IFocusChangeEvent, ISelectionChangeEvent } from 'vs/base/browser/ui/list/list';
import { List } from 'vs/base/browser/ui/list/listWidget';
import * as HighlightedLabel from 'vs/base/browser/ui/highlightedlabel/highlightedLabel';
import { SuggestModel, ICancelEvent, ISuggestEvent, ITriggerEvent } from './suggestModel';
import * as Mouse from 'vs/base/browser/mouseEvent';
import * as EditorBrowser from 'vs/editor/browser/editorBrowser';
import * as EditorCommon from 'vs/editor/common/editorCommon';
import * as Timer from 'vs/base/common/timer';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { SuggestRegistry, CONTEXT_SUGGESTION_SUPPORTS_ACCEPT_ON_KEY } from '../common/suggest';
import { IKeybindingService, IKeybindingContextKey } from 'vs/platform/keybinding/common/keybindingService';
import { ISuggestSupport, ISuggestResult, ISuggestion, ISuggestionFilter } from 'vs/editor/common/modes';
import { DefaultFilter, IMatch } from 'vs/editor/common/modes/modesFilters';
import { ISuggestResult2 } from '../common/suggest';
import URI from 'vs/base/common/uri';
import { isFalsyOrEmpty } from 'vs/base/common/arrays';
import { onUnexpectedError, isPromiseCanceledError, illegalArgument } from 'vs/base/common/errors';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ScrollableElement } from 'vs/base/browser/ui/scrollbar/scrollableElementImpl';

function completionGroupCompare(one: CompletionGroup, other: CompletionGroup): number {
	return one.index - other.index;
}

function completionItemCompare(item: CompletionItem, otherItem: CompletionItem): number {
	const suggestion = item.suggestion;
	const otherSuggestion = otherItem.suggestion;

	if (typeof suggestion.sortText === 'string' && typeof otherSuggestion.sortText === 'string') {
		const one = suggestion.sortText.toLowerCase();
		const other = otherSuggestion.sortText.toLowerCase();

		if (one < other) {
			return -1;
		} else if (one > other) {
			return 1;
		}
	}

	return suggestion.label.toLowerCase() < otherSuggestion.label.toLowerCase() ? -1 : 1;
}

class CompletionItem {

	private static _idPool: number = 0;

	id: string;
	suggestion: ISuggestion;
	highlights: IMatch[];
	support: ISuggestSupport;
	container: ISuggestResult;

	constructor(public group: CompletionGroup, suggestion: ISuggestion, container: ISuggestResult2) {
		this.id = String(CompletionItem._idPool++);
		this.support = container.support;
		this.suggestion = suggestion;
		this.container = container;
	}

	resolveDetails(resource: URI, position: EditorCommon.IPosition): TPromise<ISuggestion> {
		if (!this.support || typeof this.support.getSuggestionDetails !== 'function') {
			return TPromise.as(this.suggestion);
		}

		return this.support.getSuggestionDetails(resource, position, this.suggestion);
	}

	updateDetails(value: ISuggestion): void {
		this.suggestion = assign(this.suggestion, value);
	}
}

class CompletionGroup {

	incomplete: boolean;
	private _items: CompletionItem[];
	private cache: CompletionItem[];
	private cacheCurrentWord: string;
	size: number;
	filter: ISuggestionFilter;

	constructor(public model: CompletionModel, public index: number, raw: ISuggestResult2[]) {
		this.incomplete = false;
		this.size = 0;

		this._items = raw.reduce<CompletionItem[]>((items, result) => {
			this.incomplete = result.incomplete || this.incomplete;
			this.size += result.suggestions.length;

			return items.concat(
				result.suggestions
					.map(suggestion => new CompletionItem(this, suggestion, result))
			);
		}, []).sort(completionItemCompare);

		this.filter = DefaultFilter;

		if (this._items.length > 0) {
			const [first] = this._items;

			if (first.support) {
				this.filter = first.support.getFilter && first.support.getFilter() || this.filter;
			}
		}
	}

	getItems(currentWord: string): CompletionItem[] {
		if (currentWord === this.cacheCurrentWord) {
			return this.cache;
		}

		let set: CompletionItem[];

		// try to narrow down when possible, instead of always filtering everything
		if (this.cacheCurrentWord && currentWord.substr(0, this.cacheCurrentWord.length) === this.cacheCurrentWord) {
			set = this.cache;
		} else {
			set = this._items;
		}

		const result = set.filter(item => {
			item.highlights = this.filter(currentWord, item.suggestion);
			return !isFalsyOrEmpty(item.highlights);
		});

		// let's only cache stuff that actually has results
		if (result.length > 0) {
			this.cacheCurrentWord = currentWord;
			this.cache = result;
		}

		return result;
	}
}

class CompletionModel {

	incomplete: boolean;
	size: number;
	private groups: CompletionGroup[];
	private cache: CompletionItem[];
	private cacheCurrentWord: string;

	constructor(public raw: ISuggestResult2[][], public currentWord: string) {
		this.incomplete = false;
		this.size = 0;

		this.groups = raw
			.filter(s => !!s)
			.map((suggestResults, index) => {
				const group = new CompletionGroup(this, index, suggestResults);

				this.incomplete = group.incomplete || this.incomplete;
				this.size += group.size;

				return group;
			})
			.sort(completionGroupCompare);
	}

	get items(): CompletionItem[] {
		if (this.cacheCurrentWord === this.currentWord) {
			return this.cache;
		}

		const result = this.groups.reduce((r, groups) => r.concat(groups.getItems(this.currentWord)), []);

		// let's only cache stuff that actually has results
		if (result.length > 0) {
			this.cache = result;
			this.cacheCurrentWord = this.currentWord;
		}

		return result;
	}
}

function isRoot(element: any): boolean {
	return element instanceof CompletionModel;
}

interface ISuggestionTemplateData {
	root: HTMLElement;
	icon: HTMLElement;
	colorspan: HTMLElement;
	highlightedLabel: HighlightedLabel.HighlightedLabel;
	typeLabel: HTMLElement;
	documentationDetails: HTMLElement;
	documentation: HTMLElement;
}

class Renderer implements IRenderer<CompletionItem, ISuggestionTemplateData> {

	private triggerKeybindingLabel: string;

	constructor(
		private widget: SuggestWidget,
		@IKeybindingService keybindingService: IKeybindingService
	) {
		const keybindings = keybindingService.lookupKeybindings('editor.action.triggerSuggest');
		this.triggerKeybindingLabel = keybindings.length === 0 ? '' : ` (${keybindingService.getLabelFor(keybindings[0])})`;
	}

	get templateId(): string {
		return 'suggestion';
	}

	renderTemplate(container: HTMLElement): ISuggestionTemplateData {
		const data = <ISuggestionTemplateData>Object.create(null);
		data.root = container;

		data.icon = append(container, $('.icon'));
		data.colorspan = append(data.icon, $('span.colorspan'));

		const text = append(container, $('.text'));
		const main = append(text, $('.main'));
		data.highlightedLabel = new HighlightedLabel.HighlightedLabel(main);
		data.typeLabel = append(main, $('span.type-label'));
		const docs = append(text, $('.docs'));
		data.documentation = append(docs, $('span.docs-text'));
		data.documentationDetails = append(docs, $('span.docs-details.octicon.octicon-info'));
		data.documentationDetails.title = nls.localize('readMore', "Read More...{0}", this.triggerKeybindingLabel);

		return data;
	}

	renderElement(element: CompletionItem, index: number, templateData: ISuggestionTemplateData): void {
		const data = <ISuggestionTemplateData>templateData;
		const suggestion = (<CompletionItem>element).suggestion;

		if (suggestion.type && suggestion.type.charAt(0) === '#') {
			data.root.setAttribute('aria-label', 'color');
			data.icon.className = 'icon customcolor';
			data.colorspan.style.backgroundColor = suggestion.type.substring(1);
		} else {
			data.root.setAttribute('aria-label', suggestion.type);
			data.icon.className = 'icon ' + suggestion.type;
			data.colorspan.style.backgroundColor = '';
		}

		data.highlightedLabel.set(suggestion.label, (<CompletionItem>element).highlights);
		data.typeLabel.textContent = suggestion.typeLabel || '';
		data.documentation.textContent = suggestion.documentationLabel || '';

		if (suggestion.documentationLabel) {
			show(data.documentationDetails);

			data.documentationDetails.onclick = e => {
				e.stopPropagation();
				e.preventDefault();
				this.widget.toggleDetails();
			};
		} else {
			hide(data.documentationDetails);
			data.documentationDetails.onclick = null;
		}
	}

	disposeTemplate(templateData: ISuggestionTemplateData): void {
		templateData.highlightedLabel.dispose();
	}
}

const FocusHeight = 35;
const UnfocusedHeight = 19;

class Delegate implements IDelegate<CompletionItem> {

	constructor(private listProvider: () => List<CompletionItem>) { }

	getHeight(element: CompletionItem): number {
		const focus = this.listProvider().getFocus()[0];

		if (element.suggestion.documentationLabel && element === focus) {
			return FocusHeight;
		}

		return UnfocusedHeight;
	}

	getTemplateId(element: CompletionItem): string {
		return 'suggestion';
	}
}

function computeScore(suggestion: string, currentWord: string, currentWordLowerCase: string): number {
	const suggestionLowerCase = suggestion.toLowerCase();
	let score = 0;

	for (let i = 0; i < currentWord.length && i < suggestion.length; i++) {
		if (currentWord[i] === suggestion[i]) {
			score += 2;
		} else if (currentWordLowerCase[i] === suggestionLowerCase[i]) {
			score += 1;
		} else {
			break;
		}
	}

	return score;
}

interface ITelemetryData {
	suggestionCount?: number;
	suggestedIndex?: number;
	selectedIndex?: number;
	hintLength?: number;
	wasCancelled?: boolean;
	wasAutomaticallyTriggered?: boolean;
}

enum State {
	Hidden,
	Loading,
	Empty,
	Open,
	Frozen,
	Details
}

class SuggestionDetails {

	private el: HTMLElement;
	private title: HTMLElement;
	private back: HTMLElement;
	private scrollable: ScrollableElement;
	private body: HTMLElement;
	private type: HTMLElement;
	private docs: HTMLElement;

	constructor(container: HTMLElement, private widget: SuggestWidget) {
		this.el = append(container, $('.details'));
		const header = append(this.el, $('.header'));
		this.title = append(header, $('span.title'));
		this.back = append(header, $('span.go-back.octicon.octicon-mail-reply'));
		this.back.title = nls.localize('goback', "Go back");
		this.body = $('.body');
		this.scrollable = new ScrollableElement(this.body, {});
		append(this.el, this.scrollable.getDomNode());
		this.type = append(this.body, $('p.type'));
		this.docs = append(this.body, $('p.docs'));
	}

	get element() {
		return this.el;
	}

	render(item: CompletionItem): void {
		if (!item) {
			this.title.textContent = '';
			this.type.textContent = '';
			this.docs.textContent = '';
			return;
		}

		this.title.innerText = item.suggestion.label;
		this.type.innerText = item.suggestion.typeLabel || '';
		this.docs.innerText = item.suggestion.documentationLabel;
		this.back.onclick = e => {
			e.preventDefault();
			e.stopPropagation();
			this.widget.toggleDetails();
		};

		this.scrollable.onElementDimensions();
		this.scrollable.onElementInternalDimensions();
	}

	scrollDown(much = 8): void {
		this.body.scrollTop += much;
	}

	scrollUp(much = 8): void {
		this.body.scrollTop -= much;
	}

	pageDown(): void {
		this.scrollDown(80);
	}

	pageUp(): void {
		this.scrollUp(80);
	}

	dispose(): void {
		this.el.parentElement.removeChild(this.el);
		this.el = null;
	}
}

export class SuggestWidget implements EditorBrowser.IContentWidget, IDisposable {

	static ID: string = 'editor.widget.suggestWidget';
	static WIDTH: number = 438;

	static LOADING_MESSAGE: string = nls.localize('suggestWidget.loading', "Loading...");
	static NO_SUGGESTIONS_MESSAGE: string = nls.localize('suggestWidget.noSuggestions', "No suggestions.");

	public allowEditorOverflow: boolean = true; // Editor.IContentWidget.allowEditorOverflow

	private state: State;
	private isAuto: boolean;
	private shouldShowEmptySuggestionList: boolean;
	private suggestionSupportsAutoAccept: IKeybindingContextKey<boolean>;
	private loadingTimeout: number;
	private currentSuggestionDetails: TPromise<void>;
	private focusedItem: CompletionItem;
	private completionModel: CompletionModel;

	private telemetryData: ITelemetryData;
	private telemetryService: ITelemetryService;
	private telemetryTimer: Timer.ITimerEvent;

	private element: HTMLElement;
	private messageElement: HTMLElement;
	private listElement: HTMLElement;
	private details: SuggestionDetails;
	private delegate: IDelegate<CompletionItem>;
	private list: List<CompletionItem>;

	private toDispose: IDisposable[];

	private _onDidVisibilityChange: Emitter<boolean> = new Emitter();
	public get onDidVisibilityChange(): Event<boolean> { return this._onDidVisibilityChange.event; }

	constructor(
		private editor: EditorBrowser.ICodeEditor,
		private model: SuggestModel,
		@IKeybindingService keybindingService: IKeybindingService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		this.isAuto = false;
		this.focusedItem = null;
		this.suggestionSupportsAutoAccept = keybindingService.createKey(CONTEXT_SUGGESTION_SUPPORTS_ACCEPT_ON_KEY, true);

		this.telemetryData = null;
		this.telemetryService = telemetryService;

		this.element = $('.editor-widget.suggest-widget.monaco-editor-background');
		this.element.style.width = SuggestWidget.WIDTH + 'px';
		this.element.style.top = '0';
		this.element.style.left = '0';

		if (!this.editor.getConfiguration().iconsInSuggestions) {
			addClass(this.element, 'no-icons');
		}

		this.messageElement = append(this.element, $('.message'));
		this.listElement = append(this.element, $('.tree'));
		this.details = new SuggestionDetails(this.element, this);

		let renderer: IRenderer<CompletionItem, any> = instantiationService.createInstance(Renderer, this);

		this.delegate = new Delegate(() => this.list);
		this.list = new List(this.listElement, this.delegate, [renderer]);

		this.toDispose = [
			editor.addListener2(EditorCommon.EventType.ModelChanged, () => this.onModelModeChanged()),
			editor.addListener2(EditorCommon.EventType.ModelModeChanged, () => this.onModelModeChanged()),
			editor.addListener2(EditorCommon.EventType.ModelModeSupportChanged, (e: EditorCommon.IModeSupportChangedEvent) => e.suggestSupport && this.onModelModeChanged()),
			SuggestRegistry.onDidChange(() => this.onModelModeChanged()),
			editor.addListener2(EditorCommon.EventType.EditorTextBlur, () => this.onEditorBlur()),
			this.list.onSelectionChange(e => this.onListSelection(e)),
			this.list.onFocusChange(e => this.onListFocus(e)),
			this.editor.addListener2(EditorCommon.EventType.CursorSelectionChanged, () => this.onCursorSelectionChanged()),
			this.model.onDidTrigger(e => this.onDidTrigger(e)),
			this.model.onDidSuggest(e => this.onDidSuggest(e)),
			this.model.onDidCancel(e => this.onDidCancel(e))
		];

		this.onModelModeChanged();
		this.editor.addContentWidget(this);
		this.setState(State.Hidden);
	}

	private onCursorSelectionChanged(): void {
		if (this.state === State.Hidden) {
			return;
		}

		this.editor.layoutContentWidget(this);
	}

	private onEditorBlur(): void {
		TPromise.timeout(150).done(() => {
			if (!this.editor.isFocused()) {
				this.setState(State.Hidden);
			}
		});
	}

	private onListSelection(e: ISelectionChangeEvent<CompletionItem>): void {
		if (!e.elements.length) {
			return;
		}

		setTimeout(() => {
			this.telemetryData.selectedIndex = 0;
			this.telemetryData.wasCancelled = false;
			this.telemetryData.selectedIndex = e.indexes[0];
			this.submitTelemetryData();

			const item = e.elements[0];
			const container = item.container;
			const overwriteBefore = (typeof item.suggestion.overwriteBefore === 'undefined') ? container.currentWord.length : item.suggestion.overwriteBefore;
			const overwriteAfter = (typeof item.suggestion.overwriteAfter === 'undefined') ? 0 : Math.max(0, item.suggestion.overwriteAfter);
			this.model.accept(item.suggestion, overwriteBefore, overwriteAfter);

			this.editor.focus();
		}, 0);
	}

	private onListFocus(e: IFocusChangeEvent<CompletionItem>): void {
		if (this.currentSuggestionDetails) {
			this.currentSuggestionDetails.cancel();
			this.currentSuggestionDetails = null;
		}

		if (!e.elements.length) {
			return;
		}

		const item = e.elements[0];

		if (item === this.focusedItem) {
			return;
		}

		const index = e.indexes[0];

		this.suggestionSupportsAutoAccept.set(item.suggestion.noAutoAccept);
		this.focusedItem = item;
		this.list.setFocus(index);
		this.updateWidgetHeight();
		this.list.reveal(index);

		const resource = this.editor.getModel().getAssociatedResource();
		const position = this.model.getRequestPosition() || this.editor.getPosition();

		this.currentSuggestionDetails = item.resolveDetails(resource, position)
			.then(details => {
				item.updateDetails(details);
				this.list.setFocus(index);
				this.updateWidgetHeight();
				this.list.reveal(index);
			})
			.then(null, err => !isPromiseCanceledError(err) && onUnexpectedError(err))
			.then(() => this.currentSuggestionDetails = null);
	}

	private onModelModeChanged(): void {
		const model = this.editor.getModel();
		const supports = SuggestRegistry.all(model);
		this.shouldShowEmptySuggestionList = supports.some(s => s.shouldShowEmptySuggestionList());
	}

	private setState(state: State): void {
		const stateChanged = this.state !== state;
		this.state = state;

		toggleClass(this.element, 'frozen', state === State.Frozen);

		switch (state) {
			case State.Hidden:
				hide(this.messageElement, this.details.element);
				show(this.listElement);
				this.hide();
				if (stateChanged) {
					this.list.splice(0, this.list.length);
				}
				break;
			case State.Loading:
				this.messageElement.innerText = SuggestWidget.LOADING_MESSAGE;
				hide(this.listElement, this.details.element);
				show(this.messageElement);
				this.show();
				break;
			case State.Empty:
				this.messageElement.innerText = SuggestWidget.NO_SUGGESTIONS_MESSAGE;
				hide(this.listElement, this.details.element);
				show(this.messageElement);
				this.show();
				break;
			case State.Open:
				hide(this.messageElement, this.details.element);
				show(this.listElement);
				this.show();
				break;
			case State.Frozen:
				hide(this.messageElement, this.details.element);
				show(this.listElement);
				this.show();
				break;
			case State.Details:
				hide(this.messageElement, this.listElement);
				show(this.details.element);
				this.show();
				break;
		}

		if (stateChanged) {
			this.editor.layoutContentWidget(this);
		}
	}

	private onDidTrigger(e: ITriggerEvent) {
		if (this.state !== State.Hidden) {
			return;
		}

		this.telemetryTimer = this.telemetryService.start('suggestWidgetLoadingTime');
		this.isAuto = !!e.auto;

		if (!this.isAuto) {
			this.loadingTimeout = setTimeout(() => {
				this.loadingTimeout = null;
				this.setState(State.Loading);
			}, 50);
		}

		if (!e.retrigger) {
			this.telemetryData = {
				wasAutomaticallyTriggered: e.characterTriggered
			};
		}
	}

	private onDidSuggest(e: ISuggestEvent): void {
		clearTimeout(this.loadingTimeout);

		let promise = TPromise.as(null);
		let visibleCount: number;

		if (this.completionModel && this.completionModel.raw === e.suggestions) {
			const oldCurrentWord = this.completionModel.currentWord;
			this.completionModel.currentWord = e.currentWord;
			visibleCount = this.completionModel.items.length;

			if (!e.auto && visibleCount === 0) {
				this.completionModel.currentWord = oldCurrentWord;

				if (this.completionModel.items.length > 0) {
					this.setState(State.Frozen);
				} else {
					this.setState(State.Empty);
				}

				return;
			}
		} else {
			this.completionModel = new CompletionModel(e.suggestions, e.currentWord);
			visibleCount = this.completionModel.items.length;
		}

		const isEmpty = visibleCount === 0;

		if (isEmpty) {
			if (e.auto) {
				this.setState(State.Hidden);
			} else {
				if (this.shouldShowEmptySuggestionList) {
					this.setState(State.Empty);
				} else {
					this.setState(State.Hidden);
				}
			}

			this.completionModel = null;

		} else {
			const currentWord = e.currentWord;
			const currentWordLowerCase = currentWord.toLowerCase();
			let bestSuggestionIndex = -1;
			let bestScore = -1;

			this.completionModel.items.forEach((item, index) => {
				const score = computeScore(item.suggestion.label, currentWord, currentWordLowerCase);

				if (score > bestScore) {
					bestScore = score;
					bestSuggestionIndex = index;
				}
			});

			this.telemetryData = this.telemetryData || {};
			this.telemetryData.suggestionCount = this.completionModel.items.length;
			this.telemetryData.suggestedIndex = bestSuggestionIndex;
			this.telemetryData.hintLength = currentWord.length;

			this.list.splice(0, this.list.length, ...this.completionModel.items);
			this.list.setFocus(bestSuggestionIndex);
			this.list.reveal(bestSuggestionIndex, 0);

			this.setState(State.Open);
		}

		if (this.telemetryTimer) {
			this.telemetryTimer.data = { reason: isEmpty ? 'empty' : 'results' };
			this.telemetryTimer.stop();
			this.telemetryTimer = null;
		}
	}

	private onDidCancel(e: ICancelEvent) {
		clearTimeout(this.loadingTimeout);

		if (!e.retrigger) {
			this.setState(State.Hidden);

			if (this.telemetryData) {
				this.telemetryData.selectedIndex = -1;
				this.telemetryData.wasCancelled = true;
				this.submitTelemetryData();
			}
		}

		if (this.telemetryTimer) {
			this.telemetryTimer.data = { reason: 'cancel' };
			this.telemetryTimer.stop();
			this.telemetryTimer = null;
		}
	}

	public selectNextPage(): boolean {
		switch (this.state) {
			case State.Hidden:
				return false;
			case State.Details:
				this.details.pageDown();
				return true;
			case State.Loading:
				return !this.isAuto;
			default:
				this.list.focusNextPage();
				return true;
		}
	}

	public selectNext(): boolean {
		switch (this.state) {
			case State.Hidden:
				return false;
			case State.Details:
				this.details.scrollDown();
				return true;
			case State.Loading:
				return !this.isAuto;
			default:
				this.list.focusNext(1, true);
				return true;
		}
	}

	public selectPreviousPage(): boolean {
		switch (this.state) {
			case State.Hidden:
				return false;
			case State.Details:
				this.details.pageUp();
				return true;
			case State.Loading:
				return !this.isAuto;
			default:
				this.list.focusPreviousPage();
				return true;
		}
	}

	public selectPrevious(): boolean {
		switch (this.state) {
			case State.Hidden:
				return false;
			case State.Details:
				this.details.scrollUp();
				return true;
			case State.Loading:
				return !this.isAuto;
			default:
				this.list.focusPrevious(1, true);
				return true;
		}
	}

	public acceptSelectedSuggestion(): boolean {
		switch (this.state) {
			case State.Hidden:
				return false;
			case State.Loading:
				return !this.isAuto;
			default:
				const focus = this.list.getFocus()[0];
				if (focus) {
					this.list.setSelection(this.completionModel.items.indexOf(focus));
				} else {
					this.model.cancel();
				}
				return true;
		}
	}

	public toggleDetails(): void {
		if (this.state === State.Details) {
			this.setState(State.Open);
			this.editor.focus();
			return;
		}

		if (this.state !== State.Open) {
			return;
		}

		const item = this.list.getFocus()[0];

		if (!item || !item.suggestion.documentationLabel) {
			return;
		}

		this.setState(State.Details);
		this.editor.focus();
	}

	private show(): void {
		this.updateWidgetHeight();
		this._onDidVisibilityChange.fire(true);
		this.renderDetails();
		TPromise.timeout(100).done(() => {
			addClass(this.element, 'visible');
		});
	}

	private hide(): void {
		this._onDidVisibilityChange.fire(false);
		removeClass(this.element, 'visible');
	}

	public cancel(): void {
		if (this.state === State.Details) {
			this.toggleDetails();
		} else {
			this.model.cancel();
		}
	}

	public getPosition(): EditorBrowser.IContentWidgetPosition {
		if (this.state === State.Hidden) {
			return null;
		}

		return {
			position: this.editor.getPosition(),
			preference: [EditorBrowser.ContentWidgetPositionPreference.BELOW, EditorBrowser.ContentWidgetPositionPreference.ABOVE]
		};
	}

	public getDomNode(): HTMLElement {
		return this.element;
	}

	public getId(): string {
		return SuggestWidget.ID;
	}

	private submitTelemetryData(): void {
		this.telemetryService.publicLog('suggestWidget', this.telemetryData);
		this.telemetryData = null;
	}

	private updateWidgetHeight(): number {
		let height = 0;

		if (this.state === State.Empty || this.state === State.Loading) {
			height = UnfocusedHeight;
		} else if (this.state === State.Details) {
			height = 12 * UnfocusedHeight;
		} else {
			const focus = this.list.getFocus()[0];
			const focusHeight = focus ? this.delegate.getHeight(focus) : UnfocusedHeight;
			height = focusHeight;

			const suggestionCount = (this.list.contentHeight - focusHeight) / UnfocusedHeight;
			height += Math.min(suggestionCount, 11) * UnfocusedHeight;
		}

		this.element.style.height = height + 'px';
		this.list.layout(height);
		this.editor.layoutContentWidget(this);

		return height;
	}

	private renderDetails(): void {
		if (this.state !== State.Details) {
			this.details.render(null);
		} else {
			this.details.render(this.list.getFocus()[0]);
		}
	}

	public dispose(): void {
		this.state = null;
		this.suggestionSupportsAutoAccept = null;
		this.currentSuggestionDetails = null;
		this.focusedItem = null;
		this.telemetryData = null;
		this.telemetryService = null;
		this.telemetryTimer = null;
		this.element = null;
		this.messageElement = null;
		this.listElement = null;
		this.details.dispose();
		this.details = null;
		this.list.dispose();
		this.list = null;
		this.toDispose = disposeAll(this.toDispose);
		this._onDidVisibilityChange.dispose();
		this._onDidVisibilityChange = null;
	}
}
