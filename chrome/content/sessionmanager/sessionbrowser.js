/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is the nsSessionStore component.
 *
 * The Initial Developer of the Original Code is
 * Simon Bünzli <zeniko@gmail.com>
 * Portions created by the Initial Developer are Copyright (C) 2008
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 * Morac <morac99-firefox@yahoo.com> - Modified for use with Session Manager
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

// Create a namespace so as not to polute the global namespace
if(!com) var com={};
if(!com.morac) com.morac={};

Components.utils.import("resource://sessionmanager/modules/session_manager.jsm");

const Cc = Components.classes;
const Ci = Components.interfaces;

// use the namespace
with (com.morac) {
	com.morac.gSessionManagerSessionBrowser = {

		gTabTree: null,
		gWinLabel: null,
		gStateObject: null,
		gTreeData: null,
		gNoTabsChecked: false,
		gAllTabsChecked: true,
		gDeleting: false,
		gObserving: false,
		gSaving: false,

		gTimerId: null,
		gLastLoadedTab: null,
		
		aShowWindowSessions: false,
		
		updateData: null,

		onUnload_proxy: function(aEvent) {
			this.removeEventListener("unload", gSessionManagerSessionBrowser.onUnload_proxy, false);
			OBSERVER_SERVICE.removeObserver(gSessionManagerSessionBrowser, "sessionmanager:update-tab-tree");
		},
		
		// Used to update tree when session data changes
		observe: function(aSubject, aTopic, aData)
		{
			switch (aTopic)
			{
			case "sessionmanager:update-tab-tree":
				// Only update if saving and the tab tree box is not hidden
				if (this.gSaving && !gSessionManagerSessionPrompt.gTabTreeBox.hidden)
				{
					// since loads happen multiple times for the same page load, try and be smart and not update a bunch of times for the same load.
					// Anything within 200 ms is considered the same load so it restarts another timer for 200 ms.  This means that if loads keep happening with
					// a periodicity of less than 200 ms, the timer will never expire.  Loads where the favicon changes are considered unique loads. 
					// Also other events like tab closes or loads can result in the tree getting out of sync, though updateTree has some protective code to prevent that from happening.
					// Normally there are 2 loads per page, one for the page and one for the favicon.
					var timeout = 100;
					var data = aData.split(" ");
					if ((data[0] == "load") || (data[0] == "pageshow")) {
						timeout = 200;
						var id = aSubject.com.morac.gSessionManagerWindowObject.__SessionManagerWindowId + " " + data[1] + " " + data[2];
						// If timer already set for a load on thie tab, clear it and start the timer again.  This can result
						// in loads getting out of sync with other tab events since other events have a 0ms wait time.
						if (this.gTimerId && this.gLastLoadedTab == id) {
							clearTimeout(this.gTimerId);
							delete this.gTimerId;
						}
						this.gLastLoadedTab = id;
					} else this.gLastLoadedTab = null;
					
					// Give it a chance to update
					this.gTimerId = setTimeout(function() { 
						gSessionManagerSessionBrowser.updateData = { window: aSubject, data: aData };
						gSessionManagerSessionBrowser.initTreeView("", false, false, true, true); 
						gSessionManagerSessionBrowser.updateData.window = null;
						gSessionManagerSessionBrowser.updateData = null;
						gSessionManagerSessionBrowser.gLastLoadedTab = null;
						delete gSessionManagerSessionBrowser.gTimerId;
					}, timeout);
				}
				break;
			}
		},
		
		initTreeView: function(aFileName, aDeleting, aStartupPrompt, aSaving, aUpdate) {
		
			// Initialize common values
			if (!this.gTabTree) {
				this.gTabTree = document.getElementById("tabTree");
				this.gWinLabel = this.gTabTree.getAttribute("_window_label");
			}
			this.aShowWindowSessions = false;
		
			// If updating call updateTree function otherwise wipe out old tree data and repopulate it
			if (aUpdate) {
				this.updateTree();
			}
			else {
				var state = null, currentSession = false;
			
				// Save deleting and saving parameters
				this.gDeleting = aDeleting;
				this.gSaving = aSaving;

				this.gNoTabsChecked = false;
				this.gAllTabsChecked = true;
				this.treeView.initialize();
				
				// Watch for session changes
				if (aSaving && !this.gObserving) {
					window.addEventListener("unload", gSessionManagerSessionBrowser.onUnload_proxy, false);
					this.gObserving = true;
					OBSERVER_SERVICE.addObserver(gSessionManagerSessionBrowser, "sessionmanager:update-tab-tree", false);
				}

				// Force accept button to be disabled if not deleting
				if (!aDeleting) gSessionManagerSessionPrompt.isAcceptable(true);
				
				// If Saving show current session in tabs
				if (aSaving) {
					state = SessionStore.getBrowserState();
				}
				// if chose crashed session read from sessionstore.js instead of session file
				else if (aFileName == "*") {
					try {
						var file = gSessionManager.getProfileFile("sessionstore.js");
						// If file does not exist, try looking for SeaMonkey's sessionstore file
						if (!file.exists()) {
							file = gSessionManager.getProfileFile("sessionstore.json");
						}
						if (file.exists()) {
							state = gSessionManager.readFile(file);
						}
					}
					catch(ex) {}
					if (!state)
					{
						gSessionManager.ioError();
						return;
					}
					currentSession = true;
				}
				else {
					state = gSessionManager.readSessionFile(gSessionManager.getSessionDir(aFileName));
					if (!state)
					{
						gSessionManager.ioError();
						return;
					}

					if (!SESSION_REGEXP.test(state))
					{
						gSessionManager.sessionError();
						return;
					}
					state = state.split("\n")[4];
				}

				// Decrypt first, then evaluate
				state = gSessionManager.decrypt(state);
				if (!state) return;
				state = gSessionManager.JSON_decode(state);
				if (!state || state._JSON_decode_failed) return;

				// Save new state
				this.gStateObject = state;
				
				// Create or re-create the Tree
				this.aShowWindowSessions = currentSession || (aStartupPrompt && aFileName == BACKUP_SESSION_FILENAME);
				this.createTree();
				this.aShowWindowSessions = false;
			}
			
			// Update accept button
			gSessionManagerSessionPrompt.isAcceptable();
		},

		addWindowStateObjectToTree: function(aWinData, aIx) {
			var windowSessionName = null;
			if (this.aShowWindowSessions) {
				windowSessionName = (aWinData.extData) ? aWinData.extData["_sm_window_session_values"] : null;
				windowSessionName = (windowSessionName) ? (gSessionManager._string("window_session") + "   " + windowSessionName.split("\n")[0]) : null;
			}
			var winState = {
				label: this.gWinLabel.replace("%S", (aIx + 1)),
				open: true,
				checked: true,
				sessionName: windowSessionName,
				ix: aIx
			};
			winState.tabs = aWinData.tabs.map(function(aTabData) {
				return this.addTabStateObjectToTree(aTabData, winState);
			}, this);
			this.gTreeData.push(winState);
			for each (var tab in winState.tabs)
				this.gTreeData.push(tab);
		},
		
		addTabStateObjectToTree: function(aTabData, aWinParentState) {
			var entry = aTabData.entries[aTabData.index - 1] || { url: "about:blank" };
			var iconURL = aTabData.attributes && aTabData.attributes.image || null;
			// if no iconURL, look in pre Firefox 3.1 storage location
			if (!iconURL && aTabData.xultab) {
				iconURL = /image=(\S*)(\s)?/i.exec(aTabData.xultab);
				if (iconURL) iconURL = iconURL[1];
			}
			// Trying to display a favicon for an https with an invalid certificate will throw up an exception box, so don't do that
			// Firefox's about:sessionrestore also fails with authentication requests, but Session Manager seems okay with that so just
			// use the work around for https.
			if (/^https:/.test(iconURL))
				iconURL = "moz-anno:favicon:" + iconURL;
			return {
				label: entry.title || entry.url,
				url: entry.url,
				checked: true,
				src: iconURL,
				parent: aWinParentState
			};
		},
		
		createTree: function() {
			this.gStateObject.windows.forEach(this.addWindowStateObjectToTree, this);
			
			// Set tree display view if not already set, otherwise just update tree
			if (!this.treeView.treeBox) this.gTabTree.view = this.treeView;
			else {
				this.gTabTree.treeBoxObject.rowCountChanged(0, this.treeView.rowCount);
			}
			//preselect first row
			//this.gTabTree.view.selection.select(0);
		},
		
		// This is called any time there is an updated tab event or window event.  In all cases:
		//    - updateData.window contains window object that is opening or closing or that contains the tab.
		//    - data[0] contains a string of what happened (TabOpen, TabClose, TabMove, load (or pageshow), "WINDOW_OPEN" or "WINDOW_CLOSE")
		//    - data[1] contains the tab position for tabs or the extData.__SessionManagerWindowId window value for windows
		//    - data[2] contains the original tab position for TabMove.  It contains the favicon URL for load (or pageshow). It is undefined for all other events.
		updateTree: function() {
			dump("updateTree: " + this.updateData.data + "\n");
			var data = this.updateData.data.split(" ");
			var removing = (data[0] == "WINDOW_CLOSE") || (data[0] == "TabClose");
			var new_window_state = removing ? null : SessionStore.getWindowState(this.updateData.window);
			if (new_window_state) {
				new_window_state = gSessionManager.JSON_decode(new_window_state);
				if (!new_window_state || new_window_state._JSON_decode_failed) return;
			}

			// If window is opening add it's state to end of current state since open windows are added to the end of the session
			if (data[0] == "WINDOW_OPEN") {
				var row = this.treeView.rowCount;
				this.addWindowStateObjectToTree(new_window_state.windows[0], this.gStateObject.windows.length);
				this.gTabTree.treeBoxObject.rowCountChanged(row, new_window_state.windows[0].tabs.length + 1);
				this.gStateObject.windows.push(new_window_state.windows[0]);
				this.gStateObject.windows.selectedWindow = this.gStateObject.windows.length - 1;
			}
			else {
				var isWindow = (data[0] == "WINDOW_CLOSE");
				var adding = (data[0] == "TabOpen");
				var loading = (data[0] == "load") || (data[0] == "pageshow");
			
				var window_id = isWindow ? data[1] : SessionStore.getWindowValue(this.updateData.window,"__SessionManagerWindowId");
				var tab_position = !isWindow ? parseInt(data[1]) : null;
				var old_tab_position = parseInt(data[2]);
				var moving = !isNaN(old_tab_position) ? (tab_position - old_tab_position) : 0;
			
				// Look for closed window and remove it
				for (var i=0; i<this.gStateObject.windows.length; i++) {
					// find matching window in gStateObject
					if (this.gStateObject.windows[i].extData && (this.gStateObject.windows[i].extData.__SessionManagerWindowId == window_id)) {
						// find matching window in gTreeData
						for (var j=0; j<this.gTreeData.length; j++) {
							// if window found
							if (this.gTreeData[j].ix == i) {
								// sometimes when the last time was just closed, Firefox uses a tab position of 1.  This causes the following to throw an exception so adjust
								// the tab_position variable so it's valid.
								if (adding || loading) {
									if (this.gTreeData[j].tabs.length <= tab_position) tab_position = this.gTreeData[j].tabs.length - 1;
									if (tab_position < 0) tab_position = 0;
								}
								// Get tab tree state
								var tabData = (removing || moving) ? null : this.addTabStateObjectToTree(new_window_state.windows[0].tabs[tab_position], this.gTreeData[j]);
								var pos = isWindow ? j : (j + tab_position + 1);
								var windowOpen = this.treeView.isContainerOpen(j);
								if (loading && this.gTreeData[j].tabs.length > 0) {
									// Just update gTreeData for window object and if windowOpen update 
									// the gTreeData for the tab and invalidate the row
									this.gTreeData[j].tabs[tab_position].label = tabData.label;
									this.gTreeData[j].tabs[tab_position].url = tabData.url;
									this.gTreeData[j].tabs[tab_position].src = tabData.src;
									
									if (windowOpen) {
										this.gTreeData[pos].label = tabData.label;
										this.gTreeData[pos].url = tabData.url;
										this.gTreeData[pos].src = tabData.src;
										this.treeView.treeBox.invalidateRow(pos);
									}
								}
								else {
									// if loading with no tabs in gTreeData then we are in a bad state so treat it as an add and invalidate the whole tree to get things in sync
									if (loading) {
										adding = true;
										this.treeView.treeBox.invalidate();
									}

									// 1 row if window and not open or tab and open, 0 rows if tab and window collapse,
									// tab length if window and open or "moving" rows if moving or tab length if window and open.
									var rows = (((isWindow && !windowOpen) || (!isWindow && windowOpen)) && 1) || 
									           (isWindow && (this.gTreeData[j].tabs.length + 1)) || 0;
											   
									// if add/removing tab, add/remove it from the gTreeData window's tab value
									// if moving tab, splice back in removed tab
									if (!isWindow) {
										if (tabData) this.gTreeData[j].tabs.splice(tab_position, 0, tabData);
										else {
											var splicedTab = this.gTreeData[j].tabs.splice(tab_position - moving, 1);
											if (moving) this.gTreeData[j].tabs.splice(tab_position, 0, splicedTab[0]);
										}
									}
									
									if (rows > 0) {
										// reindex remaining windows if removing window
										if (isWindow) {
											for (var k=pos+rows; k<this.gTreeData.length; k++) {
												if (this.treeView.isContainer(k)) this.gTreeData[k].ix--;
											}
										}
										
										// add/remove tab or remove window and its tabs and update the tree
										if (tabData) this.gTreeData.splice(pos, 0, tabData);
										else {
											var splicedTab = this.gTreeData.splice(pos - moving, rows);
											if (moving) this.gTreeData.splice(pos, 0, splicedTab[0]);
										}
										
										if (moving) {
											var start = (moving > 0) ? (pos - moving) : pos;
											var end = (moving > 0) ? pos : (pos - moving);
											this.treeView.treeBox.invalidateRange(start, end);
										}
										else this.gTabTree.treeBoxObject.rowCountChanged(pos, adding ? rows : -rows);
									}
								}
								break;
							}
						}
						
						switch(data[0]) {
							// If closing window or tab, need to delete it from gStateObject
							// If changing tabs, simply replace the old window state with the new one to make things simpler
							case "WINDOW_CLOSE":
								this.gStateObject.windows.splice(i, 1);
								break;
							case "TabClose":
								this.gStateObject.windows[i].tabs.splice(tab_position, 1);
								break;
							case "TabOpen":
							case "TabMove":
							case "load":
								this.gStateObject.windows[i] = new_window_state.windows[0];
								break;
						}
						break;
					}
				}
			}
		},
		
		// User actions

		storeSession: function(aSaving) {
			// If saving make sure we have the most up to date session data
			if (aSaving) this.gStateObject = gSessionManager.JSON_decode(SessionStore.getBrowserState());
		
			// remove all unselected tabs from the state before restoring it
			// remove all selected tabs from state when deleting
			var ix = this.gStateObject.windows.length - 1;
			for (var t = this.gTreeData.length - 1; t >= 0; t--) {
				if (this.treeView.isContainer(t)) {
					if (this.gTreeData[t].checked === 0)
						// this window will be restored or deleted partially
						this.gStateObject.windows[ix].tabs = (this.gDeleting) ?
							this.gStateObject.windows[ix].tabs.filter(function(aTabData, aIx) !gSessionManagerSessionBrowser.gTreeData[t].tabs[aIx].checked) :
							this.gStateObject.windows[ix].tabs.filter(function(aTabData, aIx) gSessionManagerSessionBrowser.gTreeData[t].tabs[aIx].checked);
					else if (!this.gTreeData[t].checked && !this.gDeleting)
						// this window won't be restored at all
						this.gStateObject.windows.splice(ix, 1);
					else if (this.gTreeData[t].checked && this.gDeleting)
						// this window will be deleted
						this.gStateObject.windows.splice(ix, 1);
					ix--;
				}
			}
			return gSessionManager.JSON_encode(this.gStateObject);
		},

		onTabTreeClick: function(aEvent) {
			// don't react to right-clicks
			if (aEvent.button == 2)
				return;

			var row = {}, col = {};
			this.treeView.treeBox.getCellAt(aEvent.clientX, aEvent.clientY, row, col, {});
			if (col.value) {
				// restore this specific tab in the same window for middle-clicking
				// or Ctrl+clicking or Meta+clicking on a tab's title
				if (!this.gDeleting && (aEvent.button == 1 || aEvent.ctrlKey || aEvent.metaKey) && ((col.value.id == "title") || (col.value.id == "location"))) {
					if (this.treeView.isContainer(row.value))
						this.restoreSingleWindow(row.value);
					else
						this.restoreSingleTab(row.value, aEvent.shiftKey);
				}
				else if (col.value.id == "restore")
					this.toggleRowChecked(row.value);
				else if (!this.treeView.isContainer(row.value))
					this.populateSessionNameFromTabLabel(row.value);
			}
		},

		onTabTreeKeyDown: function(aEvent) {
			switch (aEvent.keyCode)
			{
			case KeyEvent.DOM_VK_SPACE:
				this.toggleRowChecked(this.gTabTree.currentIndex);
				break;
			case KeyEvent.DOM_VK_RETURN:
				var ix = this.gTabTree.currentIndex;
				if (aEvent.ctrlKey) {
					if (this.treeView.isContainer(ix))
						this.restoreSingleWindow(ix);
					else
						this.restoreSingleTab(ix, aEvent.shiftKey);
				}
				else if (!this.treeView.isContainer(ix)) {
					this.populateSessionNameFromTabLabel(ix);
				}
				// Don't submit if hit enter on tab tree
				aEvent.preventDefault();
				break;
			case KeyEvent.DOM_VK_UP:
			case KeyEvent.DOM_VK_DOWN:
			case KeyEvent.DOM_VK_PAGE_UP:
			case KeyEvent.DOM_VK_PAGE_DOWN:
			case KeyEvent.DOM_VK_HOME:
			case KeyEvent.DOM_VK_END:
				aEvent.preventDefault(); // else the page scrolls unwantedly
			break;
			}
		},

		// Helper functions

		getBrowserWindow: function() {
			let win = null;
			if (window.opener) {
				// This will throw if opening window has been closed, so catch it
				try {
					win = window.opener.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIWebNavigation)
									   .QueryInterface(Ci.nsIDocShellTreeItem).rootTreeItem
									   .QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindow);
				}
				catch(ex) {}
			}
			return win;
		},

		toggleRowChecked: function(aIx) {
			var item = this.gTreeData[aIx];
			item.checked = !item.checked;
			this.treeView.treeBox.invalidateRow(aIx);

			function isChecked(aItem) aItem.checked;

			if (this.treeView.isContainer(aIx)) {
				// (un)check all tabs of this window as well
				for each (var tab in item.tabs) {
					tab.checked = item.checked;
					this.treeView.treeBox.invalidateRow(this.gTreeData.indexOf(tab));
				}
			}
			else {
				// update the window's checkmark as well (0 means "partially checked")
				item.parent.checked = item.parent.tabs.every(isChecked) ? true :
										item.parent.tabs.some(isChecked) ? 0 : false;
				this.treeView.treeBox.invalidateRow(this.gTreeData.indexOf(item.parent));
			}

			this.gAllTabsChecked = this.gTreeData.every(isChecked);
			gSessionManagerSessionPrompt.gAcceptButton.disabled = this.gNoTabsChecked = !this.gTreeData.some(isChecked);
			if (this.gSaving) gSessionManagerSessionPrompt.isAcceptable();
		},

		tabTreeSelect: function(aType) {

			function isChecked(aItem) { return aItem.checked; }

			for each (var item in this.gTreeData) {
				// only act on window items
				if (item.tabs) {
					// if toggling and 0 ("partially checked") remain 0, otherwise toggle.  If not toggling just set/clear.
					var check = (aType == "TOGGLE") ? ((item.checked === 0) ? 0 : !item.checked) : (aType == "ALL");
					item.checked = check;
					for each (var tab in item.tabs) {
						tab.checked = (aType == "TOGGLE") ? !tab.checked : check;
					}
				}
			}
			this.gAllTabsChecked = this.gTreeData.every(isChecked);
			gSessionManagerSessionPrompt.gAcceptButton.disabled = this.gNoTabsChecked = !this.gTreeData.some(isChecked);
			if (this.gSaving) gSessionManagerSessionPrompt.isAcceptable();

			// update the whole tree view
			this.treeView.treeBox.invalidate();
		},

		restoreSingleWindow: function(aIx) {
			// only allow this is there is an existing window open.  Basically if it's not a prompt at browser startup.
			var win = this.getBrowserWindow();

			// If haven't opened any windows yet (startup or crash prompt), don't allow opening a new window
			let useWindow = false;
			if (!win) {
				if (gSessionManager.isRunning()) {
					win = gSessionManager.getMostRecentWindow("navigator:browser");
					if (!win) {
						useWindow = true;
					}
				}
				else return;
			}

			// gSingleWindowMode is set if Tab Mix Plus's single window mode is enabled
			var TMP_SingleWindowMode = !useWindow && typeof(win.gSingleWindowMode) != "undefined" && win.gSingleWindowMode;

			var item = this.gTreeData[aIx];
			var winState = { windows : new Array(1) };
			winState.windows[0] = this.gStateObject.windows[item.ix];

			// if Tab Mix Plus's single window mode is enabled and there is an existing window restores all tabs in that window
			gSessionManager.restoreSession(TMP_SingleWindowMode && win, gSessionManager.JSON_encode(winState), !TMP_SingleWindowMode, 
										   gSessionManager.mPref_save_closed_tabs < 2, useWindow, TMP_SingleWindowMode, true);

			// bring current window back into focus
			setTimeout(function() { window.focus(); }, 1000);
		},

		restoreSingleTab: function(aIx, aShifted) {
			var win = this.getBrowserWindow() || gSessionManager.getMostRecentWindow("navigator:browser");
			if (!win) return;
			var tabbrowser = win.gBrowser;
			var newTab = tabbrowser.addTab();
			var item = this.gTreeData[aIx];

			var tabState = this.gStateObject.windows[item.parent.ix].tabs[aIx - this.gTreeData.indexOf(item.parent) - 1];
			SessionStore.setTabState(newTab, gSessionManager.JSON_encode(tabState));

			// respect the preference as to whether to select the tab (the Shift key inverses)
			var prefBranch = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
			if (prefBranch.getBoolPref("browser.tabs.loadInBackground") != !aShifted)
				tabbrowser.selectedTab = newTab;
		},
		
		populateSessionNameFromTabLabel: function(aIx) {
			var name = gSessionManager.getFormattedName(this.gTreeData[aIx].label, new Date());
			if (name) gSessionManagerSessionPrompt.populateDefaultSessionName(name, true);
		},

		// Tree controller

		treeView: {
			_atoms: {},
			_getAtom: function(aName)
			{
				if (!this._atoms[aName]) {
					var as = Cc["@mozilla.org/atom-service;1"].getService(Ci.nsIAtomService);
					this._atoms[aName] = as.getAtom(aName);
				}
				return this._atoms[aName];
			},

			treeBox: null,
			selection: null,

			get rowCount()                     { return gSessionManagerSessionBrowser.gTreeData.length; },
			setTree: function(treeBox)         { this.treeBox = treeBox; },
			getCellText: function(idx, column) { 
			if (column.id == "location") {
					if (gSessionManagerSessionBrowser.gTreeData[idx].sessionName) return gSessionManagerSessionBrowser.gTreeData[idx].sessionName;
					return gSessionManagerSessionBrowser.gTreeData[idx].url ? gSessionManagerSessionBrowser.gTreeData[idx].url : "";
				}
				else return gSessionManagerSessionBrowser.gTreeData[idx].label; 
			},
			isContainer: function(idx)         { return "open" in gSessionManagerSessionBrowser.gTreeData[idx]; },
			getCellValue: function(idx, column){ 
				if (this.isContainer(idx) && ((column.id == "title") || (column.id == "location"))) 
					return gSessionManagerSessionBrowser.gTreeData[idx].sessionName;
				else 
					return gSessionManagerSessionBrowser.gTreeData[idx].checked;
			},
			isContainerOpen: function(idx)     { return gSessionManagerSessionBrowser.gTreeData[idx].open; },
			isContainerEmpty: function(idx)    { return false; },
			isSeparator: function(idx)         { return false; },
			isSorted: function()               { return false; },
			isEditable: function(idx, column)  { return false; },
			getLevel: function(idx)            { return this.isContainer(idx) ? 0 : 1; },

			getParentIndex: function(idx) {
				if (!this.isContainer(idx))
					for (var t = idx - 1; t >= 0 ; t--)
						if (this.isContainer(t))
							return t;
				return -1;
			},

			hasNextSibling: function(idx, after) {
				var thisLevel = this.getLevel(idx);
				for (var t = after + 1; t < gSessionManagerSessionBrowser.gTreeData.length; t++)
					if (this.getLevel(t) <= thisLevel)
						return this.getLevel(t) == thisLevel;
				return false;
			},

			toggleOpenState: function(idx) {
				if (!this.isContainer(idx))
					return;
				var item = gSessionManagerSessionBrowser.gTreeData[idx];
				if (item.open) {
					// remove this window's tab rows from the view
					var thisLevel = this.getLevel(idx);
					for (var t = idx + 1; t < gSessionManagerSessionBrowser.gTreeData.length && this.getLevel(t) > thisLevel; t++);
					var deletecount = t - idx - 1;
					gSessionManagerSessionBrowser.gTreeData.splice(idx + 1, deletecount);
					this.treeBox.rowCountChanged(idx + 1, -deletecount);
				}
				else {
					// add this window's tab rows to the view
					var toinsert = gSessionManagerSessionBrowser.gTreeData[idx].tabs;
					for (var i = 0; i < toinsert.length; i++)
						gSessionManagerSessionBrowser.gTreeData.splice(idx + i + 1, 0, toinsert[i]);
					this.treeBox.rowCountChanged(idx + 1, toinsert.length);
				}
				item.open = !item.open;
				this.treeBox.invalidateRow(idx);
			},

			getCellProperties: function(idx, column, prop) {
				if (column.id == "restore" && this.isContainer(idx) && gSessionManagerSessionBrowser.gTreeData[idx].checked === 0)
					prop.AppendElement(this._getAtom("partial"));
				if (column.id == "title") 
					prop.AppendElement(this._getAtom(this.getImageSrc(idx, column) ? "icon" : "noicon"));
				if (this.isContainer(idx) && ((column.id == "title") || (column.id == "location")) && this.getCellValue(idx, column))
					prop.AppendElement(this._getAtom("sessionName"));
			},

			getRowProperties: function(idx, prop) {},

			getImageSrc: function(idx, column) {
				if (column.id == "title")
					return gSessionManagerSessionBrowser.gTreeData[idx].src || null;
				return null;
			},

			initialize: function() {
				var count;
				if (gSessionManagerSessionBrowser.gTreeData) count = this.rowCount;
				delete gSessionManagerSessionBrowser.gTreeData;
				gSessionManagerSessionBrowser.gTreeData = [];
				if (this.treeBox && count)
					this.treeBox.rowCountChanged(0, -count);
			},

			getProgressMode : function(idx, column) { },
			cycleHeader: function(column) { },
			cycleCell: function(idx, column) { },
			selectionChanged: function() { },
			performAction: function(action) { },
			performActionOnCell: function(action, index, column) { },
			getColumnProperties: function(column, prop) { }
		}
	}
}