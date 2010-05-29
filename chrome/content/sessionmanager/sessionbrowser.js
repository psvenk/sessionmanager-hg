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

		gStateObject: null,
		gTreeData: null,
		gNoTabsChecked: false,
		gAllTabsChecked: true,
		gDeleting: false,
		gObserving: false,
		gSaving: false,
		gTimerId: null,

		onUnload_proxy: function(aEvent) {
			this.removeEventListener("load", gSessionManagerSessionBrowser.onUnload_proxy, false);
			OBSERVER_SERVICE.removeObserver(gSessionManagerSessionBrowser, "sessionmanager:update-tab-tree");
		},
		
		// Used to update tree when session data changes
		observe: function(aSubject, aTopic, aData)
		{
			switch (aTopic)
			{
			case "sessionmanager:update-tab-tree":
				// Only update if the tab tree box is not hidden
				if (!gSessionManagerSessionPrompt.gTabTreeBox.hidden)
				{
					if (this.gTimerId) {
						clearTimeout(this.gTimerId);
						delete this.gTimerId;
					}
					this.gTimerId = setTimeout(function() { gSessionManagerSessionBrowser.initTreeView("", false, false, true); }, 100);
				}
				break;
			}
		},
		
		initTreeView: function(aFileName, aDeleting, aStartupPrompt, aSaving) {
		  // Save deleting and saving parameters
		  this.gDeleting = aDeleting;
		  this.gSaving = aSaving;

		  // Initialize tree data to default state
		  this.gNoTabsChecked = false;
		  this.gAllTabsChecked = true;
		  this.treeView.initialize();
		  
		  var state = null, currentSession = false;
		  
		  // Watch for session changes
		  if (aSaving && !this.gObserving) {
		    window.addEventListener("unload", gSessionManagerSessionBrowser.onUnload_proxy, false);
			this.gObserving = true;
			OBSERVER_SERVICE.addObserver(gSessionManagerSessionBrowser, "sessionmanager:update-tab-tree", false);
		  }

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

		  var tabTree = document.getElementById("tabTree");
		  var winLabel = tabTree.getAttribute("_window_label");

		  // Decrypt first, then evaluate
		  state = gSessionManager.decrypt(state);
		  if (!state) return;
		  this.gStateObject = gSessionManager.JSON_decode(state);
		  if (!this.gStateObject) return;
		  
		  this.gStateObject.windows.forEach(function(aWinData, aIx) {
			var windowSessionName = null;
			if (currentSession || (aStartupPrompt && aFileName == BACKUP_SESSION_FILENAME)) {
			  windowSessionName = (aWinData.extData) ? aWinData.extData["_sm_window_session_values"] : null;
			  windowSessionName = (windowSessionName) ? (gSessionManager._string("window_session") + "   " + windowSessionName.split("\n")[0]) : null;
			}
			var winState = {
			  label: winLabel.replace("%S", (aIx + 1)),
			  open: true,
			  checked: true,
			  sessionName: windowSessionName,
			  ix: aIx
			};
			winState.tabs = aWinData.tabs.map(function(aTabData) {
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
				parent: winState
			  };
			});
			this.gTreeData.push(winState);
			for each (var tab in winState.tabs)
			  this.gTreeData.push(tab);
		  }, this);
		  
		  this.gNoTabsChecked = false;
		  this.gAllTabsChecked = true;  
		  
		  tabTree.view = this.treeView;
		  //tabTree.view.selection.select(0);
		},

		// User actions

		storeSession: function() {
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
		  }
		},

		onTabTreeKeyDown: function(aEvent) {
		  switch (aEvent.keyCode)
		  {
		  case KeyEvent.DOM_VK_SPACE:
			this.toggleRowChecked(document.getElementById("tabTree").currentIndex);
			break;
		  case KeyEvent.DOM_VK_RETURN:
			var ix = document.getElementById("tabTree").currentIndex;
			if (aEvent.ctrlKey) {
			  if (this.treeView.isContainer(ix))
				this.restoreSingleWindow(ix);
			  else
				this.restoreSingleTab(ix, aEvent.shiftKey);
			}
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
		  
		  var ss = Cc["@mozilla.org/browser/sessionstore;1"].getService(Ci.nsISessionStore);
		  var tabState = this.gStateObject.windows[item.parent.ix]
									 .tabs[aIx - this.gTreeData.indexOf(item.parent) - 1];
		  ss.setTabState(newTab, gSessionManager.JSON_encode(tabState));
		  
		  // respect the preference as to whether to select the tab (the Shift key inverses)
		  var prefBranch = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
		  if (prefBranch.getBoolPref("browser.tabs.loadInBackground") != !aShifted)
			tabbrowser.selectedTab = newTab;
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