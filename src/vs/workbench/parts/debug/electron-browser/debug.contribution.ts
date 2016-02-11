/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!../browser/media/debug.contribution';
import 'vs/css!../browser/media/debugHover';
import nls = require('vs/nls');
import lifecycle = require('vs/base/common/lifecycle');
import { KeyMod, KeyCode } from 'vs/base/common/keyCodes';
import { CommonEditorRegistry, ContextKey, EditorActionDescriptor } from 'vs/editor/common/editorCommonExtensions';
import { SyncActionDescriptor } from 'vs/platform/actions/common/actions';
import platform = require('vs/platform/platform');
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { KeybindingsRegistry } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { KbExpr, IKeybindings } from 'vs/platform/keybinding/common/keybindingService';
import { EditorBrowserRegistry } from 'vs/editor/browser/editorBrowserExtensions';
import wbaregistry = require('vs/workbench/common/actionRegistry');
import viewlet = require('vs/workbench/browser/viewlet');
import panel = require('vs/workbench/browser/panel');
import wbext = require('vs/workbench/common/contributions');
import * as debug from 'vs/workbench/parts/debug/common/debug';
import { DebugEditorModelManager } from 'vs/workbench/parts/debug/browser/debugEditorModelManager';
import dbgactions = require('vs/workbench/parts/debug/electron-browser/debugActions');
import debugwidget = require('vs/workbench/parts/debug/browser/debugActionsWidget');
import service = require('vs/workbench/parts/debug/electron-browser/debugService');
import { DebugEditorContribution } from 'vs/workbench/parts/debug/browser/debugEditorContribution';
import { IViewletService } from 'vs/workbench/services/viewlet/common/viewletService';
import { IActivityService, IconBadge, NumberBadge, ProgressBadge } from 'vs/workbench/services/activity/common/activityService';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';

import IDebugService = debug.IDebugService;

class OpenDebugViewletAction extends viewlet.ToggleViewletAction {
	public static ID = debug.VIEWLET_ID;
	public static LABEL = nls.localize('toggleDebugViewlet', "Show Debug");

	constructor(
		id: string,
		label: string,
		@IViewletService viewletService: IViewletService,
		@IWorkbenchEditorService editorService: IWorkbenchEditorService
	) {
		super(id, label, debug.VIEWLET_ID, viewletService, editorService);
	}
}

class StatusUpdater implements wbext.IWorkbenchContribution {
	static ID = 'Monaco.IDE.UI.Viewlets.DebugViewlet.Workbench.StatusUpdater';

	private toDispose: lifecycle.IDisposable[];
	private pausedBadge: ProgressBadge;
	private runningBadge: IconBadge;

	constructor(
		@IActivityService private activityService: IActivityService,
		@IDebugService private debugService: IDebugService
	) {
		this.pausedBadge = new IconBadge(() => { return nls.localize('debugPaused', "Paused"); });
		this.runningBadge = new ProgressBadge(() => { return nls.localize('debugRunning', "Running"); });
		this.toDispose = [this.debugService.addListener2(debug.ServiceEvents.STATE_CHANGED, () => this.onDebugServiceStateChange())];
	}

	private onDebugServiceStateChange(): void {
		if (this.debugService.getState() === debug.State.Stopped) {
			this.activityService.showActivity(debug.VIEWLET_ID, this.pausedBadge, 'debug-viewlet-paused-label');
		} else if (this.debugService.getState() === debug.State.Running) {
			this.activityService.showActivity(debug.VIEWLET_ID, this.runningBadge, 'debug-viewlet-running-label');
		} else {
			this.activityService.clearActivity(debug.VIEWLET_ID);
		}
	}

	public getId(): string {
		return StatusUpdater.ID;
	}

	public dispose(): void {
		this.toDispose = lifecycle.disposeAll(this.toDispose);
	}
}

EditorBrowserRegistry.registerEditorContribution(DebugEditorContribution);
CommonEditorRegistry.registerEditorAction(new EditorActionDescriptor(dbgactions.ToggleBreakpointAction, dbgactions.ToggleBreakpointAction.ID, nls.localize('toggleBreakpointAction', "Debug: Toggle Breakpoint"), {
	context: ContextKey.EditorTextFocus,
	primary: KeyCode.F9
}));
CommonEditorRegistry.registerEditorAction(new EditorActionDescriptor(dbgactions.EditorConditionalBreakpointAction, dbgactions.EditorConditionalBreakpointAction.ID, nls.localize('conditionalBreakpointEditorAction', "Debug: Conditional Breakpoint")));
CommonEditorRegistry.registerEditorAction(new EditorActionDescriptor(dbgactions.SelectionToReplAction, dbgactions.SelectionToReplAction.ID, nls.localize('debugEvaluate', "Debug: Evaluate")));
CommonEditorRegistry.registerEditorAction(new EditorActionDescriptor(dbgactions.SelectionToWatchExpressionsAction, dbgactions.SelectionToWatchExpressionsAction.ID, nls.localize('addToWatch', "Debug: Add to Watch")));
CommonEditorRegistry.registerEditorAction(new EditorActionDescriptor(dbgactions.RunToCursorAction, dbgactions.RunToCursorAction.ID, nls.localize('runToCursor', "Debug: Run to Cursor")));

// register viewlet
(<viewlet.ViewletRegistry>platform.Registry.as(viewlet.Extensions.Viewlets)).registerViewlet(new viewlet.ViewletDescriptor(
	'vs/workbench/parts/debug/browser/debugViewlet',
	'DebugViewlet',
	debug.VIEWLET_ID,
	nls.localize('debug', "Debug"),
	'debug',
	40
));

const openViewletKb: IKeybindings = {
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KEY_D
};

// register repl panel
(<panel.PanelRegistry>platform.Registry.as(panel.Extensions.Panels)).registerPanel(new panel.PanelDescriptor(
	'vs/workbench/parts/debug/browser/repl',
	'Repl',
	debug.REPL_ID,
	nls.localize('debugConsole', "Debug Console"),
	'repl'
));
(<panel.PanelRegistry>platform.Registry.as(panel.Extensions.Panels)).setDefaultPanelId(debug.REPL_ID);

// register action to open viewlet
const registry = (<wbaregistry.IWorkbenchActionRegistry> platform.Registry.as(wbaregistry.Extensions.WorkbenchActions));
registry.registerWorkbenchAction(new SyncActionDescriptor(OpenDebugViewletAction, OpenDebugViewletAction.ID, OpenDebugViewletAction.LABEL, openViewletKb), nls.localize('view', "View"));

(<wbext.IWorkbenchContributionsRegistry>platform.Registry.as(wbext.Extensions.Workbench)).registerWorkbenchContribution(DebugEditorModelManager);
(<wbext.IWorkbenchContributionsRegistry>platform.Registry.as(wbext.Extensions.Workbench)).registerWorkbenchContribution(debugwidget.DebugActionsWidget);

const debugCategory = nls.localize('debugCategory', "Debug");
registry.registerWorkbenchAction(new SyncActionDescriptor(
	dbgactions.StartDebugAction, dbgactions.StartDebugAction.ID, dbgactions.StartDebugAction.LABEL, { primary: KeyCode.F5 }, KbExpr.not(debug.CONTEXT_IN_DEBUG_MODE)), debugCategory);
registry.registerWorkbenchAction(new SyncActionDescriptor(dbgactions.StepOverDebugAction, dbgactions.StepOverDebugAction.ID, dbgactions.StepOverDebugAction.LABEL, { primary: KeyCode.F10 }, KbExpr.has(debug.CONTEXT_IN_DEBUG_MODE)), debugCategory);
registry.registerWorkbenchAction(new SyncActionDescriptor(dbgactions.StepIntoDebugAction, dbgactions.StepIntoDebugAction.ID, dbgactions.StepIntoDebugAction.LABEL, { primary: KeyCode.F11 }, KbExpr.has(debug.CONTEXT_IN_DEBUG_MODE), KeybindingsRegistry.WEIGHT.workbenchContrib(1)), debugCategory);
registry.registerWorkbenchAction(new SyncActionDescriptor(dbgactions.StepOutDebugAction, dbgactions.StepOutDebugAction.ID, dbgactions.StepOutDebugAction.LABEL, { primary: KeyMod.Shift | KeyCode.F11 }, KbExpr.has(debug.CONTEXT_IN_DEBUG_MODE)), debugCategory);
registry.registerWorkbenchAction(new SyncActionDescriptor(dbgactions.RestartDebugAction, dbgactions.RestartDebugAction.ID, dbgactions.RestartDebugAction.LABEL), debugCategory);
registry.registerWorkbenchAction(new SyncActionDescriptor(dbgactions.StopDebugAction, dbgactions.StopDebugAction.ID, dbgactions.StopDebugAction.LABEL, { primary: KeyMod.Shift | KeyCode.F5 }, KbExpr.has(debug.CONTEXT_IN_DEBUG_MODE)), debugCategory);
registry.registerWorkbenchAction(new SyncActionDescriptor(dbgactions.ContinueAction, dbgactions.ContinueAction.ID, dbgactions.ContinueAction.LABEL, { primary: KeyCode.F5 }, KbExpr.has(debug.CONTEXT_IN_DEBUG_MODE)), debugCategory);
registry.registerWorkbenchAction(new SyncActionDescriptor(dbgactions.PauseAction, dbgactions.PauseAction.ID, dbgactions.PauseAction.LABEL), debugCategory);
registry.registerWorkbenchAction(new SyncActionDescriptor(dbgactions.ConfigureAction, dbgactions.ConfigureAction.ID, dbgactions.ConfigureAction.LABEL), debugCategory);
registry.registerWorkbenchAction(new SyncActionDescriptor(dbgactions.ToggleReplAction, dbgactions.ToggleReplAction.ID, dbgactions.ToggleReplAction.LABEL, { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KEY_Y,}), debugCategory);
registry.registerWorkbenchAction(new SyncActionDescriptor(dbgactions.AddFunctionBreakpointAction, dbgactions.AddFunctionBreakpointAction.ID, dbgactions.AddFunctionBreakpointAction.LABEL), debugCategory);
registry.registerWorkbenchAction(new SyncActionDescriptor(dbgactions.ReapplyBreakpointsAction, dbgactions.ReapplyBreakpointsAction.ID, dbgactions.ReapplyBreakpointsAction.LABEL), debugCategory);

// register service
registerSingleton(IDebugService, service.DebugService);

// Register StatusUpdater
(<wbext.IWorkbenchContributionsRegistry>platform.Registry.as(wbext.Extensions.Workbench)).registerWorkbenchContribution(
	StatusUpdater
);
