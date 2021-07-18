/*
 * This file is part of the Forge Window Manager extension for Gnome 3
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

// Gnome imports
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

// Gnome Shell imports
const DND = imports.ui.dnd;

// Extension imports
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

// App imports
const Logger = Me.imports.logger;
const Tree = Me.imports.tree;
const Utils = Me.imports.utils;

var WINDOW_MODES = Utils.createEnum([
    'FLOAT',
    'TILE',
    'LAYOUT',
]);

var ForgeWindowManager = GObject.registerClass(
    class ForgeWindowManager extends GObject.Object {
        _init() {
            super._init();
            this._tree = new Tree.Tree(this);
            Logger.info("forge initialized");
        }

        _applyNodeWindowMode(action, metaWindow) {
            let nodeWindow = this._findNodeWindow(metaWindow);
            if (!nodeWindow || !(action || action.mode)) return;
            if (nodeWindow._type !== Tree.NODE_TYPES['WINDOW']) return;

            let floatFlag = action.mode === WINDOW_MODES['FLOAT'];

            if (floatFlag) {
                let floating = nodeWindow.mode === WINDOW_MODES['FLOAT'];
                if (!floating) {
                    nodeWindow.mode = WINDOW_MODES['FLOAT'];
                } else {
                    nodeWindow.mode = WINDOW_MODES['TILE'];
                }
            } else {
                nodeWindow.mode = WINDOW_MODES['TILE'];
            }
        }

        /**
         * This is the central place to bind all the non-window signals.
         */
        _bindSignals() {
            if (this._signalsBound)
                return;

            const display = global.display;
            const shellWm = global.window_manager;

            this._displaySignals = [
                display.connect("window-created", this._trackWindow.bind(this)),
                display.connect("window-entered-monitor", this._updateMetaWorkspaceMonitor.bind(this)),
                display.connect("window-left-monitor", () => {
                    Logger.debug(`window-left-monitor`);
                }),
                display.connect("grab-op-end", (_, _display, _metaWindow, _grabOp) => {
                    this.unfreezeRender();
                    if (this.focusMetaWindow && this.focusMetaWindow.get_maximized() === 0) {
                        this.renderTree("grab-op-end");
                    }
                    Logger.debug(`grab op end`);
                }),
                display.connect("grab-op-begin", (_, _display, metaWindow, grabOp) => {
                    this.freezeRender();
                    let nodeWindow = this._findNodeWindow(metaWindow);
                    if (nodeWindow) nodeWindow._grabOp = grabOp;
                    Logger.debug(`grab op begin ${grabOp}`);
                }),
                display.connect("showing-desktop-changed", () => {
                    Logger.debug(`display:showing-desktop-changed`);
                }),
                display.connect("workareas-changed", (_display) => {
                    this._reloadTree("workareas-changed");
                    Logger.debug(`workareas-changed`);
                }),
            ];

            this._windowManagerSignals = [
                shellWm.connect("minimize", () => {
                    this.hideWindowBorders();
                    this.renderTree("minimize");
                    Logger.debug(`minimize`);
                }),
                shellWm.connect("unminimize", () => {
                    this.renderTree("unminimize");
                    Logger.debug(`unminimize`);
                }),
                shellWm.connect("show-tile-preview", (_, _metaWindow, _rect, _num) => {
                    Logger.debug(`show-tile-preview`);
                }),
            ];

            const globalWsm = global.workspace_manager;

            this._workspaceManagerSignals = [
                globalWsm.connect("showing-desktop-changed", () => {
                    this.hideWindowBorders();
                    Logger.debug(`workspace:showing-desktop-changed`);
                }),
                globalWsm.connect("workspace-added", (_, wsIndex) => {
                    let added = this._tree.addWorkspace(wsIndex);
                    Logger.debug(`${added ? "workspace-added" : "workspace-add-skipped"} ${wsIndex}`);
                }),
                globalWsm.connect("workspace-removed", (_, wsIndex) => {
                    let removed = this._tree.removeWorkspace(wsIndex);
                    Logger.debug(`${removed ? "workspace-removed" : "workspace-remove-skipped"} ${wsIndex}`);
                }),
                globalWsm.connect("workspace-switched", (_, _wsIndex) => {
                    this.hideWindowBorders();
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                        this.showBorderFocusWindow();
                    });
                    Logger.debug(`workspace-switched`);
                }),
            ];

            let numberOfWorkspaces = globalWsm.get_n_workspaces();

            for (let i = 0; i < numberOfWorkspaces; i++) {
                let workspace = globalWsm.get_workspace_by_index(i);
                this._bindWorkspaceSignals(workspace);
            }

            this._signalsBound = true;
        }

        _bindWorkspaceSignals(metaWorkspace) {
            if (metaWorkspace) {
                if (!metaWorkspace.workspaceSignals) {
                    let workspaceSignals = [
                        metaWorkspace.connect("window-added", (_, metaWindow) => {
                            this._updateMetaWorkspaceMonitor(global.display, metaWindow.get_monitor(), metaWindow);
                            Logger.debug(`workspace:window-added ${metaWindow.get_wm_class()}`);
                        }),
                    ];
                    metaWorkspace.workspaceSignals = workspaceSignals;
                }
            }
        }

        command(action) {
            let focusWindow = this.focusMetaWindow;

            switch(action.name) {
                case "MoveResize":
                    // TODO validate the parameters for MoveResize
                    
                    this._applyNodeWindowMode(action, focusWindow)

                    let moveRect = {
                        x: Utils.resolveX(action, focusWindow),
                        y: Utils.resolveY(action, focusWindow),
                        width: Utils.resolveWidth(action, focusWindow),
                        height: Utils.resolveHeight(action, focusWindow),
                    };
                    this.move(focusWindow, moveRect);
                    this.renderTree("move-resize");
                    break;
                default:
                    break;
            }
        }

        disable() {
            this._removeSignals();
            this.disabled = true;
            Logger.debug(`extension:disable`);
        }

        enable() {
            this._bindSignals();
            this._reloadTree("enable");
            Logger.debug(`extension:enable`);
        }

        _findNodeWindow(metaWindow) {
            let nodeWindow;
            let tree = this._tree;
            nodeWindow = tree.findNode(metaWindow);
            if (nodeWindow) return nodeWindow;
        }

        _findTreeForMetaWindow(metaWindow) {
            let tree = this._tree;
            let nodeWindow = tree.findNode(metaWindow);
            if (nodeWindow) return tree;
        }

        get focusMetaWindow() {
            return global.display.get_focus_window();
        }

        get focusNodeWindow() {
            return this._findNodeWindow(this.focusMetaWindow);
        }

        get windowsActiveWorkspace() {
            let wsManager = global.workspace_manager;
            return global.display.get_tab_list(Meta.TabList.NORMAL_ALL,
                wsManager.get_active_workspace());
        }

        get windowsAllWorkspaces() {
            let wsManager = global.workspace_manager;
            let windowsAll = [];

            for (let i = 0; i < wsManager.get_n_workspaces(); i++) {
                Array.prototype.push.apply(windowsAll, global.display.
                    get_tab_list(Meta.TabList.NORMAL_ALL, wsManager.get_workspace_by_index(i)));
            }
            Logger.debug(`open-windows: ${windowsAll.length}`);
            windowsAll.sort((w1, w2) => {
                return w1.get_stable_sequence() - w2.get_stable_sequence();
            });
            return windowsAll;
        }

        hideWindowBorders() {
            this._tree.nodeWindows.forEach((nodeWindow) => {
                if (nodeWindow._actor && nodeWindow._actor.border) {
                    nodeWindow._actor.border.hide();
                }
            });
        }

        // Window movement API
        move(metaWindow, rect) {
            if (!metaWindow) return;
            if (metaWindow.grabbed) return;
            metaWindow.unmaximize(Meta.MaximizeFlags.HORIZONTAL);
            metaWindow.unmaximize(Meta.MaximizeFlags.VERTICAL);
            metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);

            let windowActor = metaWindow.get_compositor_private();
            if (!windowActor) return;
            windowActor.remove_all_transitions();

            metaWindow.move_frame(true, rect.x, rect.y);
            metaWindow.move_resize_frame(true, 
                rect.x,
                rect.y,
                rect.width,
                rect.height
            );
        };

        _removeSignals() {
            if (!this._signalsBound)
                return;

            if (this._displaySignals) {
                for (const displaySignal of this._displaySignals) {
                    global.display.disconnect(displaySignal);
                }
                this._displaySignals.length = 0;
                this._displaySignals = undefined;
            }

            if (this._windowManagerSignals) {
                for (const windowManagerSignal of this._windowManagerSignals) {
                    global.window_manager.disconnect(windowManagerSignal);
                }
                this._windowManagerSignals.length = 0;
                this._windowManagerSignals = undefined;
            }

            const globalWsm = global.workspace_manager;

            if (this._workspaceManagerSignals) {
                for (const workspaceManagerSignal of this._workspaceManagerSignals) {
                    globalWsm.disconnect(workspaceManagerSignal);
                }
                this._workspaceManagerSignals.length = 0;
                this._workspaceManagerSignals = undefined;
            }

            let numberOfWorkspaces = globalWsm.get_n_workspaces();

            for (let i = 0; i < numberOfWorkspaces; i++) {
                let workspace = globalWsm.get_workspace_by_index(i);
                if (workspace.workspaceSignals) {
                    for (const workspaceSignal of workspace.workspaceSignals) {
                        workspace.disconnect(workspaceSignal);
                    }
                    workspace.workspaceSignals.length = 0;
                    workspace.workspaceSignals = undefined;
                }
            }

            let allWindows = this.windowsAllWorkspaces;

            if (allWindows) {
                for (let metaWindow of allWindows) {
                    if (metaWindow.windowSignals !== undefined) {
                        for (const windowSignal of metaWindow.windowSignals) {
                            metaWindow.disconnect(windowSignal);
                        }
                        metaWindow.windowSignals.length = 0;
                        metaWindow.windowSignals = undefined;
                    }

                    let windowActor = metaWindow.get_compositor_private();
                    if (windowActor && windowActor.actorSignals) {
                        for (const actorSignal of windowActor.actorSignals) {
                            windowActor.disconnect(actorSignal);
                        }
                        windowActor.actorSignals.length = 0;
                        windowActor.actorSignals = undefined;
                    }

                    if (windowActor && windowActor.border) {
                        windowActor.border.hide();
                        if (global.window_group) {
                            global.window_group.remove_child(windowActor.border);
                        }
                        windowActor.border = undefined;
                    }
                }
            }

            this._signalsBound = false;
        }

        renderTree(from) {
            if (this._freezeRender) {
                Logger.debug(`render frozen`);
                return;
            }
            GLib.idle_add(GLib.PRIORITY_LOW, () => {
                this._tree.render(from);
            });
        }

        _reloadTree(from) {
            GLib.idle_add(GLib.PRIORITY_LOW, () => {
                let treeWorkspaces = this._tree.nodeWorkpaces;
                let wsManager = global.workspace_manager;
                let globalWsNum = wsManager.get_n_workspaces();
                Logger.debug(`tree-workspaces: ${treeWorkspaces.length}, global-workspaces: ${globalWsNum}`);
                this._tree._root._nodes.length = 0;
                this._tree._initWorkspaces();
                this.trackCurrentWindows();

                for (let i = 0; i < this._tree.nodeWorkpaces.length; i++) {
                    let existingWsNode = this._tree.nodeWorkpaces[i];
                    let monitors = existingWsNode._nodes;
                    Logger.debug(`  ${existingWsNode._data}`);
                    for (let m = 0; m < monitors.length; m++) {
                        let windows  = monitors[m]._nodes;
                        for (let w = 0; w < windows.length; w++) {
                            if (w && w._data)
                                this._updateMetaWorkspaceMonitor(global.display, w._data.get_monitor(), w._data);
                        }
                    }
                }
                this.showBorderFocusWindow();
                Logger.debug(`windowmgr:reload-tree ${from ? "from " + from : ""}`);
                this.renderTree("reload-tree");
            });
        }

        showBorderFocusWindow() {
            this.hideWindowBorders();
            let metaWindow = this.focusMetaWindow;
            if (!metaWindow) return;
            let windowActor = metaWindow.get_compositor_private();
            if (windowActor && windowActor.border) {
                let rect = metaWindow.get_frame_rect();
                windowActor.border.set_size(rect.width, rect.height);
                windowActor.border.set_position(rect.x, rect.y);
                if (metaWindow.appears_focused && !metaWindow.minimized)
                    windowActor.border.show();
                if (global.window_group && global.window_group.contains(windowActor.border)) {
                    global.window_group.remove_child(windowActor.border);
                    global.window_group.add_child(windowActor.border);
                }
            }
            Logger.debug(`show-border-focus-window`);
        }

        _trackWindow(_display, metaWindow) {
            // Make window types configurable
            if (this._validWindow(metaWindow)) {
                let existNodeWindow = this._tree.findNode(metaWindow);
                if (!existNodeWindow) {
                    let metaMonWs = `mo${metaWindow.get_monitor()}ws${metaWindow.get_workspace().index()}`;
                    let monitorNode = this._tree.findNode(metaMonWs);
                    if (!monitorNode) return;
                    let newNodeWindow = this._tree.addNode(monitorNode._data, Tree.NODE_TYPES['WINDOW'], 
                        metaWindow);
                    // default to tile mode
                    newNodeWindow.mode = WINDOW_MODES['TILE'];
                }

                let windowActor = metaWindow.get_compositor_private();

                if (!metaWindow.windowSignals) {
                    let windowSignals = [
                        metaWindow.connect("position-changed", this._updateMetaPositionSize.bind(this)),
                        metaWindow.connect("size-changed", this._updateMetaPositionSize.bind(this)),
                        metaWindow.connect("focus", (_metaWindowFocus) => {
                            this.showBorderFocusWindow();
                        }),
                        metaWindow.connect("workspace-changed", (metaWindowWs) => {
                            Logger.debug(`workspace-changed ${metaWindowWs.get_wm_class()}`);
                        }),
                    ];
                    metaWindow.windowSignals = windowSignals;
                    Logger.debug(`track-window:binding-metawindow-signal`);
                }

                if (!windowActor.actorSignals) {
                    let actorSignals = [
                        windowActor.connect("destroy", this._windowDestroy.bind(this)),
                    ];
                    windowActor.actorSignals = actorSignals;
                    Logger.debug(`track-window:binding-actor-signal`);
                }

                if (!windowActor.border) {
                    let border = new St.Bin({style_class: "window-clone-border"});

                    if (global.window_group)
                        global.window_group.add_child(border);

                    windowActor.border = border;
                    border.show();
                    Logger.debug(`track-window:create-border`);
                }

                Logger.debug(`window tracked: ${metaWindow.get_wm_class()}`);
                Logger.debug(` on workspace: ${metaWindow.get_workspace().index()}`);
                Logger.debug(` on monitor: ${metaWindow.get_monitor()}`);
            } 
        }

        trackCurrentWindows() {
            let windowsAll = this.windowsAllWorkspaces;
            for (let i = 0; i < windowsAll.length; i++) {
                this._trackWindow(global.display, windowsAll[i]);
            }
            Logger.debug(`track-current-windows`);
        }

        _validWindow(metaWindow) {
            return metaWindow.get_window_type() == Meta.WindowType.NORMAL;
        }

        _windowDestroy(actor) {
            // Release any resources on the window
            let border = actor.border;
            if (border) {
                if (global.window_group) {
                    global.window_group.remove_child(border);
                    border = null;
                }
            }
            let nodeWindow;
            nodeWindow = this._tree.findNodeByActor(actor);
            if (nodeWindow) {
                this._tree.removeNode(nodeWindow._parent._data, nodeWindow);
                Logger.debug(`window destroyed ${nodeWindow._data.get_wm_class()}`);
                this.renderTree("window-destroy");
            }                
            Logger.debug(`window-destroy`);
        }

        _updateMetaWorkspaceMonitor(_, monitor, metaWindow) {
            if (this._validWindow(metaWindow)) {
                if (metaWindow.get_workspace() === null) return;
                let existNodeWindow = this._tree.findNode(metaWindow);
                let metaMonWs = `mo${metaWindow.get_monitor()}ws${metaWindow.get_workspace().index()}`; 
                let metaMonWsNode = this._tree.findNode(metaMonWs);
                if (existNodeWindow) {
                    // check if meta in correct ws and monitor
                    if (existNodeWindow._parent && metaMonWsNode) {
                        Logger.debug(`window-monitorWorkspace:${metaMonWs}`);
                        Logger.debug(`parent-monitorWorkspace:${existNodeWindow._parent._data}`);
                        if (existNodeWindow._parent._data !== metaMonWs) {
                            this._tree.removeNode(existNodeWindow._parent._data, existNodeWindow);
                            let movedNodeWindow = this._tree.addNode(metaMonWs, Tree.NODE_TYPES['WINDOW'], metaWindow);
                            movedNodeWindow.mode = existNodeWindow.mode;
                        }
                    }
                }
                Logger.debug(`window-entered-monitor: ${metaWindow.get_wm_class()}`);
                Logger.debug(` on workspace: ${metaWindow.get_workspace().index()}`);
                Logger.debug(` on monitor: ${monitor} `);
            }
            this.showBorderFocusWindow();
            this.renderTree("update-workspace-monitor");
        }

        _updateMetaPositionSize(metaWindowPos) {
            this.showBorderFocusWindow();

            let focusMetaWindow = this.focusMetaWindow;
            if (focusMetaWindow && focusMetaWindow.get_maximized() === 0) {
                this.renderTree("position-size-changed");
            }

            Logger.debug(`position-size-changed ${metaWindowPos.get_wm_class()}`);
        }

        freezeRender() {
            this._freezeRender = true;
        }

        unfreezeRender() {
            this._freezeRender = false;
        }
    }
);
