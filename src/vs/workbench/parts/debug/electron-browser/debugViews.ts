/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import * as resources from 'vs/base/common/resources';
import { RunOnceScheduler, sequence } from 'vs/base/common/async';
import * as dom from 'vs/base/browser/dom';
import * as builder from 'vs/base/browser/builder';
import { TPromise } from 'vs/base/common/winjs.base';
import * as errors from 'vs/base/common/errors';
import { IAction } from 'vs/base/common/actions';
import { prepareActions } from 'vs/workbench/browser/actions';
import { IHighlightEvent, ITree } from 'vs/base/parts/tree/browser/tree';
import { Tree } from 'vs/base/parts/tree/browser/treeImpl';
import { CollapseAction } from 'vs/workbench/browser/viewlet';
import { ViewsViewletPanel, IViewletViewOptions, IViewOptions } from 'vs/workbench/browser/parts/views/viewsViewlet';
import { IDebugService, State, IBreakpoint, IExpression, CONTEXT_BREAKPOINTS_FOCUSED, CONTEXT_WATCH_EXPRESSIONS_FOCUSED, CONTEXT_VARIABLES_FOCUSED } from 'vs/workbench/parts/debug/common/debug';
import { Expression, Variable, ExceptionBreakpoint, FunctionBreakpoint, Thread, StackFrame, Breakpoint, ThreadAndProcessIds } from 'vs/workbench/parts/debug/common/debugModel';
import * as viewer from 'vs/workbench/parts/debug/electron-browser/debugViewer';
import { AddWatchExpressionAction, RemoveAllWatchExpressionsAction, AddFunctionBreakpointAction, ToggleBreakpointsActivatedAction, RemoveAllBreakpointsAction } from 'vs/workbench/parts/debug/browser/debugActions';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { MenuId } from 'vs/platform/actions/common/actions';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IContextKeyService, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import { IListService } from 'vs/platform/list/browser/listService';
import { attachListStyler } from 'vs/platform/theme/common/styler';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { once } from 'vs/base/common/event';

function renderViewTree(container: HTMLElement): HTMLElement {
	const treeContainer = document.createElement('div');
	dom.addClass(treeContainer, 'debug-view-content');
	container.appendChild(treeContainer);
	return treeContainer;
}

const $ = builder.$;
const twistiePixels = 20;

export class VariablesView extends ViewsViewletPanel {

	private static readonly MEMENTO = 'variablesview.memento';
	private onFocusStackFrameScheduler: RunOnceScheduler;
	private variablesFocusedContext: IContextKey<boolean>;
	private settings: any;
	private expandedElements: any[];

	constructor(
		options: IViewletViewOptions,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IDebugService private debugService: IDebugService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IListService private listService: IListService,
		@IThemeService private themeService: IThemeService
	) {
		super({ ...(options as IViewOptions), ariaHeaderLabel: nls.localize('variablesSection', "Variables Section") }, keybindingService, contextMenuService);

		this.settings = options.viewletSettings;
		this.variablesFocusedContext = CONTEXT_VARIABLES_FOCUSED.bindTo(contextKeyService);
		this.expandedElements = [];
		// Use scheduler to prevent unnecessary flashing
		this.onFocusStackFrameScheduler = new RunOnceScheduler(() => {
			// Remember expanded elements when there are some (otherwise don't override/erase the previous ones)
			const expanded = this.tree.getExpandedElements();
			if (expanded.length > 0) {
				this.expandedElements = expanded;
			}

			// Always clear tree highlight to avoid ending up in a broken state #12203
			this.tree.clearHighlight();
			this.tree.refresh().then(() => {
				const stackFrame = this.debugService.getViewModel().focusedStackFrame;
				return sequence(this.expandedElements.map(e => () => this.tree.expand(e))).then(() => {
					// If there is no preserved expansion state simply expand the first scope
					if (stackFrame && this.tree.getExpandedElements().length === 0) {
						return stackFrame.getScopes().then(scopes => {
							if (scopes.length > 0 && !scopes[0].expensive) {
								return this.tree.expand(scopes[0]);
							}
							return undefined;
						});
					}
					return undefined;
				});
			}).done(null, errors.onUnexpectedError);
		}, 400);
	}

	public renderBody(container: HTMLElement): void {
		dom.addClass(container, 'debug-variables');
		this.treeContainer = renderViewTree(container);

		this.tree = new Tree(this.treeContainer, {
			dataSource: new viewer.VariablesDataSource(),
			renderer: this.instantiationService.createInstance(viewer.VariablesRenderer),
			accessibilityProvider: new viewer.VariablesAccessibilityProvider(),
			controller: this.instantiationService.createInstance(viewer.VariablesController, new viewer.VariablesActionProvider(this.debugService, this.keybindingService), MenuId.DebugVariablesContext)
		}, {
				ariaLabel: nls.localize('variablesAriaTreeLabel', "Debug Variables"),
				twistiePixels,
				keyboardSupport: false
			});

		this.disposables.push(attachListStyler(this.tree, this.themeService));
		this.disposables.push(this.listService.register(this.tree, [this.variablesFocusedContext]));

		const viewModel = this.debugService.getViewModel();

		this.tree.setInput(viewModel);

		const collapseAction = new CollapseAction(this.tree, false, 'explorer-action collapse-explorer');
		this.toolbar.setActions(prepareActions([collapseAction]))();

		this.disposables.push(viewModel.onDidFocusStackFrame(sf => {
			// Refresh the tree immediately if it is not visible.
			// Otherwise postpone the refresh until user stops stepping.
			if (!this.tree.getContentHeight() || sf.explicit) {
				this.onFocusStackFrameScheduler.schedule(0);
			} else {
				this.onFocusStackFrameScheduler.schedule();
			}
		}));
		this.disposables.push(this.debugService.onDidChangeState(state => {
			collapseAction.enabled = state === State.Running || state === State.Stopped;
		}));

		this.disposables.push(this.debugService.getViewModel().onDidSelectExpression(expression => {
			if (!expression || !(expression instanceof Variable)) {
				return;
			}

			this.tree.refresh(expression, false).then(() => {
				this.tree.setHighlight(expression);
				once(this.tree.onDidChangeHighlight)((e: IHighlightEvent) => {
					if (!e.highlight) {
						this.debugService.getViewModel().setSelectedExpression(null);
					}
				});
			}).done(null, errors.onUnexpectedError);
		}));
	}

	public shutdown(): void {
		this.settings[VariablesView.MEMENTO] = !this.isExpanded();
		super.shutdown();
	}
}

export class WatchExpressionsView extends ViewsViewletPanel {

	private static readonly MEMENTO = 'watchexpressionsview.memento';
	private onWatchExpressionsUpdatedScheduler: RunOnceScheduler;
	private toReveal: IExpression;
	private watchExpressionsFocusedContext: IContextKey<boolean>;
	private settings: any;

	constructor(
		options: IViewletViewOptions,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IDebugService private debugService: IDebugService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IListService private listService: IListService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IThemeService private themeService: IThemeService
	) {
		super({ ...(options as IViewOptions), ariaHeaderLabel: nls.localize('expressionsSection', "Expressions Section") }, keybindingService, contextMenuService);
		this.settings = options.viewletSettings;

		this.disposables.push(this.debugService.getModel().onDidChangeWatchExpressions(we => {
			// only expand when a new watch expression is added.
			if (we instanceof Expression) {
				this.setExpanded(true);
			}
		}));
		this.watchExpressionsFocusedContext = CONTEXT_WATCH_EXPRESSIONS_FOCUSED.bindTo(contextKeyService);

		this.onWatchExpressionsUpdatedScheduler = new RunOnceScheduler(() => {
			this.tree.refresh().done(() => {
				return this.toReveal instanceof Expression ? this.tree.reveal(this.toReveal) : TPromise.as(true);
			}, errors.onUnexpectedError);
		}, 50);
	}

	public renderBody(container: HTMLElement): void {
		dom.addClass(container, 'debug-watch');
		this.treeContainer = renderViewTree(container);

		const actionProvider = new viewer.WatchExpressionsActionProvider(this.debugService, this.keybindingService);
		this.tree = new Tree(this.treeContainer, {
			dataSource: new viewer.WatchExpressionsDataSource(),
			renderer: this.instantiationService.createInstance(viewer.WatchExpressionsRenderer),
			accessibilityProvider: new viewer.WatchExpressionsAccessibilityProvider(),
			controller: this.instantiationService.createInstance(viewer.WatchExpressionsController, actionProvider, MenuId.DebugWatchContext),
			dnd: this.instantiationService.createInstance(viewer.WatchExpressionsDragAndDrop)
		}, {
				ariaLabel: nls.localize({ comment: ['Debug is a noun in this context, not a verb.'], key: 'watchAriaTreeLabel' }, "Debug Watch Expressions"),
				twistiePixels,
				keyboardSupport: false
			});

		this.disposables.push(attachListStyler(this.tree, this.themeService));
		this.disposables.push(this.listService.register(this.tree, [this.watchExpressionsFocusedContext]));

		this.tree.setInput(this.debugService.getModel());

		const addWatchExpressionAction = new AddWatchExpressionAction(AddWatchExpressionAction.ID, AddWatchExpressionAction.LABEL, this.debugService, this.keybindingService);
		const collapseAction = new CollapseAction(this.tree, true, 'explorer-action collapse-explorer');
		const removeAllWatchExpressionsAction = new RemoveAllWatchExpressionsAction(RemoveAllWatchExpressionsAction.ID, RemoveAllWatchExpressionsAction.LABEL, this.debugService, this.keybindingService);
		this.toolbar.setActions(prepareActions([addWatchExpressionAction, collapseAction, removeAllWatchExpressionsAction]))();

		this.disposables.push(this.debugService.getModel().onDidChangeWatchExpressions(we => {
			if (!this.onWatchExpressionsUpdatedScheduler.isScheduled()) {
				this.onWatchExpressionsUpdatedScheduler.schedule();
			}
			this.toReveal = we;
		}));

		this.disposables.push(this.debugService.getViewModel().onDidSelectExpression(expression => {
			if (!expression || !(expression instanceof Expression)) {
				return;
			}

			this.tree.refresh(expression, false).then(() => {
				this.tree.setHighlight(expression);
				once(this.tree.onDidChangeHighlight)((e: IHighlightEvent) => {
					if (!e.highlight) {
						this.debugService.getViewModel().setSelectedExpression(null);
					}
				});
			}).done(null, errors.onUnexpectedError);
		}));
	}

	public shutdown(): void {
		this.settings[WatchExpressionsView.MEMENTO] = !this.isExpanded();
		super.shutdown();
	}
}

export class CallStackView extends ViewsViewletPanel {

	private static readonly MEMENTO = 'callstackview.memento';
	private pauseMessage: builder.Builder;
	private pauseMessageLabel: builder.Builder;
	private onCallStackChangeScheduler: RunOnceScheduler;
	private settings: any;

	constructor(
		private options: IViewletViewOptions,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IDebugService private debugService: IDebugService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IListService private listService: IListService,
		@IThemeService private themeService: IThemeService
	) {
		super({ ...(options as IViewOptions), ariaHeaderLabel: nls.localize('callstackSection', "Call Stack Section") }, keybindingService, contextMenuService);
		this.settings = options.viewletSettings;

		// Create scheduler to prevent unnecessary flashing of tree when reacting to changes
		this.onCallStackChangeScheduler = new RunOnceScheduler(() => {
			let newTreeInput: any = this.debugService.getModel();
			const processes = this.debugService.getModel().getProcesses();
			if (!this.debugService.getViewModel().isMultiProcessView() && processes.length) {
				const threads = processes[0].getAllThreads();
				// Only show the threads in the call stack if there is more than 1 thread.
				newTreeInput = threads.length === 1 ? threads[0] : processes[0];
			}

			// Only show the global pause message if we do not display threads.
			// Otherwise there will be a pause message per thread and there is no need for a global one.
			if (newTreeInput instanceof Thread && newTreeInput.stoppedDetails) {
				this.pauseMessageLabel.text(newTreeInput.stoppedDetails.description || nls.localize('debugStopped', "Paused on {0}", newTreeInput.stoppedDetails.reason));
				if (newTreeInput.stoppedDetails.text) {
					this.pauseMessageLabel.title(newTreeInput.stoppedDetails.text);
				}
				newTreeInput.stoppedDetails.reason === 'exception' ? this.pauseMessageLabel.addClass('exception') : this.pauseMessageLabel.removeClass('exception');
				this.pauseMessage.show();
			} else {
				this.pauseMessage.hide();
			}

			(this.tree.getInput() === newTreeInput ? this.tree.refresh() : this.tree.setInput(newTreeInput))
				.done(() => this.updateTreeSelection(), errors.onUnexpectedError);
		}, 50);
	}

	protected renderHeaderTitle(container: HTMLElement): void {
		const title = $('.title.debug-call-stack-title').appendTo(container);
		$('span').text(this.options.name).appendTo(title);
		this.pauseMessage = $('span.pause-message').appendTo(title);
		this.pauseMessage.hide();
		this.pauseMessageLabel = $('span.label').appendTo(this.pauseMessage);
	}

	public renderBody(container: HTMLElement): void {
		dom.addClass(container, 'debug-call-stack');
		this.treeContainer = renderViewTree(container);
		const actionProvider = this.instantiationService.createInstance(viewer.CallStackActionProvider);
		const controller = this.instantiationService.createInstance(viewer.CallStackController, actionProvider, MenuId.DebugCallStackContext);

		this.tree = new Tree(this.treeContainer, {
			dataSource: this.instantiationService.createInstance(viewer.CallStackDataSource),
			renderer: this.instantiationService.createInstance(viewer.CallStackRenderer),
			accessibilityProvider: this.instantiationService.createInstance(viewer.CallstackAccessibilityProvider),
			controller
		}, {
				ariaLabel: nls.localize({ comment: ['Debug is a noun in this context, not a verb.'], key: 'callStackAriaLabel' }, "Debug Call Stack"),
				twistiePixels,
				keyboardSupport: false
			});

		this.disposables.push(attachListStyler(this.tree, this.themeService));
		this.disposables.push(this.listService.register(this.tree));

		this.disposables.push(this.tree.onDidChangeSelection(event => {
			if (event && event.payload && event.payload.origin === 'keyboard') {
				const element = this.tree.getFocus();
				if (element instanceof ThreadAndProcessIds) {
					controller.showMoreStackFrames(this.tree, element);
				} else if (element instanceof StackFrame) {
					controller.focusStackFrame(element, event, false);
				}
			}
		}));

		this.disposables.push(this.debugService.getModel().onDidChangeCallStack(() => {
			if (!this.onCallStackChangeScheduler.isScheduled()) {
				this.onCallStackChangeScheduler.schedule();
			}
		}));
		this.disposables.push(this.debugService.getViewModel().onDidFocusStackFrame(() =>
			this.updateTreeSelection().done(undefined, errors.onUnexpectedError)));

		// Schedule the update of the call stack tree if the viewlet is opened after a session started #14684
		if (this.debugService.state === State.Stopped) {
			this.onCallStackChangeScheduler.schedule();
		}
	}

	private updateTreeSelection(): TPromise<void> {
		if (!this.tree.getInput()) {
			// Tree not initialized yet
			return TPromise.as(null);
		}

		const stackFrame = this.debugService.getViewModel().focusedStackFrame;
		const thread = this.debugService.getViewModel().focusedThread;
		const process = this.debugService.getViewModel().focusedProcess;
		if (!thread) {
			if (!process) {
				this.tree.clearSelection();
				return TPromise.as(null);
			}

			this.tree.setSelection([process]);
			return this.tree.reveal(process);
		}

		return this.tree.expandAll([thread.process, thread]).then(() => {
			if (!stackFrame) {
				return TPromise.as(null);
			}

			this.tree.setSelection([stackFrame]);
			return this.tree.reveal(stackFrame);
		});
	}

	public shutdown(): void {
		this.settings[CallStackView.MEMENTO] = !this.isExpanded();
		super.shutdown();
	}
}

export class BreakpointsView extends ViewsViewletPanel {

	private static readonly MAX_VISIBLE_FILES = 9;
	private static readonly MEMENTO = 'breakopintsview.memento';
	private breakpointsFocusedContext: IContextKey<boolean>;
	private settings: any;

	constructor(
		options: IViewletViewOptions,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IDebugService private debugService: IDebugService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IListService private listService: IListService,
		@IThemeService private themeService: IThemeService
	) {
		super({
			...(options as IViewOptions),
			ariaHeaderLabel: nls.localize('breakpointsSection', "Breakpoints Section")
		}, keybindingService, contextMenuService);

		this.minimumBodySize = this.maximumBodySize = this.getExpandedBodySize();
		this.settings = options.viewletSettings;
		this.breakpointsFocusedContext = CONTEXT_BREAKPOINTS_FOCUSED.bindTo(contextKeyService);
		this.disposables.push(this.debugService.getModel().onDidChangeBreakpoints(() => this.onBreakpointsChange()));
	}

	public renderBody(container: HTMLElement): void {
		dom.addClass(container, 'debug-breakpoints');
		this.treeContainer = renderViewTree(container);
		const actionProvider = new viewer.BreakpointsActionProvider(this.debugService, this.keybindingService, );
		const controller = this.instantiationService.createInstance(viewer.BreakpointsController, actionProvider, MenuId.DebugBreakpointsContext);

		this.tree = new Tree(this.treeContainer, {
			dataSource: new viewer.BreakpointsDataSource(),
			renderer: this.instantiationService.createInstance(viewer.BreakpointsRenderer),
			accessibilityProvider: this.instantiationService.createInstance(viewer.BreakpointsAccessibilityProvider),
			controller,
			sorter: {
				compare(tree: ITree, element: any, otherElement: any): number {
					const first = <IBreakpoint>element;
					const second = <IBreakpoint>otherElement;
					if (first instanceof ExceptionBreakpoint) {
						return -1;
					}
					if (second instanceof ExceptionBreakpoint) {
						return 1;
					}
					if (first instanceof FunctionBreakpoint) {
						return -1;
					}
					if (second instanceof FunctionBreakpoint) {
						return 1;
					}

					if (first.uri.toString() !== second.uri.toString()) {
						return resources.basenameOrAuthority(first.uri).localeCompare(resources.basenameOrAuthority(second.uri));
					}
					if (first.lineNumber === second.lineNumber) {
						return first.column - second.column;
					}

					return first.lineNumber - second.lineNumber;
				}
			}
		}, {
				ariaLabel: nls.localize({ comment: ['Debug is a noun in this context, not a verb.'], key: 'breakpointsAriaTreeLabel' }, "Debug Breakpoints"),
				twistiePixels,
				keyboardSupport: false
			});

		this.disposables.push(attachListStyler(this.tree, this.themeService));
		this.disposables.push(this.listService.register(this.tree, [this.breakpointsFocusedContext]));

		this.disposables.push(this.tree.onDidChangeSelection(event => {
			if (event && event.payload && event.payload.origin === 'keyboard') {
				const element = this.tree.getFocus();
				if (element instanceof Breakpoint) {
					controller.openBreakpointSource(element, event, false);
				}
			}
		}));

		const debugModel = this.debugService.getModel();

		this.tree.setInput(debugModel);

		this.disposables.push(this.debugService.getViewModel().onDidSelectFunctionBreakpoint(fbp => {
			if (!fbp || !(fbp instanceof FunctionBreakpoint)) {
				return;
			}

			this.tree.refresh(fbp, false).then(() => {
				this.tree.setHighlight(fbp);
				once(this.tree.onDidChangeHighlight)((e: IHighlightEvent) => {
					if (!e.highlight) {
						this.debugService.getViewModel().setSelectedFunctionBreakpoint(null);
					}
				});
			}).done(null, errors.onUnexpectedError);
		}));
	}

	public getActions(): IAction[] {
		return [
			new AddFunctionBreakpointAction(AddFunctionBreakpointAction.ID, AddFunctionBreakpointAction.LABEL, this.debugService, this.keybindingService),
			new ToggleBreakpointsActivatedAction(ToggleBreakpointsActivatedAction.ID, ToggleBreakpointsActivatedAction.ACTIVATE_LABEL, this.debugService, this.keybindingService),
			new RemoveAllBreakpointsAction(RemoveAllBreakpointsAction.ID, RemoveAllBreakpointsAction.LABEL, this.debugService, this.keybindingService)
		];
	}

	private onBreakpointsChange(): void {
		this.minimumBodySize = this.getExpandedBodySize();
		if (this.maximumBodySize < Number.POSITIVE_INFINITY) {
			this.maximumBodySize = this.minimumBodySize;
		}
		if (this.tree) {
			this.tree.refresh();
		}
	}

	private getExpandedBodySize(): number {
		const model = this.debugService.getModel();
		const length = model.getBreakpoints().length + model.getExceptionBreakpoints().length + model.getFunctionBreakpoints().length;
		return Math.min(BreakpointsView.MAX_VISIBLE_FILES, length) * 22;
	}

	public shutdown(): void {
		this.settings[BreakpointsView.MEMENTO] = !this.isExpanded();
		super.shutdown();
	}
}
